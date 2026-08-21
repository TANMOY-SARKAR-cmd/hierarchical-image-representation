import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { nanoid } from "nanoid";
import { storagePut } from "./storage";

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
  runScaleConsistency: boolean;
  maxConsistencyPixels: number;
  crossScaleOverlapThreshold: number;
  labDeltaESigma: number;
  boundaryGradientPercentile: number;
  topology: "4-neighbour";
  graphK: number;
  mergeThreshold: number;
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
};

export type AnalysisJobStatus = {
  jobId: string;
  ownerId: string;
  status: "queued" | "running" | "uploading" | "completed" | "failed";
  stage: string;
  percent: number;
  message: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
  resultAvailable: boolean;
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

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class AnalysisAdmissionError extends Error {
  readonly code = "TOO_MANY_REQUESTS";
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

  constructor(private readonly ttlMs: number) {}

  create(jobId: string, ownerId: string, now = Date.now()) {
    this.purge(now);
    const job: AnalysisJobStatus = { jobId, ownerId, status: "queued", stage: "queued", percent: 0, message: "Queued for secure server-side analysis.", createdAt: now, updatedAt: now, completedAt: null, error: null, resultAvailable: false };
    this.jobs.set(jobId, job);
    return job;
  }

  update(jobId: string, update: AnalysisProgressEvent, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "completed" || job.status === "failed") return null;
    const next = { ...job, ...update, percent: Math.max(job.percent, Math.min(99, Math.round(update.percent))), updatedAt: now };
    this.jobs.set(jobId, next);
    return next;
  }

  complete(jobId: string, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const next = { ...job, status: "completed" as const, stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", updatedAt: now, completedAt: now, error: null, resultAvailable: true };
    this.jobs.set(jobId, next);
    return next;
  }

  fail(jobId: string, error: string, now = Date.now()) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const next = { ...job, status: "failed" as const, stage: "failed", message: "Analysis did not complete.", updatedAt: now, completedAt: now, error, resultAvailable: false };
    this.jobs.set(jobId, next);
    return next;
  }

  get(jobId: string, now = Date.now()) {
    this.purge(now);
    return this.jobs.get(jobId) ?? null;
  }

  private purge(now: number) {
    for (const [jobId, job] of Array.from(this.jobs.entries())) if (job.completedAt !== null && now - job.completedAt >= this.ttlMs) this.jobs.delete(jobId);
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

function runPython(inputPath: string, outputPath: string, config: AnalysisConfig, onProgress?: (event: AnalysisProgressEvent) => void) {
  const scriptPath = path.join(process.cwd(), "python_engine", "representation_engine.py");
  const python = process.env.PYTHON_EXECUTABLE ?? "python3";
  return new Promise<void>((resolve, reject) => {
    const processHandle = spawn(python, [scriptPath, "--input", inputPath, "--output", outputPath, "--config", JSON.stringify(config)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBuffer = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("Image analysis exceeded the 120-second processing limit."));
    }, 120_000);
    processHandle.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { event?: string; stage?: string; percent?: number; message?: string };
          if (event.event === "progress" && typeof event.stage === "string" && typeof event.percent === "number" && typeof event.message === "string") onProgress?.({ status: "running", stage: event.stage, percent: event.percent, message: event.message });
        } catch {
          // The final completion record is parsed after process closure; unrelated diagnostic output is not progress.
        }
      }
    });
    processHandle.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    processHandle.on("error", error => {
      clearTimeout(timeout);
      reject(new Error(`Could not start the Python analysis engine: ${error.message}`));
    });
    processHandle.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`The Python analysis engine failed (${code}): ${stderr.slice(-1200)}`));
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

async function uploadArtifact(jobId: string, outputPath: string, relativePath: string, contentType: string) {
  const buffer = await fs.readFile(path.join(outputPath, relativePath));
  const key = `hierarchical-image-representation/${jobId}/${relativePath}`;
  const uploaded = await storagePut(key, buffer, contentType);
  return uploaded.url;
}

export async function analyzeImage(input: {
  fileName: string;
  mimeType: string;
  dataBase64: string;
  config: AnalysisConfig;
}, ownerId = "direct", admissionKey = `direct:${ownerId}`, run?: { jobId?: string; onProgress?: (event: AnalysisProgressEvent) => void }): Promise<AnalysisResult> {
  run?.onProgress?.({ status: "running", stage: "validating_input", percent: 1, message: "Validating the uploaded image and configured limits." });
  if (!supportedMimeTypes.has(input.mimeType)) {
    throw new Error("Supported image formats are PNG, JPEG, and WebP.");
  }
  const extension = safeName(input.fileName);
  const data = decodeBase64Image(input.dataBase64);
  validateImageSignature(data, input.mimeType, extension);
  const hardLimit = Number(process.env.MAX_IMAGE_BYTES ?? 8 * 1024 * 1024);
  const allowedSize = Math.min(input.config.maxFileSizeBytes, hardLimit);
  if (data.byteLength > allowedSize) {
    throw new Error(`The uploaded image exceeds the configured ${(allowedSize / 1024 / 1024).toFixed(1)} MB limit.`);
  }

  submissionAdmission.acquire(admissionKey);
  try {
    const jobId = run?.jobId ?? nanoid(14);
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hierarchy-analysis-"));
    const inputPath = path.join(workspace, `source.${extension}`);
    const outputPath = path.join(workspace, "output");
    try {
      await fs.mkdir(outputPath, { recursive: true });
      await fs.writeFile(inputPath, data);
      await runPython(inputPath, outputPath, input.config, run?.onProgress);
      const representation = JSON.parse(await fs.readFile(path.join(outputPath, "representation.json"), "utf8")) as Record<string, unknown>;
    run?.onProgress?.({ status: "uploading", stage: "uploading_artifacts", percent: 97, message: "Uploading private analysis artifacts for the completed run." });
    const overlayUrls = {
      brightness: await uploadArtifact(jobId, outputPath, "overlays/brightness.png", "image/png"),
      edgeStrength: await uploadArtifact(jobId, outputPath, "overlays/edge-strength.png", "image/png"),
      gradientX: await uploadArtifact(jobId, outputPath, "overlays/gradient-x.png", "image/png"),
      gradientY: await uploadArtifact(jobId, outputPath, "overlays/gradient-y.png", "image/png"),
      complexity: await uploadArtifact(jobId, outputPath, "overlays/complexity.png", "image/png"),
      residualEnergy: await uploadArtifact(jobId, outputPath, "errors/residual-energy.png", "image/png"),
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
      residualEnergy: await uploadArtifact(jobId, outputPath, "errors/residual-energy.png", "image/png"),
      byReconstruction,
    };
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
      const result = { jobId, ownerId, representation, artifactUrls };
      activeResults.remember(result);
      run?.onProgress?.({ status: "uploading", stage: "finalizing", percent: 99, message: "Finalizing owner-scoped analysis results." });
      return result;
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  } finally {
    submissionAdmission.release();
  }
}

export function getAnalysisResult(jobId: string) {
  return activeResults.get(jobId);
}

export function startAnalysisJob(input: { fileName: string; mimeType: string; dataBase64: string; config: AnalysisConfig }, ownerId: string, admissionKey: string) {
  const jobId = nanoid(14);
  const job = activeJobs.create(jobId, ownerId);
  void analyzeImage(input, ownerId, admissionKey, { jobId, onProgress: update => activeJobs.update(jobId, update) })
    .then(() => activeJobs.complete(jobId))
    .catch(error => activeJobs.fail(jobId, error instanceof Error ? error.message : "Image analysis could not be completed."));
  return job;
}

export function getAnalysisJob(jobId: string) {
  return activeJobs.get(jobId);
}

export function getAnalysisCacheTelemetry() {
  return activeResults.telemetry();
}
