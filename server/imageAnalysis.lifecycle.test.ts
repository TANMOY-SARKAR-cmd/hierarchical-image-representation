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

import { __testOnly, getAnalysisJob } from "./imageAnalysis";

describe("durable analysis lifecycle guard", () => {
  const ownerId = "visitor:test-browser-workspace";

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly.clearActiveJob("stale-discarded");
    __testOnly.clearActiveJob("stale-expired");
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
});
