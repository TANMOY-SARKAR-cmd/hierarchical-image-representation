import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { PNG } from "pngjs";
import superjson from "superjson";

const baseUrl = (process.env.HIR_SMOKE_BASE_URL ?? "").replace(/\/$/, "");
if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
  throw new Error("Set HIR_SMOKE_BASE_URL to the public or local workbench origin before running this smoke check.");
}

const runSensitivity = process.env.HIR_SMOKE_SENSITIVITY === "1";
const timeoutMs = Number.parseInt(process.env.HIR_SMOKE_TIMEOUT_MS ?? (runSensitivity ? "480000" : "150000"), 10);
const pollMs = Number.parseInt(process.env.HIR_SMOKE_POLL_MS ?? (runSensitivity ? "75" : "800"), 10);

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
  const observedStages = new Set();
  let advancedEtaObserved = false;
  while (Date.now() - startedAt < timeoutMs) {
    const job = await client.imageAnalysis.status.query({ jobId });
    observedStatuses.add(job.status);
    observedStages.add(job.stage);
    const eta = job.timing?.advancedEta;
    if (runSensitivity && eta && Number.isFinite(eta.minimumRemainingMs) && Number.isFinite(eta.maximumRemainingMs) && eta.minimumRemainingMs >= 0 && eta.minimumRemainingMs <= eta.maximumRemainingMs) advancedEtaObserved = true;
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "expired") {
      return { job, elapsedMs: Date.now() - startedAt, observedStatuses: [...observedStatuses], observedStages: [...observedStages], advancedEtaObserved };
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
    runParameterSensitivity: runSensitivity,
    sensitivityVariantLimit: 5,
  },
};

const client = createAnonymousClient();
const isolatedClient = createAnonymousClient();
const summary = { mode: runSensitivity ? "five_variant_sensitivity" : "primary", terminal: "", elapsedMs: 0, observedStatuses: [], observedStages: [], advancedEtaObserved: false, verification: [], failedAt: "startup" };

try {
  summary.failedAt = "start";
  const started = await client.imageAnalysis.start.mutate(request);
  summary.failedAt = "poll";
  const terminal = await pollForTerminal(client, started.jobId);
  summary.terminal = terminal.job.status;
  summary.elapsedMs = terminal.elapsedMs;
  summary.observedStatuses = terminal.observedStatuses;
  summary.observedStages = terminal.observedStages;
  summary.advancedEtaObserved = terminal.advancedEtaObserved;
  if (terminal.job.status !== "completed" || !terminal.job.resultAvailable) {
    throw new Error("The live job did not produce an available completed result.");
  }

  summary.failedAt = "cross-browser isolation";
  await expectDenied("Cross-browser status", () => isolatedClient.imageAnalysis.status.query({ jobId: started.jobId }));
  summary.verification.push("same-browser completion", "cross-browser denial");

  summary.failedAt = "result";
  const result = await client.imageAnalysis.result.query({ jobId: started.jobId });
  if (runSensitivity) {
    if (!summary.advancedEtaObserved) throw new Error("The advanced smoke job did not expose a bounded ETA range while running.");
    summary.failedAt = "sensitivity report";
    const records = result.representation?.parameterSensitivity?.records;
    if (!Array.isArray(records) || records.length !== 5) {
      throw new Error("The advanced smoke job did not return the expected five-record sensitivity report.");
    }
    summary.verification.push("advanced ETA range", "five-variant sensitivity report");
  }
  summary.failedAt = "execution timeline";
  const executionTiming = result.representation?.executionTiming;
  if (!executionTiming || !Array.isArray(executionTiming.stages) || !Number.isFinite(executionTiming.totalDurationMs) || executionTiming.totalDurationMs < 0 || executionTiming.stages.length < 2 || executionTiming.stages.some(stage => !Number.isFinite(stage.durationMs) || stage.durationMs < 0)) {
    throw new Error("Completed result did not return a valid server-observed execution timeline.");
  }
  if (runSensitivity && !executionTiming.stages.some(stage => stage.stage === "sensitivity")) throw new Error("The advanced timeline did not retain its sensitivity stage.");
  summary.failedAt = "stage-message metadata";
  const stageMessageCount = executionTiming.stages.reduce((count, stage) => count + (Array.isArray(stage.messages) ? stage.messages.length : 0), 0);
  if (!stageMessageCount || executionTiming.stages.some(stage => Array.isArray(stage.messages) && stage.messages.some(entry => typeof entry.message !== "string" || !Number.isFinite(entry.offsetMs) || entry.offsetMs < 0))) {
    throw new Error("Completed timing evidence did not return valid bounded stage-message metadata.");
  }
  summary.verification.push("execution timeline", "stage-message metadata");
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
  console.log(JSON.stringify({ smoke: "failed", mode: summary.mode, terminal: summary.terminal || "unavailable", elapsedMs: summary.elapsedMs, observedStatuses: summary.observedStatuses, observedStages: summary.observedStages, advancedEtaObserved: summary.advancedEtaObserved, verification: summary.verification, failedAt: summary.failedAt }));
  process.exitCode = 1;
}
