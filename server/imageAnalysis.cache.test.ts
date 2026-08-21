import { describe, expect, it } from "vitest";
import { AnalysisResultCache, type AnalysisResult } from "./imageAnalysis";

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
});
