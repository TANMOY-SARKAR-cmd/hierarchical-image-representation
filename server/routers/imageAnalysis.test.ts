import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../imageAnalysis", () => ({
  AnalysisAdmissionError: class AnalysisAdmissionError extends Error {},
  AnalysisCancelledError: class AnalysisCancelledError extends Error {},
  AnalysisInputError: class AnalysisInputError extends Error {},
  analyzeImage: vi.fn(),
  cancelAnalysisJob: vi.fn(),
  discardAnalysisResult: vi.fn(),
  getAnalysisCacheTelemetry: vi.fn(),
  getAnalysisJob: vi.fn(),
  getAnalysisResult: vi.fn(),
  getLocalErrorSample: vi.fn(),
  getThresholdedErrorHeatmap: vi.fn(),
  startAnalysisJob: vi.fn(),
}));

import { AnalysisAdmissionError, analyzeImage, cancelAnalysisJob, discardAnalysisResult, getAnalysisCacheTelemetry, getAnalysisJob, getAnalysisResult, getLocalErrorSample, getThresholdedErrorHeatmap, startAnalysisJob } from "../imageAnalysis";
import { imageAnalysisRouter } from "./imageAnalysis";

const baseInput = {
  fileName: "fixture.png",
  mimeType: "image/png" as const,
  dataBase64: "cGxhY2Vob2xkZXI=",
  config: {
    maxFileSizeBytes: 1024 * 1024,
    maxImagePixels: 786432,
    groupingMethod: "slic" as const,
    segmentationStrategy: "slic" as const,
    hierarchyMethod: "global_energy_merge_tree" as const,
    maxAgglomerationIterations: 2048,
    mergeEnergyThreshold: 0.05,
    mergeEnergyWeights: { distortion: 1, rate: 0.06, boundary: 0.45, shape: 0.18, complexity: 0.12 },
    derivedCutTargetFractions: { region: 0.5, composite: 0.25, entity: 0.1 },
    scaleLevels: [1, 2, 4, 8],
    slicSegments: 72,
    slicCompactness: 10,
    minimumRegionPixels: 12,
    runScaleConsistency: true,
    maxConsistencyPixels: 786432,
    crossScaleOverlapThreshold: 0.20,
    labDeltaESigma: 22,
    boundaryGradientPercentile: 99,
    topology: "4-neighbour" as const,
    graphK: 3,
    edgeBarrierThreshold: 0.70,
    maxEntityAreaFraction: 0.72,
    complexityMergePenalty: 0.35,
    reconstructionProfile: "balanced" as const,
    appearanceModelCandidates: ["constant", "affine", "quadratic"] as const,
    modelPenalty: 0.00045,
    boundaryLeakagePenalty: 0.00015,
    residualEnabled: true,
    residualQuantization: 4,
    residualBudgetBytes: 196608,
    rateDistortionLambda: 0.0015,
    compareSegmentationBaselines: false,
    runParameterSensitivity: false,
    sensitivityVariantLimit: 5,
  },
};

const userContext = { user: { id: 1, role: "user" } } as never;

describe("imageAnalysis router", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes the child-process bridge through an authenticated typed v0.7 request", async () => {
    vi.mocked(analyzeImage).mockResolvedValue({ jobId: "job-123", ownerId: "1", representation: { version: "0.7.0" }, artifactUrls: { representationJson: "/manus-storage/result.json", featuresNpz: "/manus-storage/features.npz", reconstructedPng: "/manus-storage/reconstructed.png", svg: "/manus-storage/reconstruction.svg", overlays: {}, reconstructions: {}, errors: {} } });
    const caller = imageAnalysisRouter.createCaller(userContext);
    const response = await caller.process(baseInput);

    expect(analyzeImage).toHaveBeenCalledWith(expect.objectContaining({ ...baseInput, config: expect.objectContaining(baseInput.config) }), "1", "user:1");
    expect(response.jobId).toBe("job-123");
  });

  it("returns a typed throttling response when local admission is exhausted", async () => {
    vi.mocked(analyzeImage).mockRejectedValue(new AnalysisAdmissionError("Analysis capacity is busy. Please retry shortly."));
    const caller = imageAnalysisRouter.createCaller(userContext);
    await expect(caller.process(baseInput)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: expect.stringMatching(/capacity is busy/i) });
  });

  it("starts and exposes only the owner-scoped analysis job status", async () => {
    const queued = { jobId: "job-progress", ownerId: "1", status: "running", stage: "segmentation", percent: 38, message: "Built deterministic micro-regions.", createdAt: 1_000, updatedAt: 2_000, completedAt: null, error: null, resultAvailable: false };
    vi.mocked(startAnalysisJob).mockReturnValue(queued);
    vi.mocked(getAnalysisJob).mockReturnValue(queued);
    const owner = imageAnalysisRouter.createCaller(userContext);
    const otherUser = imageAnalysisRouter.createCaller({ user: { id: 2, role: "user" } } as never);

    await expect(owner.start(baseInput)).resolves.toEqual(queued);
    await expect(owner.status({ jobId: "job-progress" })).resolves.toEqual(queued);
    await expect(otherUser.status({ jobId: "job-progress" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(startAnalysisJob).toHaveBeenCalledWith(expect.objectContaining({ ...baseInput, config: expect.objectContaining(baseInput.config) }), "1", "user:1");
  });

  it("requires authentication for analysis submission and result inspection", async () => {
    const anonymous = imageAnalysisRouter.createCaller({ user: null } as never);
    await expect(anonymous.process(baseInput)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.result({ jobId: "missing" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns a not-found error for an unavailable owned in-memory result", async () => {
    vi.mocked(getAnalysisResult).mockReturnValue(null);
    const caller = imageAnalysisRouter.createCaller(userContext);
    await expect(caller.result({ jobId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns entity, hierarchy, relationship, and artifact views only to the result owner", async () => {
    const completedResult = { jobId: "job-123", ownerId: "1", representation: { hierarchy: { rootId: "root" }, pixelLevel: { assignmentKey: "pixelToMicroregion" }, scaleLevels: [], entities: [{ id: "root" }, { id: "region-1" }], relationships: [{ sourceId: "root", targetId: "region-1" }] }, artifactUrls: { representationJson: "/result.json", featuresNpz: "/features.npz", reconstructedPng: "/reconstructed.png", svg: "/reconstruction.svg", overlays: {}, reconstructions: {}, errors: {} } };
    vi.mocked(getAnalysisResult).mockReturnValue(completedResult);
    const owner = imageAnalysisRouter.createCaller(userContext);
    const otherUser = imageAnalysisRouter.createCaller({ user: { id: 2, role: "user" } } as never);

    await expect(owner.entity({ jobId: "job-123", entityId: "region-1" })).resolves.toEqual({ id: "region-1" });
    await expect(owner.hierarchy({ jobId: "job-123" })).resolves.toMatchObject({ hierarchy: { rootId: "root" } });
    await expect(owner.relationships({ jobId: "job-123", entityId: "region-1" })).resolves.toHaveLength(1);
    await expect(owner.artifacts({ jobId: "job-123" })).resolves.toMatchObject({ svg: "/reconstruction.svg" });
    await expect(otherUser.result({ jobId: "job-123" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(otherUser.artifacts({ jobId: "job-123" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns exact local ΔRGB and thresholded overlays through protected validated procedures", async () => {
    vi.mocked(getLocalErrorSample).mockResolvedValue({ mode: "parametric", x: 3, y: 4, meanAbsoluteDeltaRgb: 12.3333333333, referenceMeanAbsoluteRgbDelta: 32 });
    vi.mocked(getThresholdedErrorHeatmap).mockResolvedValue({ mode: "parametric", thresholdDelta: 8, url: "/thresholded.png", referenceMeanAbsoluteRgbDelta: 32 });
    const owner = imageAnalysisRouter.createCaller(userContext);
    await expect(owner.localError({ jobId: "job-123", mode: "parametric", x: 3, y: 4 })).resolves.toMatchObject({ meanAbsoluteDeltaRgb: 12.3333333333 });
    await expect(owner.thresholdedHeatmap({ jobId: "job-123", mode: "parametric", thresholdDelta: 8 })).resolves.toMatchObject({ url: "/thresholded.png" });
    expect(getLocalErrorSample).toHaveBeenCalledWith("job-123", "1", "parametric", 3, 4);
    expect(getThresholdedErrorHeatmap).toHaveBeenCalledWith("job-123", "1", "parametric", 8);
    await expect(owner.localError({ jobId: "job-123", mode: "parametric", x: -1, y: 4 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(owner.thresholdedHeatmap({ jobId: "job-123", mode: "parametric", thresholdDelta: 33 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns aggregate cache telemetry only to administrators", async () => {
    const telemetry = { scope: "process_local_aggregate", activeEntries: 8, capacity: 100, ttlMs: 1_800_000, fillRatio: 0.08, writes: 10, lookups: 14, hits: 9, misses: 5, hitRate: 9 / 14, expiredEvictions: 2, capacityEvictions: 0, totalEvictions: 2, processStartedAt: 1_000, lastActivityAt: 2_000 };
    vi.mocked(getAnalysisCacheTelemetry).mockReturnValue(telemetry);
    const adminCaller = imageAnalysisRouter.createCaller({ user: { id: 9, role: "admin" } } as never);
    const userCaller = imageAnalysisRouter.createCaller(userContext);

    await expect(adminCaller.cacheTelemetry()).resolves.toEqual(telemetry);
    expect(getAnalysisCacheTelemetry).toHaveBeenCalledTimes(1);
    await expect(userCaller.cacheTelemetry()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cancels and discards only owner-scoped analysis lifecycle records", async () => {
    const cancelled = { jobId: "job-123", ownerId: "1", status: "cancelled", stage: "cancelled", percent: 31, message: "Analysis was cancelled before completion.", createdAt: 1, updatedAt: 2, completedAt: 2, error: null, resultAvailable: false };
    vi.mocked(cancelAnalysisJob).mockResolvedValue(cancelled);
    vi.mocked(discardAnalysisResult).mockResolvedValue(true);
    const owner = imageAnalysisRouter.createCaller(userContext);
    await expect(owner.cancel({ jobId: "job-123" })).resolves.toMatchObject({ status: "cancelled" });
    await expect(owner.discard({ jobId: "job-123" })).resolves.toEqual({ jobId: "job-123", discarded: true });
    expect(cancelAnalysisJob).toHaveBeenCalledWith("job-123", "1");
    expect(discardAnalysisResult).toHaveBeenCalledWith("job-123", "1");
  });
});
