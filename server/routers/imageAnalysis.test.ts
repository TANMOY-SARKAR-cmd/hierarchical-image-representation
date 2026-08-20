import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../imageAnalysis", () => ({
  analyzeImage: vi.fn(),
  getAnalysisResult: vi.fn(),
}));

import { analyzeImage, getAnalysisResult } from "../imageAnalysis";
import { imageAnalysisRouter } from "./imageAnalysis";

const baseInput = {
  fileName: "fixture.png",
  mimeType: "image/png" as const,
  dataBase64: "cGxhY2Vob2xkZXI=",
  config: {
    maxFileSizeBytes: 1024 * 1024,
    maxImagePixels: 786432,
    groupingMethod: "slic" as const,
    scaleLevels: [1, 2, 4, 8],
    slicSegments: 72,
    slicCompactness: 10,
    minimumRegionPixels: 12,
    hierarchyGroupSize: 3,
  },
};

describe("imageAnalysis router", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invokes the child-process bridge through a typed valid process request", async () => {
    vi.mocked(analyzeImage).mockResolvedValue({
      jobId: "job-123",
      representation: { version: "1.0.0" },
      artifactUrls: {
        representationJson: "/manus-storage/result.json",
        featuresNpz: "/manus-storage/features.npz",
        reconstructedPng: "/manus-storage/reconstructed.png",
        svg: "/manus-storage/reconstruction.svg",
        overlays: {},
      },
    });
    const caller = imageAnalysisRouter.createCaller({} as never);
    const response = await caller.process(baseInput);

    expect(analyzeImage).toHaveBeenCalledWith(baseInput);
    expect(response.jobId).toBe("job-123");
  });

  it("returns a not-found error for an unavailable in-memory result", async () => {
    vi.mocked(getAnalysisResult).mockReturnValue(null);
    const caller = imageAnalysisRouter.createCaller({} as never);

    await expect(caller.result({ jobId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns individual entity, hierarchy, relationship, and artifact views for a completed result", async () => {
    const completedResult = {
      jobId: "job-123",
      representation: {
        hierarchy: { rootId: "root" },
        pixelLevel: { assignmentKey: "pixelToMicroregion" },
        scaleLevels: [],
        entities: [{ id: "root" }, { id: "region-1" }],
        relationships: [{ sourceId: "root", targetId: "region-1" }],
      },
      artifactUrls: { representationJson: "/result.json", featuresNpz: "/features.npz", reconstructedPng: "/reconstructed.png", svg: "/reconstruction.svg", overlays: {} },
    };
    vi.mocked(getAnalysisResult).mockReturnValue(completedResult);
    const caller = imageAnalysisRouter.createCaller({} as never);

    await expect(caller.entity({ jobId: "job-123", entityId: "region-1" })).resolves.toEqual({ id: "region-1" });
    await expect(caller.hierarchy({ jobId: "job-123" })).resolves.toMatchObject({ hierarchy: { rootId: "root" }, pixelLevel: { assignmentKey: "pixelToMicroregion" } });
    await expect(caller.relationships({ jobId: "job-123", entityId: "region-1" })).resolves.toHaveLength(1);
    await expect(caller.artifacts({ jobId: "job-123" })).resolves.toMatchObject({ svg: "/reconstruction.svg" });
  });
});
