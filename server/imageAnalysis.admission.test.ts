import { describe, expect, it } from "vitest";
import { AnalysisAdmissionError, AnalysisSubmissionAdmission, decodeBase64Image, validateImageSignature } from "./imageAnalysis";

describe("public image analysis admission", () => {
  it("accepts only canonical base64 and matching image signatures", () => {
    const png = decodeBase64Image("iVBORw0KGgo=");
    expect(png.length).toBe(8);
    expect(() => validateImageSignature(png, "image/png", "png")).not.toThrow();
    expect(() => decodeBase64Image("not-base64!" )).toThrow(/valid base64/i);
    expect(() => validateImageSignature(png, "image/jpeg", "jpg")).toThrow(/must agree/i);
    expect(() => validateImageSignature(Buffer.from([0xff, 0xd8, 0xff]), "image/png", "png")).toThrow(/must agree/i);
  });

  it("enforces both concurrent capacity and a per-client fixed window", () => {
    const admission = new AnalysisSubmissionAdmission(100, 2, 1);
    admission.acquire("client-a", 0);
    expect(() => admission.acquire("client-b", 1)).toThrow(AnalysisAdmissionError);
    admission.release();
    admission.acquire("client-a", 2);
    admission.release();
    expect(() => admission.acquire("client-a", 3)).toThrow(/quota reached/i);
    admission.acquire("client-a", 101);
    expect(admission.telemetry()).toMatchObject({ inFlight: 1, trackedClients: 1, maxPerWindow: 2, maxInFlight: 1 });
    admission.release();
  });
});
