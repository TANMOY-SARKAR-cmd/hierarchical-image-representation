import { describe, expect, it } from "vitest";
import { buildTimingComparisonCsv, buildTimingComparisonJson, type TimingHistoryRecord } from "./TimingHistoryExport";

const records: TimingHistoryRecord[] = [{
  jobId: "private-run-1",
  completedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_600_000,
  image: { width: 640, height: 480 },
  configuration: { segmentationStrategy: "slic", reconstructionProfile: "balanced" },
  processingTimeMs: 4200,
  totalDurationMs: 5100,
  sensitivityVariantCount: 5,
  stages: [{ stage: "segment", label: "Segmentation", durationMs: 1100 }, { stage: "merge", label: "Merge tree", durationMs: 2400 }],
}];

describe("timing comparison exports", () => {
  it("writes stable CSV metadata and stage-duration columns without artifact references", () => {
    const csv = buildTimingComparisonCsv(records);
    expect(csv).toContain('"job_id"');
    expect(csv).toContain('"Segmentation_ms"');
    expect(csv).toContain('"Merge tree_ms"');
    expect(csv).toContain('"private-run-1"');
    expect(csv).not.toContain("artifact");
  });

  it("writes a versioned JSON report that states expiry and discard exclusion", () => {
    const report = JSON.parse(buildTimingComparisonJson(records));
    expect(report.schema).toBe("hir.execution-timing-comparison.v1");
    expect(report.records).toEqual(records);
    expect(report.retention).toContain("Discarded and expired");
  });
});
