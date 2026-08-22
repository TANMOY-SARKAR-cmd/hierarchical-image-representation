import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startMutation = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const cancelMutation = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const discardMutation = vi.hoisted(() => ({ isPending: false, mutateAsync: vi.fn() }));
const jobStatusQuery = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const resultQuery = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const telemetryQuery = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const thresholdedHeatmapQuery = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const localErrorQuery = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const authState = vi.hoisted(() => ({ user: null as { role: string } | null }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    imageAnalysis: {
      start: { useMutation: () => startMutation },
      cancel: { useMutation: () => cancelMutation },
      discard: { useMutation: () => discardMutation },
      status: { useQuery: (input: { jobId: string }) => input.jobId === "job-1" ? jobStatusQuery : { data: undefined, isLoading: false } },
      result: { useQuery: (input: { jobId: string }) => input.jobId === "job-1" ? resultQuery : { data: undefined, isLoading: false } },
      thresholdedHeatmap: { useQuery: () => thresholdedHeatmapQuery },
      localError: { useQuery: () => localErrorQuery },
      cacheTelemetry: { useQuery: () => telemetryQuery },
    },
  },
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => authState }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Home, { AnalysisProgressPanel, filterRelationships, relationshipRenderKey } from "./Home";

const baseRelationship = { sourceId: "micro-1", targetId: "micro-2", distance: 8, angle: 0, sizeRatio: 1, colorDistance: 2, colorSimilarity: 0.95, shapeSimilarity: 0.9, textureSimilarity: 0.8, brightnessDifference: 0.02, brightnessRatio: 1.02, normalizedDx: 0.05, normalizedDy: 0, boundaryContactRatio: 0.25, containmentRatio: 0, overlapRatio: 0, containment: "none" };
const makeEntity = (id: string, children: string[] = []) => ({ id, type: id === "image-root" ? "image" : "micro_region", level: id === "image-root" ? 5 : 1, scaleFactor: 1, geometry: { boundingBox: [0, 0, 10, 10], centroid: id === "micro-1" ? [4, 4] : [12, 12], area: 64, perimeter: 32, orientation: 0, compactness: 0.7 }, appearance: { meanRGB: [20, 140, 210], brightness: 0.52, varianceRGB: [1, 1, 1] }, appearanceModel: { schema: "AppearanceModel@0.5", model: "affine", parameterCount: 9, mseLab: 0.004, selectionScore: 0.008, boundaryResidual: 0.001, coefficients: [] }, statistics: { memberPixelCount: 64, complexity: 0.4 }, vector: { schema: "RegionVector@0.5", dimension: 20, values: Array.from({ length: 20 }, () => 0), provenance: "pixel_aggregate", aggregation: "mean" }, memberPixels: [], children, parentId: id === "image-root" ? null : "image-root", crossScaleMatchId: null });
const completedResult = {
  representation: {
    image: { width: 24, height: 24, sourceBytes: 120 },
    entities: [makeEntity("image-root", ["micro-1", "micro-2"]), makeEntity("micro-1"), makeEntity("micro-2")],
    relationships: [
      { ...baseRelationship, normalizedDistance: 0.1, confidence: 0.92, relationshipType: ["adjacent", "near"], primaryType: "adjacent", adjacent: true },
      { ...baseRelationship, targetId: "image-root", normalizedDistance: 0.45, confidence: 0.7, relationshipType: ["similar_color"], primaryType: "similar_color", adjacent: false },
    ],
    metrics: { mse: 0, psnr: 99, ssim: 1, processingTimeMs: 10, representationBytes: 100, representationOverhead: 1 },
    hierarchy: { rootId: "image-root", treeNodeIds: ["merge-1"], treeRootIds: ["merge-1"], cuts: { region: { targetNodeCount: 1, nodeIds: ["micro-1"], policy: "largest_leaf_count_expansion_from_tree_roots" }, composite: { targetNodeCount: 1, nodeIds: ["micro-1"], policy: "largest_leaf_count_expansion_from_tree_roots" }, entity: { targetNodeCount: 1, nodeIds: ["micro-1"], policy: "largest_leaf_count_expansion_from_tree_roots" } } }, feature_schema: { PixelVector: { fields: [] }, RegionVector: { fields: [], dimension: 20 } }, scales: [], segmentationDiagnostics: { slic: { strategy: "slic", entityCount: 72, meanBoundaryEdgeStrength: 0.11, requestedSegments: 72 }, watershed: { strategy: "watershed", entityCount: 68, meanBoundaryEdgeStrength: 0.15, requestedSegments: 72 } }, reconstruction_metadata: { outputs: { constant: { psnr: 24.1, ssim: 0.81 }, parametric: { psnr: 30.2, ssim: 0.91 }, residual: { psnr: 35.8, ssim: 0.96 } }, errorHeatmaps: { schema: "CalibratedAbsoluteRgbErrorHeatmap@0.7", semantics: "mean_absolute_rgb_difference_for_matching_reconstruction_artifact", referenceMeanAbsoluteRgbDelta: 32, transparentBelowMeanAbsoluteRgbDelta: 1, byReconstruction: { constant: { meanAbsoluteRgbDelta: 18.2, maxAbsoluteRgbDelta: 82.4 }, parametric: { meanAbsoluteRgbDelta: 9.3, maxAbsoluteRgbDelta: 47.8 }, residual: { meanAbsoluteRgbDelta: 2.6, maxAbsoluteRgbDelta: 21.1 } } }, heuristicRateDistortion: { basis: "parameter_payload_estimate_not_serialized_storage", modes: { constant: { score: 0.09, estimatedBytes: 640 }, parametric: { score: 0.05, estimatedBytes: 920 }, residual: { score: 0.02, estimatedBytes: 1300 } } } }, scale_consistency: { status: "completed" }, profiling: {}, artifactStorage: { basis: "actual_emitted_file_bytes", totalBytes: 4096, files: { "representation.json": 512, "features.npz": 2048, "residuals.npz": 1536 } },
  },
  artifactUrls: { representationJson: "/representation.json", featuresNpz: "/features.npz", residualsNpz: "/residuals.npz", reconstructedPng: "/reconstructed.png", svg: "/reconstruction.svg", overlays: { relationshipGraph: "/relationship.png", normalizedDistanceGraph: "/distance.png" }, reconstructions: { full: "/reconstructed.png", constant: "/constant.png", parametric: "/parametric.png", residual: "/residual.png" }, errors: { absolutePixelError: "/absolute-error.png", byReconstruction: { constant: "/heatmap-constant.png", parametric: "/heatmap-parametric.png", residual: "/heatmap-residual.png" } } },
};

describe("Hierarchy workbench UI", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    startMutation.mutateAsync.mockReset();
    cancelMutation.mutateAsync.mockReset();
    discardMutation.mutateAsync.mockReset();
    jobStatusQuery.data = undefined;
    resultQuery.data = undefined;
    thresholdedHeatmapQuery.data = undefined;
    localErrorQuery.data = undefined;
    telemetryQuery.data = undefined;
    telemetryQuery.isLoading = false;
    authState.user = null;
    class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
    class TestFileReader { result = "data:image/png;base64,ZmFrZQ=="; onload: (() => void) | null = null; onerror: (() => void) | null = null; readAsDataURL() { this.onload?.(); } }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("FileReader", TestFileReader);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fixture"), revokeObjectURL: vi.fn() });
  });

  it("renders a no-login first-use flow and enables analysis after a supported image is selected", () => {
    const { container } = render(<Home />);
    const analysisButton = screen.getByRole("button", { name: /run analysis/i });
    expect(screen.getByRole("heading", { name: /hierarchical image workbench/i })).toBeInTheDocument();
    expect(screen.getByText(/No sign-in required/i)).toBeInTheDocument();
    expect(screen.getByText("Advanced configuration")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Felzenszwalb" })).toBeInTheDocument();
    expect(screen.queryByText("Graph-edge filters")).not.toBeInTheDocument();
    expect(screen.queryByText("Complexity heatmap")).not.toBeInTheDocument();
    expect(screen.queryByText("NO ENTITY TREE LOADED")).not.toBeInTheDocument();
    expect(analysisButton).toBeDisabled();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = new File(["fixture"], "specimen.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [image] } });

    expect(screen.getByText("specimen.png")).toBeInTheDocument();
    expect(analysisButton).toBeEnabled();
  });

  it("filters graph edges by selected type, adjacency, confidence, and distance", () => {
    const relationships = [
      { ...baseRelationship, normalizedDistance: 0.1, confidence: 0.92, relationshipType: ["adjacent", "near"], primaryType: "adjacent", adjacent: true },
      { ...baseRelationship, targetId: "c", normalizedDistance: 0.42, confidence: 0.76, relationshipType: ["similar_color"], primaryType: "similar_color", adjacent: false },
      { ...baseRelationship, targetId: "d", normalizedDistance: 0.18, confidence: 0.3, relationshipType: ["near"], primaryType: "near", adjacent: false },
    ];
    expect(filterRelationships(relationships, { relationshipTypes: ["near"], adjacentOnly: false, minimumConfidence: 0.5, maximumNormalizedDistance: 0.25 })).toEqual([relationships[0]]);
    expect(filterRelationships(relationships, { relationshipTypes: [], adjacentOnly: true, minimumConfidence: 0, maximumNormalizedDistance: 1 })).toEqual([relationships[0]]);
  });

  it("creates unique render keys for relationship edges that share the same endpoints", () => {
    const first = { ...baseRelationship, normalizedDistance: 0.1, confidence: 0.92, relationshipType: ["adjacent"], primaryType: "adjacent", adjacent: true };
    const second = { ...baseRelationship, normalizedDistance: 0.1, confidence: 0.92, relationshipType: ["adjacent"], primaryType: "adjacent", adjacent: true };
    const keys = [relationshipRenderKey(first, 0, "entity-inspector"), relationshipRenderKey(second, 1, "entity-inspector")];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("shows the truthful server-reported analysis stage and percentage while a job is active", async () => {
    authState.user = { role: "user" };
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    jobStatusQuery.data = { jobId: "job-1", status: "running", stage: "segmentation", percent: 38, message: "Built deterministic micro-regions across the requested image scales.", createdAt: Date.now() - 4_000, updatedAt: Date.now(), completedAt: null, expiresAt: Date.now() + 1_800_000, error: null, resultAvailable: false };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    const progress = await view.findByRole("progressbar", { name: "Analysis progress" });
    expect(progress).toHaveAttribute("aria-valuenow", "38");
    expect(view.getByRole("heading", { name: "segmentation" })).toBeInTheDocument();
    expect(view.getByRole("button", { name: /segmentation/i })).toBeDisabled();
  });

  it("explains the sensitivity heartbeat stage and keeps the primary reconstruction settings intact", () => {
    const now = Date.now();
    const view = render(<AnalysisProgressPanel job={{ jobId: "job-1", status: "running", stage: "sensitivity", percent: 91, message: "Sensitivity study: variant 3 of 5 (conservative merges) — reconstruction.", createdAt: now - 12_000, updatedAt: now, completedAt: null, expiresAt: now + 1_800_000, error: null, resultAvailable: false }} />);
    expect(view.getByRole("heading", { name: "sensitivity" })).toBeInTheDocument();
    expect(view.getByText(/additional deterministic variants/i)).toBeInTheDocument();
    expect(view.getByText(/primary reconstruction settings are unchanged/i)).toBeInTheDocument();
  });

  it("shows a bounded compact ETA range only for an active advanced study", () => {
    const now = Date.now();
    const view = render(<AnalysisProgressPanel job={{ jobId: "job-1", status: "running", stage: "sensitivity", percent: 91, message: "Sensitivity study: variant 3 of 5 (conservative merges) — reconstruction.", createdAt: now - 12_000, updatedAt: now, completedAt: null, expiresAt: now + 1_800_000, error: null, resultAvailable: false, timing: { schema: "AnalysisTiming@1", totalElapsedMs: 12_000, stages: [], advancedEta: { minimumRemainingMs: 25_000, maximumRemainingMs: 55_000, basis: "sensitivity_variant" } } }} />);
    expect(view.getByText(/Advanced ETA: ~25s–55s remaining/i)).toBeInTheDocument();
    expect(view.getByText(/operational range/i)).toBeInTheDocument();
    expect(view.getByRole("progressbar", { name: "Advanced ETA range progress" })).toBeInTheDocument();
  });

  it("shows the five-variant duration guidance and retries the selected file after a terminal failure", async () => {
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    jobStatusQuery.data = { jobId: "job-1", status: "failed", stage: "failed", percent: 89, message: "Analysis did not complete.", createdAt: Date.now() - 10_000, updatedAt: Date.now(), completedAt: Date.now(), expiresAt: Date.now() + 1_800_000, error: "The advanced sensitivity study exceeded its bounded processing time.", resultAvailable: false };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: "Off" }));
    expect(view.getByText(/primary reconstruction is followed by five deterministic comparison variants/i)).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    const retry = await view.findByRole("button", { name: "Retry same analysis" });
    fireEvent.click(retry);
    await waitFor(() => expect(startMutation.mutateAsync).toHaveBeenCalledTimes(2));
  });

  it("offers an owner-scoped cancellation action while analysis is active", async () => {
    authState.user = { role: "user" };
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    cancelMutation.mutateAsync.mockResolvedValue({ jobId: "job-1", status: "cancelled" });
    jobStatusQuery.data = { jobId: "job-1", status: "running", stage: "segmentation", percent: 38, message: "Built deterministic micro-regions.", createdAt: Date.now() - 4_000, updatedAt: Date.now(), completedAt: null, expiresAt: Date.now() + 1_800_000, error: null, resultAvailable: false };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    fireEvent.click(await view.findByRole("button", { name: "Cancel analysis" }));
    expect(cancelMutation.mutateAsync).toHaveBeenCalledWith({ jobId: "job-1" });
  });

  it("keeps cancellation available while the optional sensitivity study is running", async () => {
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    cancelMutation.mutateAsync.mockResolvedValue({ jobId: "job-1", status: "cancelled" });
    jobStatusQuery.data = { jobId: "job-1", status: "running", stage: "sensitivity", percent: 91, message: "Sensitivity study: variant 3 of 5 — merge tree.", createdAt: Date.now() - 12_000, updatedAt: Date.now(), completedAt: null, expiresAt: Date.now() + 1_800_000, error: null, resultAvailable: false };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    fireEvent.click(await view.findByRole("button", { name: "Cancel analysis" }));
    expect(cancelMutation.mutateAsync).toHaveBeenCalledWith({ jobId: "job-1" });
  });

  it("advances the visible elapsed timer independently of status polling", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const view = render(<AnalysisProgressPanel job={{ jobId: "job-1", status: "running", stage: "segmentation", percent: 38, message: "Building deterministic micro-regions.", createdAt: now - 2_000, updatedAt: now, completedAt: null, expiresAt: now + 1_800_000, error: null, resultAvailable: false }} />);
      expect(view.getByText(/2s elapsed/i)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2_000));
      expect(view.getByText(/4s elapsed/i)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes the visible elapsed time when a terminal analysis state is received", () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const view = render(<AnalysisProgressPanel job={{ jobId: "job-1", status: "failed", stage: "failed", percent: 1, message: "Analysis did not complete.", createdAt: now - 12_000, updatedAt: now - 5_000, completedAt: now - 5_000, expiresAt: now + 1_800_000, error: "The analysis engine stopped reporting progress during engine startup and was safely stopped.", resultAvailable: false, failureReceipt: { schema: "AnalysisFailure@1", category: "startup_silence", lastSafeStage: "initializing_engine", elapsedMs: 7_000, childSpawned: true, startupHeartbeatObserved: true, engineReadyObserved: false, diagnosticToken: "HIR-job-1" } }} />);
      expect(view.getByText(/7s elapsed/i)).toBeInTheDocument();
      expect(view.getByText(/startup_silence · initializing engine/i)).toBeInTheDocument();
      expect(view.getByRole("button", { name: "Copy diagnostic token" })).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(120_000));
      expect(view.getByText(/7s elapsed/i)).toBeInTheDocument();
      expect(view.queryByText(/127s elapsed/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains access-only retention and sends the current result to the discard endpoint", async () => {
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    discardMutation.mutateAsync.mockResolvedValue({ jobId: "job-1", discarded: true });
    const now = Date.now();
    jobStatusQuery.data = { jobId: "job-1", status: "completed", stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", createdAt: now - 1_000, updatedAt: now, completedAt: now, expiresAt: now + 1_800_000, error: null, resultAvailable: true };
    resultQuery.data = { ...completedResult, jobId: "job-1" };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    const discard = await view.findByRole("button", { name: "Discard access" });
    expect(view.getByText(/not a physical storage-deletion claim/i)).toBeInTheDocument();
    fireEvent.click(discard);
    await waitFor(() => expect(discardMutation.mutateAsync).toHaveBeenCalledWith({ jobId: "job-1" }));
  });

  it("renders exact completed stage durations as a private execution timeline", async () => {
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    const now = Date.now();
    jobStatusQuery.data = { jobId: "job-1", status: "completed", stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", createdAt: now - 18_000, updatedAt: now, completedAt: now, expiresAt: now + 1_800_000, error: null, resultAvailable: true, timing: { schema: "AnalysisTiming@1", totalElapsedMs: 18_000, stages: [{ stage: "feature_extraction", label: "Feature extraction", startedAt: now - 18_000, endedAt: now - 11_000, durationMs: 7_000 }, { stage: "sensitivity", label: "Sensitivity study", startedAt: now - 11_000, endedAt: now, durationMs: 11_000 }], advancedEta: null } };
    resultQuery.data = { ...completedResult, jobId: "job-1", representation: { ...completedResult.representation, executionTiming: { schema: "AnalysisExecutionTiming@1", totalDurationMs: 18_000, stages: [{ stage: "feature_extraction", label: "Feature extraction", startedAt: now - 18_000, endedAt: now - 11_000, durationMs: 7_000, messages: [{ message: "Computing multiscale feature fields.", at: now - 16_000, offsetMs: 2_000 }] }, { stage: "sensitivity", label: "Sensitivity study", startedAt: now - 11_000, endedAt: now, durationMs: 11_000 }], interpretation: "Server-observed orchestration timing." } } };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    await view.findByRole("heading", { name: "Execution timeline" });
    expect(view.getByText(/Total server-observed time/i)).toBeInTheDocument();
    expect(view.getAllByText("18s").length).toBeGreaterThan(0);
    expect(view.getByText("Feature extraction")).toBeInTheDocument();
    expect(view.getByText("Sensitivity study")).toBeInTheDocument();
    expect(view.getByLabelText("Analysis stage durations")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: /feature extraction/i }));
    expect(view.getByText("Stage progress details")).toBeInTheDocument();
    expect(view.getByText("Computing multiscale feature fields.")).toBeInTheDocument();
  });

  it("renders duplicate-endpoint relationships without a React duplicate-key warning", async () => {
    const first = { ...baseRelationship, normalizedDistance: 0.1, confidence: 0.92, relationshipType: ["adjacent"], primaryType: "adjacent", adjacent: true };
    const second = { ...baseRelationship, normalizedDistance: 0.1, confidence: 0.92, relationshipType: ["adjacent"], primaryType: "adjacent", adjacent: true };
    authState.user = { role: "user" };
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    jobStatusQuery.data = { jobId: "job-1", status: "completed", stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", createdAt: Date.now() - 1_000, updatedAt: Date.now(), completedAt: Date.now(), expiresAt: Date.now() + 1_800_000, error: null, resultAvailable: true };
    resultQuery.data = { ...completedResult, jobId: "job-1", representation: { ...completedResult.representation, relationships: [first, second] } };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<Home />);
      fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
      fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
      fireEvent.click(await view.findByRole("button", { name: "Open inspection studio" }));
      await view.findByText("Relational context");
      expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key|unique key/i);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("revokes the previously owned source-preview URL before replacing a selected file", () => {
    const view = render(<Home />);
    const fileInput = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["first"], "first.png", { type: "image/png" })] } });
    fireEvent.change(fileInput, { target: { files: [new File(["second"], "second.png", { type: "image/png" })] } });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
  });

  it("renders aggregate runtime telemetry only for an administrator", () => {
    authState.user = { role: "admin" };
    telemetryQuery.data = { scope: "process_local_aggregate", activeEntries: 82, capacity: 100, ttlMs: 1_800_000, fillRatio: 0.82, writes: 91, lookups: 120, hits: 108, misses: 12, hitRate: 0.9, expiredEvictions: 3, capacityEvictions: 2, totalEvictions: 5, processStartedAt: 1_000, lastActivityAt: 2_000 };
    render(<Home />);
    expect(screen.getByText("Runtime telemetry")).toBeInTheDocument();
    expect(screen.getByText("82 / 100")).toBeInTheDocument();
    expect(screen.getByText("90.0%")).toBeInTheDocument();
    expect(screen.getByText(/cache capacity pressure is present/i)).toBeInTheDocument();
  });

  it("applies interactive edge controls and resets the filtered graph", async () => {
    authState.user = { role: "user" };
    startMutation.mutateAsync.mockResolvedValue({ jobId: "job-1" });
    jobStatusQuery.data = { jobId: "job-1", status: "completed", stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", createdAt: Date.now() - 1_000, updatedAt: Date.now(), completedAt: Date.now(), expiresAt: Date.now() + 1_800_000, error: null, resultAvailable: true };
    resultQuery.data = { ...completedResult, jobId: "job-1", representation: { ...completedResult.representation, reconstruction_metadata: { ...completedResult.representation.reconstruction_metadata, residual: { coverage: 0.34, actualEncodedBytes: 196_608, quantizationStep: 4, artifactEmitted: true } } } };
    const view = render(<Home />);
    fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(["fixture"], "specimen.png", { type: "image/png" })] } });
    fireEvent.click(view.getByRole("button", { name: /run analysis/i }));
    await view.findByRole("button", { name: "adjacent" });
    expect(view.getByText("2/2")).toBeInTheDocument();
    expect(view.queryByText("Adaptive reconstruction")).not.toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Open inspection studio" }));
    expect(await view.findByText("Adaptive reconstruction")).toBeInTheDocument();
    expect(await view.findByText("Global merge tree")).toBeInTheDocument();
    expect(await view.findByRole("button", { name: /Region\s*1/i })).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: /Region\s*1/i }));
    expect(view.getByText(/Derived-cut nodes · target 1/i)).toBeInTheDocument();
    expect(view.getByText("Segmentation diagnostics")).toBeInTheDocument();
    expect(view.getByText("72 regions")).toBeInTheDocument();
    expect(view.getByRole("link", { name: /download residual npz/i })).toHaveAttribute("href", "/residuals.npz");
    const comparison = await view.findByRole("slider", { name: "Original and reconstruction comparison position" });
    expect(comparison).toHaveValue("50");
    expect(view.getAllByText("PSNR 24.10 dB").length).toBeGreaterThan(0);
    expect(view.getAllByText(/Pixel correction 34.0%/i).length).toBeGreaterThan(0);
    fireEvent.change(comparison, { target: { value: "72" } });
    expect(comparison).toHaveValue("72");
    expect(view.getByAltText("CONSTANT reconstruction")).toHaveAttribute("src", "/constant.png");
    expect(view.getByText(/constant evidence/i)).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "MODEL" }));
    expect(view.getAllByText("PARAMETRIC").length).toBeGreaterThan(0);
    expect(view.getByRole("slider", { name: "Original and reconstruction comparison position" })).toHaveValue("50");
    expect(view.getByAltText("PARAMETRIC reconstruction")).toHaveAttribute("src", "/parametric.png");
    expect(view.getAllByText("PSNR 30.20 dB").length).toBeGreaterThan(0);
    expect(view.getByText(/parametric evidence/i)).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: /error heatmap off/i }));
    expect(view.getByAltText("parametric thresholded reconstruction error heatmap overlay")).toHaveAttribute("src", "/heatmap-parametric.png");
    expect(view.getByAltText("PARAMETRIC reconstruction")).toHaveAttribute("src", "/parametric.png");
    expect(view.getByText(/Paired with PARAMETRIC/i)).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: /error heatmap on/i }));
    fireEvent.click(view.getByRole("button", { name: "DETAIL" }));
    expect(view.getByAltText("RESIDUAL reconstruction")).toHaveAttribute("src", "/residual.png");
    expect(view.getAllByText("PSNR 35.80 dB").length).toBeGreaterThan(0);
    expect(view.getByText(/coverage 34.0%/i)).toBeInTheDocument();
    expect(view.getByText("Original / overlay")).toBeInTheDocument();
    expect(view.getByText("Reconstructed output")).toBeInTheDocument();
    expect(view.getByText("Swipe comparison")).toBeInTheDocument();
    expect(view.getByAltText("Hierarchically reconstructed image")).toHaveAttribute("src", "/residual.png");
    const errorOpacity = view.getByRole("slider", { name: "Error heatmap opacity" });
    expect(errorOpacity).toBeDisabled();
    fireEvent.click(view.getByRole("button", { name: /error heatmap off/i }));
    expect(view.getByAltText("residual thresholded reconstruction error heatmap overlay")).toHaveAttribute("src", "/heatmap-residual.png");
    expect(view.getByAltText("RESIDUAL reconstruction")).toHaveAttribute("src", "/residual.png");
    expect(errorOpacity).toBeEnabled();
    expect(view.getByRole("slider", { name: "Error threshold" })).toHaveValue("1");
    expect(view.getByText(/hide ≤ 1/i)).toBeInTheDocument();
    expect(view.getByText(/ΔRGB 16/i)).toBeInTheDocument();
    fireEvent.change(errorOpacity, { target: { value: "28" } });
    expect(errorOpacity).toHaveValue("28");

    fireEvent.click(view.getByRole("button", { name: "similar color" }));
    expect(view.getByText("1/2")).toBeInTheDocument();
    fireEvent.click(view.getByRole("button", { name: "Relationship graph" }));
    expect(view.getByLabelText("1 filtered graph edges")).toBeInTheDocument();

    fireEvent.click(view.getByText("Adjacent only").parentElement?.querySelector("button") as HTMLButtonElement);
    fireEvent.change(view.getByRole("spinbutton", { name: "Minimum confidence" }), { target: { value: "1" } });
    await waitFor(() => expect(view.getByText(/No graph edges match/i)).toBeInTheDocument());
    fireEvent.change(view.getByRole("spinbutton", { name: "Maximum normalized distance" }), { target: { value: "0.05" } });
    fireEvent.click(view.getByRole("button", { name: /reset edge filters/i }));
    expect(view.getByText("2/2")).toBeInTheDocument();
  });
});
