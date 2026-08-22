import { execFile } from "child_process";
import { promises as fs } from "fs";
import { promisify } from "util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storagePutMock = vi.hoisted(() => vi.fn());

vi.mock("./storage", () => ({ storagePut: storagePutMock }));

import { analyzeImage } from "./imageAnalysis";

const executeFile = promisify(execFile);
const fixturePath = "/tmp/hierarchical-image-fixture.png";
const requestPath = "/tmp/hierarchical-image-request.json";

describe("Node-to-Python image analysis integration", () => {
  const uploadedArtifacts: Array<{ key: string; data: Buffer; contentType: string }> = [];

  beforeEach(async () => {
    uploadedArtifacts.length = 0;
    storagePutMock.mockImplementation(async (key: string, data: Buffer, contentType: string) => {
      uploadedArtifacts.push({ key, data: Buffer.from(data), contentType });
      return { key, url: `/manus-storage/${key}` };
    });
    await executeFile("python3", ["python_engine/create_smoke_request.py"], { cwd: process.cwd() });
  });

  afterEach(async () => {
    await Promise.all([fs.rm(fixturePath, { force: true }), fs.rm(requestPath, { force: true })]);
  });

  it("spawns the real Python engine and exports valid representations", async () => {
    const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as { json: Parameters<typeof analyzeImage>[0] };
    const result = await analyzeImage(request.json);
    const representation = result.representation as {
      pixelLevel: { assignmentKey: string };
      hierarchy: { rootId: string; treeNodeIds: string[]; cuts: Record<string, { nodeIds: string[]; targetNodeCount: number }> };
      entities: unknown[];
      relationships: unknown[];
      metrics: { ssim: number; processingTimeMs: number };
    };

    expect(representation.pixelLevel.assignmentKey).toBe("pixelToMicroregion");
    expect(representation.hierarchy.rootId).toBe("image-root");
    expect(Array.isArray(representation.hierarchy.treeNodeIds)).toBe(true);
    expect(representation.hierarchy.cuts.entity.nodeIds.length).toBeGreaterThan(0);
    expect(representation.entities.length).toBeGreaterThan(4);
    expect(representation.relationships.length).toBeGreaterThan(0);
    expect(representation.metrics.ssim).toBeGreaterThanOrEqual(0);
    expect(representation.metrics.processingTimeMs).toBeGreaterThan(0);

    const jsonArtifact = uploadedArtifacts.find(item => item.contentType === "application/json");
    const npzArtifacts = uploadedArtifacts.filter(item => item.contentType === "application/octet-stream");
    const pngArtifacts = uploadedArtifacts.filter(item => item.contentType === "image/png");
    const svgArtifact = uploadedArtifacts.find(item => item.contentType === "image/svg+xml");
    const uploadedRepresentation = JSON.parse(jsonArtifact?.data.toString("utf8") ?? "{}") as { reconstruction_metadata?: { residual?: { artifactEmitted?: boolean; actualEncodedBytes?: number } } };
    expect(uploadedRepresentation).toMatchObject({ representation_version: "0.7.0", hierarchy: { grouping: "global_energy_scored_4_neighbour_merge_tree_with_derived_cuts", treeNodeIds: expect.any(Array), cuts: { region: expect.any(Object), composite: expect.any(Object), entity: expect.any(Object) } }, reconstruction_metadata: { outputs: { parametric: expect.any(Object), residual: expect.any(Object) }, errorHeatmaps: { schema: "CalibratedAbsoluteRgbErrorHeatmap@0.7", referenceMeanAbsoluteRgbDelta: 32, byReconstruction: { constant: expect.any(Object), parametric: expect.any(Object), residual: expect.any(Object) } }, heuristicRateDistortion: { basis: "parameter_payload_estimate_not_serialized_storage" } }, artifactStorage: { basis: "actual_emitted_file_bytes" } });
    const residualEmitted = Boolean(uploadedRepresentation.reconstruction_metadata?.residual?.artifactEmitted);
    expect(result.artifactUrls.errors.byReconstruction).toMatchObject({ constant: expect.stringContaining("errors/by-reconstruction/constant.png"), parametric: expect.stringContaining("errors/by-reconstruction/parametric.png"), residual: expect.stringContaining("errors/by-reconstruction/residual.png") });
    expect(uploadedArtifacts).toHaveLength(residualEmitted ? 40 : 39);
    expect(npzArtifacts).toHaveLength(residualEmitted ? 2 : 1);
    expect(npzArtifacts.every(item => item.data.subarray(0, 4).toString("latin1") === "PK\u0003\u0004")).toBe(true);
    expect(pngArtifacts).toHaveLength(28);
    expect(pngArtifacts.every(item => item.data.subarray(1, 4).toString("ascii") === "PNG")).toBe(true);
    expect(svgArtifact?.data.toString("utf8").trimStart()).toMatch(/^<svg/);
  }, 120_000);
});
