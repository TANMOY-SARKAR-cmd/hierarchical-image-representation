import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { nanoid } from "nanoid";
import { storagePut } from "./storage";

export type AnalysisConfig = {
  maxFileSizeBytes: number;
  maxImagePixels: number;
  groupingMethod: "slic";
  scaleLevels: number[];
  slicSegments: number;
  slicCompactness: number;
  minimumRegionPixels: number;
  hierarchyGroupSize: number;
  runScaleConsistency: boolean;
  maxConsistencyPixels: number;
};

export type AnalysisArtifactUrls = {
  representationJson: string;
  featuresNpz: string;
  reconstructedPng: string;
  svg: string;
  overlays: Record<string, string>;
  reconstructions: Record<string, string>;
  errors: Record<string, string>;
};

export type AnalysisResult = {
  jobId: string;
  representation: Record<string, unknown>;
  artifactUrls: AnalysisArtifactUrls;
};

const supportedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp"]);
const activeResults = new Map<string, AnalysisResult>();

function safeName(fileName: string) {
  const extension = path.extname(fileName).toLowerCase().replace(".", "");
  if (!supportedExtensions.has(extension)) {
    throw new Error("Supported image formats are PNG, JPEG, and WebP.");
  }
  return extension === "jpg" ? "jpeg" : extension;
}

function runPython(inputPath: string, outputPath: string, config: AnalysisConfig) {
  const scriptPath = path.join(process.cwd(), "python_engine", "representation_engine_v2.py");
  const python = process.env.PYTHON_EXECUTABLE ?? "python3";
  return new Promise<void>((resolve, reject) => {
    const processHandle = spawn(python, [scriptPath, "--input", inputPath, "--output", outputPath, "--config", JSON.stringify(config)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      processHandle.kill("SIGKILL");
      reject(new Error("Image analysis exceeded the 120-second processing limit."));
    }, 120_000);
    processHandle.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    processHandle.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    processHandle.on("error", error => {
      clearTimeout(timeout);
      reject(new Error(`Could not start the Python analysis engine: ${error.message}`));
    });
    processHandle.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`The Python analysis engine failed (${code}): ${stderr.slice(-1200)}`));
        return;
      }
      try {
        const completion = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
        if (!completion.ok) throw new Error("The Python analysis engine returned an invalid completion response.");
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error("The Python analysis engine returned malformed output."));
      }
    });
  });
}

async function uploadArtifact(jobId: string, outputPath: string, relativePath: string, contentType: string) {
  const buffer = await fs.readFile(path.join(outputPath, relativePath));
  const key = `hierarchical-image-representation/${jobId}/${relativePath}`;
  const uploaded = await storagePut(key, buffer, contentType);
  return uploaded.url;
}

export async function analyzeImage(input: {
  fileName: string;
  mimeType: string;
  dataBase64: string;
  config: AnalysisConfig;
}): Promise<AnalysisResult> {
  if (!supportedMimeTypes.has(input.mimeType)) {
    throw new Error("Supported image formats are PNG, JPEG, and WebP.");
  }
  const extension = safeName(input.fileName);
  const data = Buffer.from(input.dataBase64, "base64");
  if (!data.length) throw new Error("The uploaded image is empty.");
  const hardLimit = Number(process.env.MAX_IMAGE_BYTES ?? 8 * 1024 * 1024);
  const allowedSize = Math.min(input.config.maxFileSizeBytes, hardLimit);
  if (data.byteLength > allowedSize) {
    throw new Error(`The uploaded image exceeds the configured ${(allowedSize / 1024 / 1024).toFixed(1)} MB limit.`);
  }

  const jobId = nanoid(14);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hierarchy-analysis-"));
  const inputPath = path.join(workspace, `source.${extension}`);
  const outputPath = path.join(workspace, "output");
  try {
    await fs.mkdir(outputPath, { recursive: true });
    await fs.writeFile(inputPath, data);
    await runPython(inputPath, outputPath, input.config);
    const representation = JSON.parse(await fs.readFile(path.join(outputPath, "representation.json"), "utf8")) as Record<string, unknown>;
    const overlayUrls = {
      brightness: await uploadArtifact(jobId, outputPath, "overlays/brightness.png", "image/png"),
      edgeStrength: await uploadArtifact(jobId, outputPath, "overlays/edge-strength.png", "image/png"),
      gradientX: await uploadArtifact(jobId, outputPath, "overlays/gradient-x.png", "image/png"),
      gradientY: await uploadArtifact(jobId, outputPath, "overlays/gradient-y.png", "image/png"),
      complexity: await uploadArtifact(jobId, outputPath, "overlays/complexity.png", "image/png"),
      relationshipGraph: await uploadArtifact(jobId, outputPath, "overlays/relationship-graph.png", "image/png"),
      normalizedDistanceGraph: await uploadArtifact(jobId, outputPath, "overlays/normalized-distance-graph.png", "image/png"),
    };
    const reconstructions = {
      level1: await uploadArtifact(jobId, outputPath, "reconstructions/level1.png", "image/png"),
      level2: await uploadArtifact(jobId, outputPath, "reconstructions/level2.png", "image/png"),
      level3: await uploadArtifact(jobId, outputPath, "reconstructions/level3.png", "image/png"),
      level4: await uploadArtifact(jobId, outputPath, "reconstructions/level4.png", "image/png"),
      full: await uploadArtifact(jobId, outputPath, "reconstructions/full.png", "image/png"),
    };
    const errors = {
      absolutePixelError: await uploadArtifact(jobId, outputPath, "errors/absolute-error.png", "image/png"),
      perRegionError: await uploadArtifact(jobId, outputPath, "errors/per-region-error.png", "image/png"),
    };
    const artifactUrls: AnalysisArtifactUrls = {
      representationJson: await uploadArtifact(jobId, outputPath, "representation.json", "application/json"),
      featuresNpz: await uploadArtifact(jobId, outputPath, "features.npz", "application/octet-stream"),
      reconstructedPng: await uploadArtifact(jobId, outputPath, "reconstructed.png", "image/png"),
      svg: await uploadArtifact(jobId, outputPath, "reconstruction.svg", "image/svg+xml"),
      overlays: overlayUrls,
      reconstructions,
      errors,
    };
    const result = { jobId, representation, artifactUrls };
    activeResults.set(jobId, result);
    return result;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

export function getAnalysisResult(jobId: string) {
  return activeResults.get(jobId) ?? null;
}
