import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { nanoid } from "nanoid";
import { PNG } from "pngjs";
import { storageGetSignedUrl, storagePut } from "./storage";
import { discardAnalysisManifest, expireAnalysisManifest, getAnalysisManifest, saveAnalysisManifest } from "./db";

export type AnalysisConfig = {
  maxFileSizeBytes: number;
  maxImagePixels: number;
  groupingMethod: "slic" | "watershed" | "felzenszwalb";
  segmentationStrategy: "slic" | "watershed" | "felzenszwalb";
  hierarchyMethod: "global_energy_merge_tree";
  maxAgglomerationIterations: number;
  mergeEnergyThreshold: number;
  mergeEnergyWeights: {
    distortion: number;
    rate: number;
    boundary: number;
    shape: number;
    complexity: number;
  };
  derivedCutTargetFractions: {
    region: number;
    composite: number;
    entity: number;
  };
  scaleLevels: number[];
  slicSegments: number;
  slicCompactness: number;
  minimumRegionPixels: number;
  maxInitialSegments?: number;
  runScaleConsistency: boolean;
  maxConsistencyPixels: number;
  crossScaleOverlapThreshold: number;
  labDeltaESigma: number;
  boundaryGradientPercentile: number;
  topology: "4-neighbour";
  graphK: number;
  edgeBarrierThreshold: number;
  maxEntityAreaFraction: number;
  complexityMergePenalty: number;
  reconstructionProfile: "fast" | "balanced" | "accurate";
  appearanceModelCandidates: Array<"constant" | "affine" | "quadratic">;
  modelPenalty: number;
  boundaryLeakagePenalty: number;
  residualEnabled: boolean;
  residualQuantization: number;
  residualBudgetBytes: number;
  rateDistortionLambda: number;
  compareSegmentationBaselines: boolean;
  runParameterSensitivity: boolean;
  sensitivityVariantLimit: number;
};

export type AnalysisArtifactUrls = {
  representationJson: string;
  featuresNpz: string;
  residualsNpz?: string;
  parameterSensitivity?: string;
  reconstructedPng: string;
  svg: string;
  overlays: Record<string, string>;
  reconstructions: Record<string, string>;
  errors: {
    absolutePixelError?: string;
    parametricError?: string;
    perRegionError?: string;
    residualEnergy?: string;
    byReconstruction?: Record<string, string>;
    [key: string]: string | Record<string, string> | undefined;
  };
};

export type AnalysisResult = {
  jobId: string;
  ownerId: string;
  representation: Record<string, unknown>;
  artifactUrls: AnalysisArtifactUrls;
  errorEvidence?: Record<string, { key: string; width: number; height: number }>;
};

export type AnalysisStageTiming = {
  stage: string;
  label: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
};

export type AdvancedEtaRange = {
  minimumRemainingMs: number;
  maximumRemainingMs: number;
  basis: "advanced_budget" | "observed_progress" | "sensitivity_variant";
};

export type AnalysisTimingSnapshot = {
  schema: "AnalysisTiming@1";
  totalElapsedMs: number;
  stages: AnalysisStageTiming[];
  advancedEta: AdvancedEtaRange | null;
};

export type AnalysisJobStatus = {
  jobId: string;
  ownerId: string;
  status: "queued" | "running" | "uploading" | "completed" | "failed" | "cancelled" | "expired";
  stage: string;
  percent: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  expiresAt: number;
  error: string | null;
  resultAvailable: boolean;
  timing?: AnalysisTimingSnapshot;
};

type AnalysisProgressEvent = Pick<AnalysisJobStatus, "status" | "stage" | "percent" | "message">;

export type CacheRetentionTelemetry = {
  scope: "process_local_aggregate";
  activeEntries: number;
  capacity: number;
  ttlMs: number;
  fillRatio: number;
  writes: number;
  lookups: number;
  hits: number;
  misses: number;
  hitRate: number;
  expiredEvictions: number;
  capacityEvictions: number;
  totalEvictions: number;
  processStartedAt: number;
  lastActivityAt: number | null;
};

const supportedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp"]);
const DEFAULT_RESULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RESULT_CACHE_CAPACITY = 100;
const DEFAULT_SUBMISSION_WINDOW_MS = 60 * 1000;
const DEFAULT_SUBMISSION_MAX_PER_WINDOW = 3;
const DEFAULT_MAX_INFLIGHT_ANALYSES = 2;
const DEFAULT_PROGRESS_TIMEOUT_MS = 45 * 1000;
const DEFAULT_PROCESS_TIMEOUT_MS = 120 * 1000;
const DEFAULT_SENSITIVITY_VARIANT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_MAX_ADVANCED_PROCESS_TIMEOUT_MS = 7 * 60 * 1000;
const ERROR_HEATMAP_REFERENCE_DELTA = 32;
const MAX_THRESHOLD_HEATMAPS = 96;
const decodedErrorEvidence = new Map<string, { width: number; height: number; values: Uint16Array }>();
const thresholdedHeatmapUrls = new Map<string, string>();
const activeProcesses = new Map<string, ReturnType<typeof spawn>>();
const cancelledJobIds = new Set<string>();

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function processTimeoutFor(config: Pick<AnalysisConfig, "runParameterSensitivity" | "sensitivityVariantLimit">) {
  const normalBudgetMs = positiveInteger(process.env.ANALYSIS_PROCESS_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS);
  if (!config.runParameterSensitivity) return normalBudgetMs;
  const variantCount = Math.max(0, Math.min(5, Math.floor(config.sensitivityVariantLimit)));
  const additionalPerVariantMs = positiveInteger(process.env.ANALYSIS_SENSITIVITY_VARIANT_TIMEOUT_MS, DEFAULT_SENSITIVITY_VARIANT_TIMEOUT_MS);
  const maximumAdvancedBudgetMs = positiveInteger(process.env.ANALYSIS_MAX_ADVANCED_PROCESS_TIMEOUT_MS, DEFAULT_MAX_ADVANCED_PROCESS_TIMEOUT_MS);
  return Math.min(maximumAdvancedBudgetMs, normalBudgetMs + variantCount * additionalPerVariantMs);
}

function processingLimitMessage(config: AnalysisConfig) {
  return config.runParameterSensitivity
    ? "The advanced sensitivity study exceeded its bounded processing time. You can retry the same analysis or run only the primary analysis."
    : "The analysis exceeded the processing limit. Please retry with the same image or a smaller image.";
}

const stageLabels: Record<string, string> = {
  queued: "Queued",
  validating_input: "Input validation",
  feature_extraction: "Feature extraction",
  segmentation: "Segmentation",
  merge_tree: "Energy merge tree",
  cross_scale: "Cross-scale correspondence",
  reconstruction: "Reconstruction",
  sensitivity: "Sensitivity study",
  serialization: "Representation export",
  analysis_complete: "Engine completion",
  uploading_artifacts: "Artifact upload",
  finalizing: "Finalization",
};

function stageLabel(stage: string) {
  return stageLabels[stage] ?? stage.replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function terminalStatus(status: AnalysisJobStatus["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "expired";
}

function clampInteger(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function advancedEtaFor(config: Pick<AnalysisConfig, "runParameterSensitivity" | "sensitivityVariantLimit"> | undefined, job: AnalysisJobStatus, now: number): AdvancedEtaRange | null {
  if (!config?.runParameterSensitivity || terminalStatus(job.status)) return null;
  const elapsedMs = Math.max(0, now - job.createdAt);
  const remainingBudgetMs = Math.max(0, processTimeoutFor(config) - elapsedMs);
  if (!remainingBudgetMs) return null;
  const variantBudgetMs = positiveInteger(process.env.ANALYSIS_SENSITIVITY_VARIANT_TIMEOUT_MS, DEFAULT_SENSITIVITY_VARIANT_TIMEOUT_MS);
  if (job.stage === "sensitivity") {
    const match = /variant\s+(\d+)\s+of\s+(\d+)/i.exec(job.message);
    const total = Math.max(1, Math.min(5, Number(match?.[2] ?? config.sensitivityVariantLimit)));
    const current = Math.max(1, Math.min(total, Number(match?.[1] ?? 1)));
    const projected = Math.min(remainingBudgetMs, Math.max(15_000, (total - current + 1) * variantBudgetMs));
    return { minimumRemainingMs: clampInteger(projected * 0.35, 5_000, remainingBudgetMs), maximumRemainingMs: clampInteger(projected, 5_000, remainingBudgetMs), basis: "sensitivity_variant" };
  }
  if (job.percent >= 10) {
    const projected = Math.min(remainingBudgetMs, Math.max(15_000, elapsedMs * ((100 - job.percent) / Math.max(job.percent, 1))));
    return { minimumRemainingMs: clampInteger(projected * 0.6, 5_000, remainingBudgetMs), maximumRemainingMs: clampInteger(projected * 1.45, 5_000, remainingBudgetMs), basis: "observed_progress" };
  }
  const conservative = Math.min(remainingBudgetMs, Math.max(30_000, variantBudgetMs * Math.max(1, config.sensitivityVariantLimit)));
  return { minimumRemainingMs: clampInteger(conservative * 0.3, 5_000, remainingBudgetMs), maximumRemainingMs: clampInteger(conservative, 5_000, remainingBudgetMs), basis: "advanced_budget" };
}

function completedJobSnapshot(job: AnalysisJobStatus, now: number): AnalysisJobStatus {
  const stages = (job.timing?.stages ?? []).map(entry => entry.endedAt === null ? { ...entry, endedAt: now, durationMs: Math.max(0, now - entry.startedAt) } : entry);
  return { ...job, status: "completed", stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", updatedAt: now, completedAt: now, expiresAt: now + DEFAULT_RESULT_TTL_MS, error: null, resultAvailable: true, timing: { schema: "AnalysisTiming@1", totalElapsedMs: Math.max(0, now - job.createdAt), stages, advancedEta: null } };
}

export class AnalysisAdmissionError extends Error {
  readonly code = "TOO_MANY_REQUESTS";
}

export class AnalysisCancelledError extends Error {
  readonly code = "CANCELLED";
}

export class AnalysisInputError extends Error {
  readonly code = "BAD_INPUT";
}

export class AnalysisEngineError extends Error {
  readonly code = "ENGINE_FAILURE";
  constructor(message = "The image analysis engine could not complete this input. Reduce segmentation detail or choose a smaller image and retry.") {
    super(message);
  }
}

export class AnalysisSubmissionAdmission {
  private readonly attempts = new Map<string, { windowStartedAt: number; count: number }>();
  private inFlight = 0;

  constructor(private readonly windowMs: number, private readonly maxPerWindow: number, private readonly maxInFlight: number) {}

  acquire(clientKey: string, now = Date.now()) {
    if (this.inFlight >= this.maxInFlight) throw new AnalysisAdmissionError("Analysis capacity is busy. Please retry shortly.");
    for (const [key, entry] of Array.from(this.attempts.entries())) if (now - entry.windowStartedAt >= this.windowMs) this.attempts.delete(key);
    const entry = this.attempts.get(clientKey);
    if (entry && entry.count >= this.maxPerWindow) throw new AnalysisAdmissionError("Analysis submission quota reached. Please wait before retrying.");
    this.attempts.set(clientKey, entry ? { ...entry, count: entry.count + 1 } : { windowStartedAt: now, count: 1 });
    this.inFlight += 1;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  telemetry() {
    return { inFlight: this.inFlight, trackedClients: this.attempts.size, windowMs: this.windowMs, maxPerWindow: this.maxPerWindow, maxInFlight: this.maxInFlight };
  }
}

export class AnalysisResultCache {
  private readonly results = new Map<string, { result: AnalysisResult; storedAt: number }>();
  private readonly processStartedAt = Date.now();
  private writes = 0;
  private lookups = 0;
  private hits = 0;
  private misses = 0;
  private expiredEvictions = 0;
  private capacityEvictions = 0;
  private lastActivityAt: number | null = null;

  constructor(private readonly ttlMs: number, private readonly capacity: number) {}

  remember(result: AnalysisResult, now = Date.now()) {
    this.purge(now);
    this.writes += 1;
    this.lastActivityAt = now;
    this.results.delete(result.jobId);
    this.results.set(result.jobId, { result, storedAt: now });
    while (this.results.size > this.capacity) {
      const oldest = this.results.keys().next().value as string | undefined;
      if (!oldest) break;
      this.results.delete(oldest);
      this.capacityEvictions += 1;
    }
  }

  get(jobId: string, now = Date.now()) {
    this.purge(now);
    this.lookups += 1;
    this.lastActivityAt = now;
    const result = this.results.get(jobId)?.result ?? null;
    if (result) this.hits += 1;
    else this.misses += 1;
    return result;
  }

  remove(jobId: string) {
    this.results.delete(jobId);
  }

  telemetry(now = Date.now()): CacheRetentionTelemetry {
    this.purge(now);
    const activeEntries = this.results.size;
    return {
      scope: "process_local_aggregate",
      activeEntries,
      capacity: this.capacity,
      ttlMs: this.ttlMs,
      fillRatio: this.capacity ? activeEntries / this.capacity : 0,
      writes: this.writes,
      lookups: this.lookups,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.lookups ? this.hits / this.lookups : 0,
      expiredEvictions: this.expiredEvictions,
      capacityEvictions: this.capacityEvictions,
      totalEvictions: this.expiredEvictions + this.capacityEvictions,
      processStartedAt: this.processStartedAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  private purge(now: number) {
    for (const [jobId, entry] of Array.from(this.results.entries())) {
      if (now - entry.storedAt >= this.ttlMs) {
        this.results.delete(jobId);
        this.expiredEvictions += 1;
      }
    }
  }
}

export class AnalysisJobStore {
  private readonly jobs = new Map<string, AnalysisJobStatus>();
  private readonly configs = new Map<string, Pick<AnalysisConfig, "runParameterSensitivity" | "sensitivityVariantLimit">>();

  constructor(private readonly ttlMs: number) {}

  create(jobId: string, ownerId: string, now = Date.now(), config?: Pick<AnalysisConfig, "runParameterSensitivity" | "sensitivityVariantLimit">) {
    this.purge(now);
    if (config) this.configs.set(jobId, config);
    const job: AnalysisJobStatus = { jobId, ownerId, status: "queued", stage: "queued", percent: 0, message: "Queued for secure server-side analysis.", createdAt: now, updatedAt: now, completedAt: null, expiresAt: now + this.ttlMs, error: null, resultAvailable: false, timing: { schema: "AnalysisTiming@1", totalElapsedMs: 0, stages: [{ stage: "queued", label: stageLabel("queued"), startedAt: now, endedAt: null, durationMs: 0 }], advancedEta: null } };
    this.jobs.set(jobId, job);
    return this.snapshot(job, now);
  }

  update(jobId: string, update: AnalysisProgressEvent, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return null;
    const existingStages = job.timing?.stages ?? [];
    const currentStage = existingStages.at(-1);
    const stages = currentStage?.stage === update.stage
      ? existingStages
      : [...this.closeOpenStages(existingStages, now), { stage: update.stage, label: stageLabel(update.stage), startedAt: now, endedAt: null, durationMs: 0 }];
    const next = { ...job, ...update, percent: Math.max(job.percent, Math.min(99, Math.round(update.percent))), updatedAt: now, timing: { schema: "AnalysisTiming@1" as const, totalElapsedMs: Math.max(0, now - job.createdAt), stages, advancedEta: null } };
    this.jobs.set(jobId, next);
    return this.snapshot(next, now);
  }

  complete(jobId: string, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === "completed") return this.snapshot(job, now);
    const next = this.completedSnapshot(job, now);
    this.jobs.set(jobId, next);
    return this.snapshot(next, now);
  }

  previewCompletion(jobId: string, now = Date.now()) {
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(this.completedSnapshot(job, now), now) : null;
  }

  fail(jobId: string, error: string, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const next = { ...job, status: "failed" as const, stage: "failed", message: "Analysis did not complete.", updatedAt: now, completedAt: now, error, resultAvailable: false, timing: { schema: "AnalysisTiming@1" as const, totalElapsedMs: Math.max(0, now - job.createdAt), stages: this.closeOpenStages(job.timing?.stages ?? [], now), advancedEta: null } };
    this.jobs.set(jobId, next);
    return this.snapshot(next, now);
  }

  cancel(jobId: string, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return null;
    const next = { ...job, status: "cancelled" as const, stage: "cancelled", message: "Analysis was cancelled before completion.", updatedAt: now, completedAt: now, error: null, resultAvailable: false, timing: { schema: "AnalysisTiming@1" as const, totalElapsedMs: Math.max(0, now - job.createdAt), stages: this.closeOpenStages(job.timing?.stages ?? [], now), advancedEta: null } };
    this.jobs.set(jobId, next);
    return this.snapshot(next, now);
  }

  get(jobId: string, now = Date.now()) {
    this.purge(now);
    const job = this.jobs.get(jobId);
    return job ? this.snapshot(job, now) : null;
  }

  remove(jobId: string) {
    this.jobs.delete(jobId);
    this.configs.delete(jobId);
  }

  private closeOpenStages(stages: AnalysisStageTiming[], now: number) {
    return stages.map(entry => entry.endedAt === null ? { ...entry, endedAt: now, durationMs: Math.max(0, now - entry.startedAt) } : entry);
  }

  private completedSnapshot(job: AnalysisJobStatus, now: number): AnalysisJobStatus {
    const snapshot = completedJobSnapshot(job, now);
    return { ...snapshot, expiresAt: now + this.ttlMs };
  }

  private snapshot(job: AnalysisJobStatus, now: number): AnalysisJobStatus {
    const stages = (job.timing?.stages ?? []).map(entry => ({ ...entry, durationMs: entry.endedAt === null ? Math.max(0, now - entry.startedAt) : entry.durationMs }));
    const timing: AnalysisTimingSnapshot = { schema: "AnalysisTiming@1", totalElapsedMs: Math.max(0, (job.completedAt ?? now) - job.createdAt), stages, advancedEta: advancedEtaFor(this.configs.get(job.jobId), job, now) };
    return { ...job, timing };
  }

  private purge(now: number) {
    for (const [jobId, job] of Array.from(this.jobs.entries())) if (job.completedAt !== null && now - job.completedAt >= this.ttlMs) this.remove(jobId);
  }
}

const activeResults = new AnalysisResultCache(
  positiveInteger(process.env.ANALYSIS_RESULT_TTL_MS, DEFAULT_RESULT_TTL_MS),
  positiveInteger(process.env.ANALYSIS_RESULT_CACHE_CAPACITY, DEFAULT_RESULT_CACHE_CAPACITY)
);

const activeJobs = new AnalysisJobStore(positiveInteger(process.env.ANALYSIS_RESULT_TTL_MS, DEFAULT_RESULT_TTL_MS));

const submissionAdmission = new AnalysisSubmissionAdmission(
  positiveInteger(process.env.ANALYSIS_SUBMISSION_WINDOW_MS, DEFAULT_SUBMISSION_WINDOW_MS),
  positiveInteger(process.env.ANALYSIS_SUBMISSION_MAX_PER_WINDOW, DEFAULT_SUBMISSION_MAX_PER_WINDOW),
  positiveInteger(process.env.ANALYSIS_MAX_INFLIGHT, DEFAULT_MAX_INFLIGHT_ANALYSES)
);

function safeName(fileName: string) {
  const extension = path.extname(fileName).toLowerCase().replace(".", "");
  if (!supportedExtensions.has(extension)) {
    throw new Error("Supported image formats are PNG, JPEG, and WebP.");
  }
  return extension === "jpg" ? "jpeg" : extension;
}

export function decodeBase64Image(dataBase64: string) {
  const normalized = dataBase64.trim();
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("The uploaded image payload is not valid base64.");
  }
  const data = Buffer.from(normalized, "base64");
  if (!data.length || data.toString("base64") !== normalized) throw new Error("The uploaded image payload is not valid base64.");
  return data;
}

export function validateImageSignature(data: Buffer, mimeType: string, extension: string) {
  const normalizedExtension = extension === "jpg" ? "jpeg" : extension;
  const expectedMime = normalizedExtension === "png" ? "image/png" : normalizedExtension === "jpeg" ? "image/jpeg" : "image/webp";
  const signatureMatches = mimeType === "image/png" ? data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : mimeType === "image/jpeg" ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff : mimeType === "image/webp" ? data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP" : false;
  if (mimeType !== expectedMime || !signatureMatches) throw new Error("The uploaded image filename, MIME type, and binary signature must agree.");
}

function preflightAnalysisInput(input: { fileName: string; mimeType: string; dataBase64: string; config: AnalysisConfig }) {
  if (!supportedMimeTypes.has(input.mimeType)) throw new AnalysisInputError("Supported image formats are PNG, JPEG, and WebP.");
  const extension = safeName(input.fileName);
  const data = decodeBase64Image(input.dataBase64);
  validateImageSignature(data, input.mimeType, extension);
  const hardLimit = Number(process.env.MAX_IMAGE_BYTES ?? 8 * 1024 * 1024);
  const allowedSize = Math.min(input.config.maxFileSizeBytes, hardLimit);
  if (data.byteLength > allowedSize) throw new AnalysisInputError(`The uploaded image exceeds the configured ${(allowedSize / 1024 / 1024).toFixed(1)} MB limit.`);
  return { data, extension };
}

function runPython(inputPath: string, outputPath: string, config: AnalysisConfig, onProgress?: (event: AnalysisProgressEvent) => void, jobId?: string) {
  const scriptPath = path.join(process.cwd(), "python_engine", "representation_engine.py");
  const python = process.env.PYTHON_EXECUTABLE ?? "python3";
  return new Promise<void>((resolve, reject) => {
    const processHandle = spawn(python, [scriptPath, "--input", inputPath, "--output", outputPath, "--config", JSON.stringify(config)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (jobId) activeProcesses.set(jobId, processHandle);
    let stdout = "";
    let stdoutBuffer = "";
    let stderr = "";
    const progressTimeoutMs = positiveInteger(process.env.ANALYSIS_PROGRESS_TIMEOUT_MS, DEFAULT_PROGRESS_TIMEOUT_MS);
    let livenessTimeout: ReturnType<typeof setTimeout> | null = null;
    const clearLivenessTimeout = () => {
      if (livenessTimeout) clearTimeout(livenessTimeout);
      livenessTimeout = null;
    };
    const armLivenessTimeout = () => {
      clearLivenessTimeout();
      livenessTimeout = setTimeout(() => {
        console.error(`[ImageAnalysis] Job ${jobId ?? "direct"} did not report progress within ${progressTimeoutMs} ms.`);
        processHandle.kill("SIGKILL");
        reject(new AnalysisEngineError("The analysis engine did not report progress in time. Please retry with a smaller image or less detail."));
      }, progressTimeoutMs);
    };
    const processTimeoutMs = processTimeoutFor(config);
    const timeout = setTimeout(() => {
      console.error(`[ImageAnalysis] Job ${jobId ?? "direct"} exceeded its ${config.runParameterSensitivity ? "advanced" : "standard"} processing budget after ${processTimeoutMs} ms.`);
      processHandle.kill("SIGKILL");
      reject(new AnalysisEngineError(processingLimitMessage(config)));
    }, processTimeoutMs);
    console.info(`[ImageAnalysis] Job ${jobId ?? "direct"} started Python analysis with ${config.runParameterSensitivity ? "advanced" : "standard"} processing budget ${processTimeoutMs} ms.`);
    armLivenessTimeout();
    processHandle.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-1_000_000);
      stdoutBuffer += text;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { event?: string; stage?: string; percent?: number; message?: string };
          if (event.event === "progress" && typeof event.stage === "string" && typeof event.percent === "number" && typeof event.message === "string") {
            armLivenessTimeout();
            console.info(`[ImageAnalysis] Job ${jobId ?? "direct"} progressed to ${event.stage} (${event.percent}%).`);
            onProgress?.({ status: "running", stage: event.stage, percent: event.percent, message: event.message });
          }
        } catch {
          // The final completion record is parsed after process closure; unrelated diagnostic output is not progress.
        }
      }
    });
    processHandle.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    processHandle.on("error", error => {
      clearTimeout(timeout);
      clearLivenessTimeout();
      reject(new Error(`Could not start the Python analysis engine: ${error.message}`));
    });
    processHandle.on("close", code => {
      clearTimeout(timeout);
      clearLivenessTimeout();
      if (jobId) activeProcesses.delete(jobId);
      if (jobId && cancelledJobIds.has(jobId)) {
        cancelledJobIds.delete(jobId);
        reject(new AnalysisCancelledError("Analysis was cancelled before completion."));
        return;
      }
      if (code !== 0) {
        console.error(`[ImageAnalysis] Python engine failed with exit code ${code}: ${stderr.slice(-4000)}`);
        reject(new AnalysisEngineError());
        return;
      }
      try {
        const completion = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
        if (!completion.ok) throw new Error("The Python analysis engine returned an invalid completion response.");
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("The Python analysis engine returned malformed output."));
      }
    });
  });
}

async function uploadArtifactRecord(jobId: string, outputPath: string, relativePath: string, contentType: string) {
  const buffer = await fs.readFile(path.join(outputPath, relativePath));
  const key = `hierarchical-image-representation/${jobId}/${relativePath}`;
  return storagePut(key, buffer, contentType);
}

async function uploadArtifact(jobId: string, outputPath: string, relativePath: string, contentType: string) {
  return (await uploadArtifactRecord(jobId, outputPath, relativePath, contentType)).url;
}

function boundedSet<T>(map: Map<string, T>, key: string, value: T, capacity: number) {
  map.delete(key); map.set(key, value);
  while (map.size > capacity) map.delete(map.keys().next().value as string);
}

async function loadErrorEvidence(evidence: { key: string; width: number; height: number }) {
  const cached = decodedErrorEvidence.get(evidence.key);
  if (cached) return cached;
  const signedUrl = await storageGetSignedUrl(evidence.key);
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error("The private error-evidence artifact could not be loaded.");
  const payload = gunzipSync(Buffer.from(await response.arrayBuffer()));
  const width = payload.readUInt32LE(0); const height = payload.readUInt32LE(4);
  if (width !== evidence.width || height !== evidence.height || payload.length !== 8 + width * height * 2) throw new Error("The private error-evidence artifact is malformed.");
  const values = new Uint16Array(width * height);
  for (let index = 0; index < values.length; index += 1) values[index] = payload.readUInt16LE(8 + index * 2);
  const decoded = { width, height, values };
  boundedSet(decodedErrorEvidence, evidence.key, decoded, DEFAULT_RESULT_CACHE_CAPACITY * 8);
  return decoded;
}

function heatmapColor(value: number) {
  const t = Math.max(0, Math.min(1, value / ERROR_HEATMAP_REFERENCE_DELTA));
  return t < 0.5 ? [Math.round(90 * t * 2), Math.round(24 * t * 2), Math.round(120 + 120 * t * 2)] : [Math.round(180 + 75 * (t - 0.5) * 2), Math.round(48 + 180 * (t - 0.5) * 2), Math.round(240 - 200 * (t - 0.5) * 2)];
}

async function requirePrivateErrorEvidence(jobId: string, ownerId: string, mode: string) {
  const result = await getAnalysisResult(jobId);
  if (!result || result.ownerId !== ownerId) throw new Error("This analysis result is not available to the current user.");
  const evidence = result.errorEvidence?.[mode];
  if (!evidence) throw new Error("Exact error evidence is unavailable for the selected reconstruction.");
  return { result, evidence };
}

export async function getLocalErrorSample(jobId: string, ownerId: string, mode: string, x: number, y: number) {
  const { evidence } = await requirePrivateErrorEvidence(jobId, ownerId, mode);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= evidence.width || y >= evidence.height) throw new Error("Requested error coordinate is outside the reconstruction bounds.");
  const decoded = await loadErrorEvidence(evidence);
  const channelSum = decoded.values[y * decoded.width + x] ?? 0;
  return { mode, x, y, meanAbsoluteDeltaRgb: channelSum / 3, referenceMeanAbsoluteRgbDelta: ERROR_HEATMAP_REFERENCE_DELTA };
}

export async function getThresholdedErrorHeatmap(jobId: string, ownerId: string, mode: string, thresholdDelta: number) {
  if (!Number.isFinite(thresholdDelta) || thresholdDelta < 0 || thresholdDelta > ERROR_HEATMAP_REFERENCE_DELTA) throw new Error("Heatmap threshold must be between 0 and 32 ΔRGB.");
  const threshold = Math.round(thresholdDelta);
  const { evidence } = await requirePrivateErrorEvidence(jobId, ownerId, mode);
  const cacheKey = `${jobId}:${mode}:${threshold}`;
  const cached = thresholdedHeatmapUrls.get(cacheKey);
  if (cached) return { mode, thresholdDelta: threshold, url: cached, referenceMeanAbsoluteRgbDelta: ERROR_HEATMAP_REFERENCE_DELTA };
  const decoded = await loadErrorEvidence(evidence);
  const png = new PNG({ width: decoded.width, height: decoded.height });
  for (let index = 0; index < decoded.values.length; index += 1) {
    const delta = (decoded.values[index] ?? 0) / 3; const offset = index * 4; const [r, g, b] = heatmapColor(delta);
    png.data[offset] = r; png.data[offset + 1] = g; png.data[offset + 2] = b;
    png.data[offset + 3] = delta <= threshold ? 0 : Math.round(Math.pow((delta - threshold) / Math.max(ERROR_HEATMAP_REFERENCE_DELTA - threshold, 1), 0.75) * 255);
  }
  const url = `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
  boundedSet(thresholdedHeatmapUrls, cacheKey, url, MAX_THRESHOLD_HEATMAPS);
  return { mode, thresholdDelta: threshold, url, referenceMeanAbsoluteRgbDelta: ERROR_HEATMAP_REFERENCE_DELTA };
}

export async function analyzeImage(input: {
  fileName: string;
  mimeType: string;
  dataBase64: string;
  config: AnalysisConfig;
}, ownerId = "direct", admissionKey = `direct:${ownerId}`, run?: { jobId?: string; onProgress?: (event: AnalysisProgressEvent) => void; completedSnapshot?: () => AnalysisJobStatus | null; admissionReserved?: boolean }): Promise<AnalysisResult> {
  run?.onProgress?.({ status: "running", stage: "validating_input", percent: 1, message: "Validating the uploaded image and configured limits." });
  const { extension, data } = preflightAnalysisInput(input);

  if (!run?.admissionReserved) submissionAdmission.acquire(admissionKey);
  try {
    const jobId = run?.jobId ?? nanoid(14);
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hierarchy-analysis-"));
    const inputPath = path.join(workspace, `source.${extension}`);
    const outputPath = path.join(workspace, "output");
    try {
      await fs.mkdir(outputPath, { recursive: true });
      await fs.writeFile(inputPath, data);
      await runPython(inputPath, outputPath, input.config, run?.onProgress, run?.jobId);
      const representation = JSON.parse(await fs.readFile(path.join(outputPath, "representation.json"), "utf8")) as Record<string, unknown>;
    run?.onProgress?.({ status: "uploading", stage: "uploading_artifacts", percent: 97, message: "Uploading private analysis artifacts for the completed run." });
    const residualEnergyUrl = await uploadArtifact(jobId, outputPath, "errors/residual-energy.png", "image/png");
    const overlayUrls = {
      brightness: await uploadArtifact(jobId, outputPath, "overlays/brightness.png", "image/png"),
      edgeStrength: await uploadArtifact(jobId, outputPath, "overlays/edge-strength.png", "image/png"),
      gradientX: await uploadArtifact(jobId, outputPath, "overlays/gradient-x.png", "image/png"),
      gradientY: await uploadArtifact(jobId, outputPath, "overlays/gradient-y.png", "image/png"),
      complexity: await uploadArtifact(jobId, outputPath, "overlays/complexity.png", "image/png"),
      residualEnergy: residualEnergyUrl,
      relationshipGraph: await uploadArtifact(jobId, outputPath, "overlays/relationship-graph.png", "image/png"),
      normalizedDistanceGraph: await uploadArtifact(jobId, outputPath, "overlays/normalized-distance-graph.png", "image/png"),
    };
    const reconstructions = {
      level1: await uploadArtifact(jobId, outputPath, "reconstructions/level1.png", "image/png"),
      level2: await uploadArtifact(jobId, outputPath, "reconstructions/level2.png", "image/png"),
      level3: await uploadArtifact(jobId, outputPath, "reconstructions/level3.png", "image/png"),
      level4: await uploadArtifact(jobId, outputPath, "reconstructions/level4.png", "image/png"),
      full: await uploadArtifact(jobId, outputPath, "reconstructions/full.png", "image/png"),
      constant: await uploadArtifact(jobId, outputPath, "reconstructions/constant.png", "image/png"),
      parametric: await uploadArtifact(jobId, outputPath, "reconstructions/parametric.png", "image/png"),
      residual: await uploadArtifact(jobId, outputPath, "reconstructions/residual.png", "image/png"),
    };
    const byReconstruction = Object.fromEntries(await Promise.all(["level1", "level2", "level3", "level4", "full", "constant", "parametric", "residual"].map(async mode => [mode, await uploadArtifact(jobId, outputPath, `errors/by-reconstruction/${mode}.png`, "image/png")] as const)));
    const errors = {
      absolutePixelError: await uploadArtifact(jobId, outputPath, "errors/absolute-error.png", "image/png"),
      parametricError: await uploadArtifact(jobId, outputPath, "errors/parametric-error.png", "image/png"),
      perRegionError: await uploadArtifact(jobId, outputPath, "errors/per-region-error.png", "image/png"),
      residualEnergy: residualEnergyUrl,
      byReconstruction,
    };
    const evidenceMetadata = (((representation.artifacts as { errors?: { evidenceByReconstruction?: Record<string, { artifact?: string; width?: number; height?: number }> } } | undefined)?.errors?.evidenceByReconstruction) ?? {});
    const errorEvidence = Object.fromEntries(await Promise.all(Object.entries(evidenceMetadata).map(async ([mode, metadata]) => {
      const width = metadata.width; const height = metadata.height;
      if (!metadata.artifact || typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`Missing exact error evidence for reconstruction mode ${mode}.`);
      const uploaded = await uploadArtifactRecord(jobId, outputPath, metadata.artifact, "application/gzip");
      return [mode, { key: uploaded.key, width, height }] as const;
    })));
    const residualArtifact = (representation.artifacts as { residuals?: string | null } | undefined)?.residuals;
    const sensitivityArtifact = (representation.artifacts as { parameterSensitivity?: string | null } | undefined)?.parameterSensitivity;
    const artifactUrls: AnalysisArtifactUrls = {
      representationJson: await uploadArtifact(jobId, outputPath, "representation.json", "application/json"),
      featuresNpz: await uploadArtifact(jobId, outputPath, "features.npz", "application/octet-stream"),
      ...(residualArtifact ? { residualsNpz: await uploadArtifact(jobId, outputPath, residualArtifact, "application/octet-stream") } : {}),
      ...(sensitivityArtifact ? { parameterSensitivity: await uploadArtifact(jobId, outputPath, sensitivityArtifact, "application/json") } : {}),
      reconstructedPng: await uploadArtifact(jobId, outputPath, "reconstructed.png", "image/png"),
      svg: await uploadArtifact(jobId, outputPath, "reconstruction.svg", "image/svg+xml"),
      overlays: overlayUrls,
      reconstructions,
      errors,
    };
      run?.onProgress?.({ status: "uploading", stage: "finalizing", percent: 99, message: "Finalizing owner-scoped analysis results." });
      const completedJob = run?.completedSnapshot?.() ?? (run?.jobId ? activeJobs.previewCompletion(run.jobId) : null);
      if (completedJob?.timing) {
        representation.executionTiming = {
          schema: "AnalysisExecutionTiming@1",
          totalDurationMs: completedJob.timing.totalElapsedMs,
          stages: completedJob.timing.stages,
          interpretation: "Server-observed orchestration timing for this private run, including bridge and artifact work; not a benchmark or performance guarantee.",
        };
      }
      const result = { jobId, ownerId, representation, artifactUrls, errorEvidence };
      activeResults.remember(result);
      await saveAnalysisManifest({ jobId, ownerId, status: "completed", expiresAt: new Date(Date.now() + DEFAULT_RESULT_TTL_MS), completedAt: new Date(), payload: JSON.stringify(result), progressSnapshot: completedJob ? JSON.stringify(completedJob) : null });
      if (run?.jobId) activeJobs.complete(run.jobId);
      return result;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  } finally {
    submissionAdmission.release();
  }
}

function clearLocalJobEvidence(jobId: string) {
  for (const key of Array.from(thresholdedHeatmapUrls.keys())) if (key.startsWith(`${jobId}:`)) thresholdedHeatmapUrls.delete(key);
  for (const key of Array.from(decodedErrorEvidence.keys())) if (key.includes(`/${jobId}/`)) decodedErrorEvidence.delete(key);
}

async function revokeLocalResultAccess(jobId: string, ownerId: string, reason: "discarded" | "expired") {
  activeResults.remove(jobId);
  activeJobs.remove(jobId);
  clearLocalJobEvidence(jobId);
  console.info(`[ImageAnalysis] Job ${jobId} access revoked (${reason}).`);
  return reason === "discarded"
    ? discardAnalysisManifest(jobId, ownerId)
    : expireAnalysisManifest(jobId, ownerId);
}

async function ensureManifestAccess(jobId: string) {
  const manifest = await getAnalysisManifest(jobId);
  if (!manifest) return null;
  if (manifest.status === "discarded" || manifest.status === "expired") {
    activeResults.remove(jobId);
    activeJobs.remove(jobId);
    clearLocalJobEvidence(jobId);
    return null;
  }
  if (manifest.expiresAt.getTime() <= Date.now()) {
    await revokeLocalResultAccess(jobId, manifest.ownerId, "expired");
    return null;
  }
  return manifest;
}

export async function getAnalysisResult(jobId: string) {
  const manifest = await ensureManifestAccess(jobId);
  if (manifest && manifest.status !== "completed") return null;
  const cached = activeResults.get(jobId);
  if (cached && (!manifest || cached.ownerId === manifest.ownerId)) return cached;
  if (!manifest || !manifest.payload) {
    clearLocalJobEvidence(jobId);
    return null;
  }
  try {
    const result = JSON.parse(manifest.payload) as AnalysisResult;
    if (result.jobId !== jobId || result.ownerId !== manifest.ownerId) return null;
    activeResults.remember(result);
    return result;
  } catch {
    return null;
  }
}

export async function startAnalysisJob(input: { fileName: string; mimeType: string; dataBase64: string; config: AnalysisConfig }, ownerId: string, admissionKey: string) {
  preflightAnalysisInput(input);
  submissionAdmission.acquire(admissionKey);
  const jobId = nanoid(14);
  const job = activeJobs.create(jobId, ownerId, Date.now(), input.config);
  console.info(`[ImageAnalysis] Job ${jobId} admitted for server-side analysis.`);
  try {
    await saveAnalysisManifest({ jobId, ownerId, status: "queued", expiresAt: new Date(Date.now() + DEFAULT_RESULT_TTL_MS), progressSnapshot: JSON.stringify(job) });
  } catch (error) {
    submissionAdmission.release();
    activeJobs.fail(jobId, error instanceof Error ? error.message : "Analysis could not be scheduled.");
    throw error;
  }
  let latestJob: AnalysisJobStatus = job;
  void analyzeImage(input, ownerId, admissionKey, { jobId, admissionReserved: true, completedSnapshot: () => activeJobs.previewCompletion(jobId) ?? completedJobSnapshot(latestJob, Date.now()), onProgress: update => {
    const currentJob = activeJobs.update(jobId, update);
    if (currentJob) latestJob = currentJob;
    const status = update.status === "running" || update.status === "uploading" ? update.status : "queued";
    void saveAnalysisManifest({ jobId, ownerId, status, expiresAt: new Date(Date.now() + DEFAULT_RESULT_TTL_MS), progressSnapshot: currentJob ? JSON.stringify(currentJob) : null }).catch(() => undefined);
  } })
    .then(async () => {
      activeJobs.complete(jobId);
      console.info(`[ImageAnalysis] Job ${jobId} completed and private references were persisted.`);
    })
    .catch(async error => {
      const cancelled = error instanceof AnalysisCancelledError;
      const safeError = error instanceof AnalysisEngineError
        ? error.message
        : "The analysis could not complete. Please retry with a smaller image or less detail.";
      const terminalJob = cancelled ? activeJobs.cancel(jobId) : activeJobs.fail(jobId, safeError);
      console.error(`[ImageAnalysis] Job ${jobId} ended ${cancelled ? "cancelled" : "failed"}.`);
      await saveAnalysisManifest({ jobId, ownerId, status: cancelled ? "cancelled" : "failed", expiresAt: new Date(Date.now() + DEFAULT_RESULT_TTL_MS), completedAt: new Date(), error: cancelled ? null : safeError, progressSnapshot: terminalJob ? JSON.stringify(terminalJob) : null }).catch(() => undefined);
    });
  return job;
}

export async function getAnalysisJob(jobId: string) {
  const active = activeJobs.get(jobId);
  const manifest = await ensureManifestAccess(jobId);
  if (!manifest) return null;
  if (active && active.ownerId === manifest.ownerId) return active;
  if (manifest.progressSnapshot) {
    try {
      const persisted = JSON.parse(manifest.progressSnapshot) as AnalysisJobStatus;
      if (persisted.jobId === jobId && persisted.ownerId === manifest.ownerId) {
        return {
          ...persisted,
          status: manifest.status as AnalysisJobStatus["status"],
          expiresAt: manifest.expiresAt.getTime(),
          completedAt: manifest.completedAt?.getTime() ?? persisted.completedAt,
          error: manifest.error ?? persisted.error,
          resultAvailable: manifest.status === "completed",
        };
      }
    } catch {
      // A malformed durable progress snapshot is ignored in favor of the safe lifecycle fallback below.
    }
  }
  const terminal = manifest.status === "completed" || manifest.status === "failed" || manifest.status === "cancelled";
  return { jobId, ownerId: manifest.ownerId, status: manifest.status as AnalysisJobStatus["status"], stage: manifest.status, percent: manifest.status === "completed" ? 100 : 0, message: terminal ? manifest.status === "completed" ? "Analysis result remains available." : manifest.status === "cancelled" ? "Analysis was cancelled." : "Analysis did not complete." : "Analysis state is being restored.", createdAt: manifest.createdAt.getTime(), updatedAt: manifest.updatedAt.getTime(), completedAt: manifest.completedAt?.getTime() ?? null, expiresAt: manifest.expiresAt.getTime(), error: manifest.error ?? null, resultAvailable: manifest.status === "completed" };
}

export async function cancelAnalysisJob(jobId: string, ownerId: string) {
  const job = await getAnalysisJob(jobId);
  if (!job || job.ownerId !== ownerId) return null;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
  cancelledJobIds.add(jobId);
  activeProcesses.get(jobId)?.kill("SIGKILL");
  const cancelled = activeJobs.cancel(jobId) ?? { ...job, status: "cancelled" as const, stage: "cancelled", percent: job.percent, message: "Analysis was cancelled before completion.", completedAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + DEFAULT_RESULT_TTL_MS, error: null, resultAvailable: false };
  await saveAnalysisManifest({ jobId, ownerId, status: "cancelled", expiresAt: new Date(Date.now() + DEFAULT_RESULT_TTL_MS), completedAt: new Date(), progressSnapshot: JSON.stringify(cancelled) }).catch(() => undefined);
  return cancelled;
}

export async function discardAnalysisResult(jobId: string, ownerId: string) {
  const manifest = await ensureManifestAccess(jobId);
  if (!manifest || manifest.ownerId !== ownerId || manifest.status !== "completed") return false;
  return revokeLocalResultAccess(jobId, ownerId, "discarded");
}

export function getAnalysisCacheTelemetry() {
  return activeResults.telemetry();
}

export const __testOnly = {
  processTimeoutFor,
  seedActiveJob(jobId: string, ownerId: string, now = Date.now()) {
    return activeJobs.create(jobId, ownerId, now);
  },
  clearActiveJob(jobId: string) {
    activeJobs.remove(jobId);
  },
};
