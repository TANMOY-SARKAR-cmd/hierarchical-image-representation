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
      hierarchy: { rootId: string };
      entities: unknown[];
      relationships: unknown[];
      metrics: { ssim: number; processingTimeMs: number };
    };

    expect(representation.pixelLevel.assignmentKey).toBe("pixelToMicroregion");
    expect(representation.hierarchy.rootId).toBe("image-root");
    expect(representation.entities.length).toBeGreaterThan(4);
    expect(representation.relationships.length).toBeGreaterThan(0);
    expect(representation.metrics.ssim).toBeGreaterThanOrEqual(0);
    expect(representation.metrics.processingTimeMs).toBeGreaterThan(0);
    expect(uploadedArtifacts).toHaveLength(18);

    const jsonArtifact = uploadedArtifacts.find(item => item.contentType === "application/json");
    const npzArtifact = uploadedArtifacts.find(item => item.contentType === "application/octet-stream");
    const pngArtifacts = uploadedArtifacts.filter(item => item.contentType === "image/png");
    const svgArtifact = uploadedArtifacts.find(item => item.contentType === "image/svg+xml");
    expect(JSON.parse(jsonArtifact?.data.toString("utf8") ?? "{}")).toMatchObject({ representation_version: "0.2.0" });
    expect(npzArtifact?.data.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    expect(pngArtifacts).toHaveLength(15);
    expect(pngArtifacts.every(item => item.data.subarray(1, 4).toString("ascii") === "PNG")).toBe(true);
    expect(svgArtifact?.data.toString("utf8").trimStart()).toMatch(/^<svg/);
  }, 120_000);
});
