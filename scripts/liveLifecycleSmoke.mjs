import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { PNG } from "pngjs";
import superjson from "superjson";

const baseUrl = (process.env.HIR_SMOKE_BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
  throw new Error("Set HIR_SMOKE_BASE_URL to the public or local workbench origin before running this smoke check.");
}

const timeoutMs = Number.parseInt(process.env.HIR_SMOKE_TIMEOUT_MS ?? "150000", 10);
const pollMs = 800;

function makeFixture() {
  const image = new PNG({ width: 64, height: 48 });
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 4;
      const band = x < 21 ? [225, 55, 60] : x < 43 ? [40, 190, 135] : [45, 105, 235];
      image.data[index] = Math.min(255, band[0] + (y % 4));
      image.data[index + 1] = Math.min(255, band[1] + (x % 3));
      image.data[index + 2] = Math.min(255, band[2] + ((x + y) % 2));
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image).toString("base64");
}

function createAnonymousClient() {
  let visitorCookie = "";
  const fetchWithCookieJar = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (visitorCookie) headers.set("cookie", visitorCookie);
    const response = await fetch(input, { ...init, headers });
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of setCookies) {
      const match = value.match(/(?:^|,)\s*(hir_analysis_visitor=[^;]+)/);
      if (match?.[1]) visitorCookie = match[1];
    }
    return response;
  };
  return createTRPCProxyClient({
    links: [httpBatchLink({ url: `${baseUrl}/api/trpc`, transformer: superjson, fetch: fetchWithCookieJar })],
  });
}

function isNotFound(error) {
  return error instanceof TRPCClientError && error.data?.code === "NOT_FOUND";
}

async function expectDenied(label, operation) {
  try {
    await operation();
  } catch (error) {
    if (isNotFound(error)) return;
  }
  throw new Error(`${label} remained available after logical revocation.`);
}

async function pollForTerminal(client, jobId) {
  const startedAt = Date.now();
  const observedStatuses = new Set();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await client.imageAnalysis.status.query({ jobId });
    observedStatuses.add(job.status);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "expired") {
      return { job, elapsedMs: Date.now() - startedAt, observedStatuses: [...observedStatuses] };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error("The live job did not reach a terminal state before the smoke timeout.");
}

const request = {
  fileName: "generated-smoke-fixture.png",
  mimeType: "image/png",
  dataBase64: makeFixture(),
  config: {
    maxFileSizeBytes: 1_048_576,
    maxImagePixels: 786_432,
    groupingMethod: "slic",
    segmentationStrategy: "slic",
    scaleLevels: [1, 2],
    slicSegments: 24,
    slicCompactness: 8,
    minimumRegionPixels: 2,
    reconstructionProfile: "fast",
    residualEnabled: true,
    residualBudgetBytes: 24 * 1024,
  },
};

const client = createAnonymousClient();
const isolatedClient = createAnonymousClient();
const summary = { terminal: "", elapsedMs: 0, observedStatuses: [], verification: [], failedAt: "startup" };

try {
  summary.failedAt = "start";
  const started = await client.imageAnalysis.start.mutate(request);
  summary.failedAt = "poll";
  const terminal = await pollForTerminal(client, started.jobId);
  summary.terminal = terminal.job.status;
  summary.elapsedMs = terminal.elapsedMs;
  summary.observedStatuses = terminal.observedStatuses;
  if (terminal.job.status !== "completed" || !terminal.job.resultAvailable) {
    throw new Error("The live job did not produce an available completed result.");
  }

  summary.failedAt = "cross-browser isolation";
  await expectDenied("Cross-browser status", () => isolatedClient.imageAnalysis.status.query({ jobId: started.jobId }));
  summary.verification.push("same-browser completion", "cross-browser denial");

  summary.failedAt = "result";
  const result = await client.imageAnalysis.result.query({ jobId: started.jobId });
  const entities = Array.isArray(result.representation?.entities) ? result.representation.entities : [];
  const firstEntity = entities[0];
  const mode = "constant";
  summary.failedAt = "artifact categories";
  const artifacts = await client.imageAnalysis.artifacts.query({ jobId: started.jobId });
  if (!artifacts.reconstructedPng || !artifacts.errors?.byReconstruction?.[mode]) {
    throw new Error("Completed result did not expose the expected artifact categories.");
  }
  summary.failedAt = "exact error sample";
  const localError = await client.imageAnalysis.localError.query({ jobId: started.jobId, mode, x: 0, y: 0 });
  summary.failedAt = "thresholded heatmap";
  const heatmap = await client.imageAnalysis.thresholdedHeatmap.query({ jobId: started.jobId, mode, thresholdDelta: 1 });
  if (!Number.isFinite(localError.meanAbsoluteDeltaRgb) || typeof heatmap.url !== "string") {
    throw new Error("Exact ΔRGB or thresholded heatmap verification did not return a valid response category.");
  }
  summary.verification.push("result", "artifact categories", "exact ΔRGB", "thresholded heatmap");

  summary.failedAt = "discard";
  await client.imageAnalysis.discard.mutate({ jobId: started.jobId });
  const deniedOperations = [
    ["Status", () => client.imageAnalysis.status.query({ jobId: started.jobId })],
    ["Result", () => client.imageAnalysis.result.query({ jobId: started.jobId })],
    ["Artifacts", () => client.imageAnalysis.artifacts.query({ jobId: started.jobId })],
    ["Hierarchy", () => client.imageAnalysis.hierarchy.query({ jobId: started.jobId })],
    ["Relationships", () => client.imageAnalysis.relationships.query({ jobId: started.jobId })],
    ["Exact ΔRGB", () => client.imageAnalysis.localError.query({ jobId: started.jobId, mode, x: 0, y: 0 })],
    ["Thresholded heatmap", () => client.imageAnalysis.thresholdedHeatmap.query({ jobId: started.jobId, mode, thresholdDelta: 1 })],
  ];
  if (firstEntity?.id) deniedOperations.push(["Entity", () => client.imageAnalysis.entity.query({ jobId: started.jobId, entityId: firstEntity.id })]);
  for (const [label, operation] of deniedOperations) {
    summary.failedAt = `post-discard ${label}`;
    await expectDenied(label, operation);
  }
  summary.verification.push("access-only discard denial");

  summary.failedAt = "";
  console.log(JSON.stringify({ smoke: "passed", ...summary }));
} catch {
  console.log(JSON.stringify({ smoke: "failed", terminal: summary.terminal || "unavailable", elapsedMs: summary.elapsedMs, observedStatuses: summary.observedStatuses, verification: summary.verification, failedAt: summary.failedAt }));
  process.exitCode = 1;
}
