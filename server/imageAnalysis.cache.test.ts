import { describe, expect, it } from "vitest";
import { AnalysisJobStore, AnalysisResultCache, type AnalysisResult } from "./imageAnalysis";

function result(jobId: string): AnalysisResult {
  return { jobId, representation: {}, artifactUrls: { representationJson: "", featuresNpz: "", reconstructedPng: "", svg: "", overlays: {}, reconstructions: {}, errors: {} } };
}

describe("AnalysisResultCache", () => {
  it("purges results at the configured TTL on lookup", () => {
    const cache = new AnalysisResultCache(100, 4);
    cache.remember(result("expiring"), 1_000);
    expect(cache.get("expiring", 1_099)?.jobId).toBe("expiring");
    expect(cache.get("expiring", 1_100)).toBeNull();
  });

  it("evicts the oldest retained result when capacity is exceeded", () => {
    const cache = new AnalysisResultCache(10_000, 2);
    cache.remember(result("first"), 1);
    cache.remember(result("second"), 2);
    cache.remember(result("third"), 3);
    expect(cache.get("first", 4)).toBeNull();
    expect(cache.get("second", 4)?.jobId).toBe("second");
    expect(cache.get("third", 4)?.jobId).toBe("third");
  });

  it("reports aggregate retention activity without exposing result identifiers", () => {
    const cache = new AnalysisResultCache(100, 2);
    cache.remember(result("first"), 1_000);
    cache.remember(result("second"), 1_001);
    expect(cache.get("first", 1_002)?.jobId).toBe("first");
    expect(cache.get("missing", 1_003)).toBeNull();
    cache.remember(result("third"), 1_004);
    const telemetry = cache.telemetry(1_050);

    expect(telemetry).toMatchObject({
      scope: "process_local_aggregate",
      activeEntries: 2,
      capacity: 2,
      ttlMs: 100,
      fillRatio: 1,
      writes: 3,
      lookups: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
      capacityEvictions: 1,
      expiredEvictions: 0,
      totalEvictions: 1,
      lastActivityAt: 1_004,
    });
    expect(JSON.stringify(telemetry)).not.toContain("first");
    expect(JSON.stringify(telemetry)).not.toContain("second");
    expect(JSON.stringify(telemetry)).not.toContain("third");
  });

  it("counts expired removals and safely reports zero hit rate before lookups", () => {
    const cache = new AnalysisResultCache(100, 2);
    cache.remember(result("expiring"), 2_000);
    const telemetry = cache.telemetry(2_100);
    expect(telemetry).toMatchObject({ activeEntries: 0, lookups: 0, hitRate: 0, expiredEvictions: 1, totalEvictions: 1 });
  });
});

describe("AnalysisJobStore", () => {
  it("keeps progress monotonic, marks completed results available, and expires terminal jobs", () => {
    const jobs = new AnalysisJobStore(100);
    jobs.create("job-progress", "owner-1", 1_000);
    jobs.update("job-progress", { status: "running", stage: "segmentation", percent: 38, message: "Segmenting." }, 1_010);
    jobs.update("job-progress", { status: "running", stage: "merge_tree", percent: 22, message: "Merging." }, 1_020);
    expect(jobs.get("job-progress", 1_021)).toMatchObject({ ownerId: "owner-1", stage: "merge_tree", percent: 38, resultAvailable: false });
    jobs.complete("job-progress", 1_030);
    expect(jobs.get("job-progress", 1_031)).toMatchObject({ status: "completed", percent: 100, resultAvailable: true, error: null });
    expect(jobs.get("job-progress", 1_130)).toBeNull();
  });
});
