import { beforeEach, describe, expect, it, vi } from "vitest";

const getAnalysisManifestMock = vi.hoisted(() => vi.fn());
const expireAnalysisManifestMock = vi.hoisted(() => vi.fn());

vi.mock("./db", () => ({
  saveAnalysisManifest: vi.fn(),
  getAnalysisManifest: getAnalysisManifestMock,
  discardAnalysisManifest: vi.fn(),
  expireAnalysisManifest: expireAnalysisManifestMock,
}));

vi.mock("./storage", () => ({ storagePut: vi.fn(), storageGetSignedUrl: vi.fn() }));

import { AnalysisJobStore, __testOnly, getAnalysisJob } from "./imageAnalysis";

describe("durable analysis lifecycle guard", () => {
  const ownerId = "visitor:test-browser-workspace";

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly.clearActiveJob("stale-discarded");
    __testOnly.clearActiveJob("stale-expired");
    __testOnly.clearActiveJob("restored-timing");
  });

  it("does not reveal a stale process-local job after a durable discard", async () => {
    __testOnly.seedActiveJob("stale-discarded", ownerId);
    getAnalysisManifestMock.mockResolvedValue({ jobId: "stale-discarded", ownerId, status: "discarded", expiresAt: new Date(Date.now() + 60_000) });

    await expect(getAnalysisJob("stale-discarded")).resolves.toBeNull();
  });

  it("expires and removes a stale process-local job when the durable deadline has passed", async () => {
    __testOnly.seedActiveJob("stale-expired", ownerId);
    getAnalysisManifestMock.mockResolvedValue({ jobId: "stale-expired", ownerId, status: "completed", expiresAt: new Date(Date.now() - 1) });

    await expect(getAnalysisJob("stale-expired")).resolves.toBeNull();
    expect(expireAnalysisManifestMock).toHaveBeenCalledWith("stale-expired", ownerId);
  });

  it("grants the explicitly requested five-variant study a longer but finite processing budget", () => {
    const normalBudget = __testOnly.processTimeoutFor({ runParameterSensitivity: false, sensitivityVariantLimit: 0 });
    const advancedBudget = __testOnly.processTimeoutFor({ runParameterSensitivity: true, sensitivityVariantLimit: 5 });

    expect(advancedBudget).toBeGreaterThan(normalBudget);
    expect(advancedBudget).toBeLessThanOrEqual(7 * 60 * 1000);
  });

  it("coalesces sensitivity heartbeats into one timed stage and exposes a bounded advanced ETA range", () => {
    const store = new AnalysisJobStore(60_000);
    store.create("timed-advanced", ownerId, 1_000, { runParameterSensitivity: true, sensitivityVariantLimit: 5 });
    store.update("timed-advanced", { status: "running", stage: "feature_extraction", percent: 18, message: "Feature extraction." }, 2_000);
    store.update("timed-advanced", { status: "running", stage: "sensitivity", percent: 90, message: "Sensitivity study: variant 2 of 5 (finer partition)." }, 7_000);
    const active = store.update("timed-advanced", { status: "running", stage: "sensitivity", percent: 91, message: "Sensitivity study: variant 2 of 5 (finer partition) — reconstruction." }, 13_000);

    expect(active?.timing?.stages.map(stage => stage.stage)).toEqual(["queued", "feature_extraction", "sensitivity"]);
    expect(active?.timing?.stages.at(-1)?.durationMs).toBe(6_000);
    expect(active?.timing?.stages.at(-1)?.messages?.map(entry => entry.message)).toEqual(["Sensitivity study: variant 2 of 5 (finer partition).", "Sensitivity study: variant 2 of 5 (finer partition) — reconstruction."]);
    expect(active?.timing?.stages.at(-1)?.messages?.map(entry => entry.offsetMs)).toEqual([0, 6_000]);
    expect(active?.timing?.advancedEta).toMatchObject({ basis: "sensitivity_variant" });
    expect(active?.timing?.advancedEta?.minimumRemainingMs).toBeLessThanOrEqual(active?.timing?.advancedEta?.maximumRemainingMs ?? 0);

    const completed = store.complete("timed-advanced", 20_000);
    expect(completed?.timing?.advancedEta).toBeNull();
    expect(completed?.timing?.stages.at(-1)).toMatchObject({ stage: "sensitivity", endedAt: 20_000, durationMs: 13_000 });
    expect(completed?.timing?.stages.at(-1)?.messages).toHaveLength(2);
  });

  it("omits ETA ranges from normal primary analyses", () => {
    const store = new AnalysisJobStore(60_000);
    store.create("timed-primary", ownerId, 1_000, { runParameterSensitivity: false, sensitivityVariantLimit: 0 });
    const active = store.update("timed-primary", { status: "running", stage: "reconstruction", percent: 88, message: "Reconstructing." }, 8_000);
    expect(active?.timing?.advancedEta).toBeNull();
  });

  it("coalesces bounded public-safe merge-tree heartbeats while a full-fidelity hierarchy is active", () => {
    const store = new AnalysisJobStore(60_000);
    store.create("timed-merge-tree", ownerId, 1_000, { runParameterSensitivity: false, sensitivityVariantLimit: 0 });
    store.update("timed-merge-tree", { status: "running", stage: "cross_scale", percent: 50, message: "Recorded cross-scale correspondence and overlap evidence." }, 2_000);
    store.update("timed-merge-tree", { status: "running", stage: "merge_tree", percent: 51, message: "Starting deterministic global energy merge-tree construction." }, 3_000);
    const active = store.update("timed-merge-tree", { status: "running", stage: "merge_tree", percent: 58, message: "Scoring merge energy (32 of 128 relationships). Iteration 14; 58 active regions." }, 11_000);

    expect(active?.percent).toBe(58);
    expect(active?.timing?.stages.map(stage => stage.stage)).toEqual(["queued", "cross_scale", "merge_tree"]);
    expect(active?.timing?.stages.at(-1)).toMatchObject({ stage: "merge_tree", durationMs: 8_000 });
    expect(active?.timing?.stages.at(-1)?.messages).toEqual([
      { message: "Starting deterministic global energy merge-tree construction.", at: 3_000, offsetMs: 0 },
      { message: "Scoring merge energy (32 of 128 relationships). Iteration 14; 58 active regions.", at: 11_000, offsetMs: 8_000 },
    ]);
  });

  it("grants a finite standard-budget extension only for recent active merge-tree heartbeats", () => {
    const config = { runParameterSensitivity: false, sensitivityVariantLimit: 0 };
    const initial = __testOnly.initialProcessBudgetAllowance(config);
    expect(initial).toMatchObject({ initialBudgetMs: 120_000, grantedBudgetMs: 120_000, maximumBudgetMs: 300_000, extensionCount: 0 });

    const extended = __testOnly.nextMergeTreeBudgetAllowance({ config, allowance: initial, stage: "merge_tree", lastMergeTreeHeartbeatAt: 119_000, now: 120_000, progressTimeoutMs: 45_000 });
    expect(extended).toMatchObject({ grantedBudgetMs: 150_000, maximumBudgetMs: 300_000, extensionCount: 1, lastExtendedAt: 120_000 });
    expect(__testOnly.nextMergeTreeBudgetAllowance({ config, allowance: initial, stage: "merge_tree", lastMergeTreeHeartbeatAt: 109_999, now: 120_000, progressTimeoutMs: 45_000 })).toBeNull();
    expect(__testOnly.nextMergeTreeBudgetAllowance({ config, allowance: initial, stage: "reconstruction", lastMergeTreeHeartbeatAt: 119_000, now: 120_000, progressTimeoutMs: 45_000 })).toBeNull();
  });

  it("never extends advanced studies or exceeds the finite standard merge-tree ceiling", () => {
    const primaryConfig = { runParameterSensitivity: false, sensitivityVariantLimit: 0 };
    const maximum = { initialBudgetMs: 120_000, grantedBudgetMs: 300_000, maximumBudgetMs: 300_000, extensionCount: 6, lastExtendedAt: 270_000 };
    expect(__testOnly.nextMergeTreeBudgetAllowance({ config: primaryConfig, allowance: maximum, stage: "merge_tree", lastMergeTreeHeartbeatAt: 299_000, now: 300_000, progressTimeoutMs: 45_000 })).toBeNull();
    expect(__testOnly.initialProcessBudgetAllowance({ runParameterSensitivity: true, sensitivityVariantLimit: 5 })).toBeNull();
  });

  it("retains an owner-private merge-tree allowance through terminal timing snapshots", () => {
    const store = new AnalysisJobStore(60_000);
    store.create("merge-tree-allowance", ownerId, 1_000, { runParameterSensitivity: false, sensitivityVariantLimit: 0 });
    store.update("merge-tree-allowance", { status: "running", stage: "merge_tree", percent: 58, message: "Scoring merge energy." }, 2_000);
    const allowance = { initialBudgetMs: 120_000, grantedBudgetMs: 150_000, maximumBudgetMs: 300_000, extensionCount: 1, lastExtendedAt: 120_000 };
    expect(store.recordProcessBudgetAllowance("merge-tree-allowance", allowance, 120_000)?.timing?.processBudgetAllowance).toEqual(allowance);
    expect(store.complete("merge-tree-allowance", 140_000)?.timing?.processBudgetAllowance).toEqual(allowance);
  });

  it("retains the first safe failure receipt and refuses stale terminal overwrites", () => {
    const store = new AnalysisJobStore(60_000);
    store.create("failure-receipt", ownerId, 1_000);
    const receipt = { schema: "AnalysisFailure@1" as const, category: "startup_silence" as const, lastSafeStage: "initializing_engine", elapsedMs: 45_000, childSpawned: true, startupHeartbeatObserved: true, engineReadyObserved: false, diagnosticToken: "HIR-failure-receipt" };
    const failed = store.fail("failure-receipt", "The analysis engine stopped reporting progress during engine startup.", 46_000, receipt);
    const staleCompletion = store.complete("failure-receipt", 47_000);
    const staleFailure = store.fail("failure-receipt", "A later process-close error.", 48_000, { ...receipt, category: "engine_exit" });

    expect(failed).toMatchObject({ status: "failed", failureReceipt: receipt });
    expect(staleCompletion).toMatchObject({ status: "failed", failureReceipt: receipt });
    expect(staleFailure).toMatchObject({ status: "failed", failureReceipt: receipt });
  });

  it("restores the owner-scoped durable timing snapshot when no local job remains", async () => {
    const restored = { jobId: "restored-timing", ownerId, status: "completed", stage: "completed", percent: 100, message: "Analysis and private artifact upload completed.", createdAt: 1_000, updatedAt: 9_000, completedAt: 9_000, expiresAt: Date.now() + 60_000, error: null, resultAvailable: true, timing: { schema: "AnalysisTiming@1", totalElapsedMs: 8_000, stages: [{ stage: "feature_extraction", label: "Feature extraction", startedAt: 1_000, endedAt: 9_000, durationMs: 8_000 }], advancedEta: null } };
    getAnalysisManifestMock.mockResolvedValue({ jobId: "restored-timing", ownerId, status: "completed", expiresAt: new Date(Date.now() + 60_000), completedAt: new Date(9_000), error: null, progressSnapshot: JSON.stringify(restored) });

    await expect(getAnalysisJob("restored-timing")).resolves.toMatchObject({ jobId: "restored-timing", ownerId, resultAvailable: true, timing: restored.timing });
  });
});
