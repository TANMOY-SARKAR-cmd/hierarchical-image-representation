import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { AnalysisAdmissionError, analyzeImage, getAnalysisCacheTelemetry, getAnalysisResult } from "../imageAnalysis";
import { adminProcedure, publicProcedure, router } from "../_core/trpc";

const analysisConfig = z.object({
  maxFileSizeBytes: z.number().int().min(256 * 1024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  maxImagePixels: z.number().int().min(64 * 64).max(2_000_000).default(Number(process.env.MAX_IMAGE_PIXELS ?? 786_432)),
  groupingMethod: z.enum(["slic", "watershed", "felzenszwalb"]).default("slic"),
  segmentationStrategy: z.enum(["slic", "watershed", "felzenszwalb"]).default("slic"),
  hierarchyMethod: z.literal("graph_agglomerative").default("graph_agglomerative"),
  scaleLevels: z.array(z.number().int().min(1).max(8)).min(1).max(4).default([1, 2, 4, 8]),
  slicSegments: z.number().int().min(8).max(180).default(72),
  slicCompactness: z.number().min(0.1).max(50).default(10),
  minimumRegionPixels: z.number().int().min(1).max(500).default(12),
  runScaleConsistency: z.boolean().default(true),
  maxConsistencyPixels: z.number().int().min(64 * 64).max(1_500_000).default(786_432),
  graphK: z.number().int().min(1).max(12).default(3),
  mergeThreshold: z.number().min(0.1).max(0.95).default(0.58),
  edgeBarrierThreshold: z.number().min(0).max(1).default(0.70),
  maxEntityAreaFraction: z.number().min(0.1).max(1).default(0.72),
  complexityMergePenalty: z.number().min(0).max(0.9).default(0.35),
  reconstructionProfile: z.enum(["fast", "balanced", "accurate"]).default("balanced"),
  appearanceModelCandidates: z.array(z.enum(["constant", "affine", "quadratic"])).min(1).max(3).default(["constant", "affine", "quadratic"]),
  modelPenalty: z.number().min(0).max(0.1).default(0.00045),
  boundaryLeakagePenalty: z.number().min(0).max(0.1).default(0.00015),
  residualEnabled: z.boolean().default(true),
  residualQuantization: z.number().int().min(1).max(32).default(4),
  residualBudgetBytes: z.number().int().min(0).max(2_000_000).default(196_608),
  rateDistortionLambda: z.number().min(0).max(1).default(0.0015),
  compareSegmentationBaselines: z.boolean().default(false),
});

function admissionKey(ctx: { user: { id: number } | null; req?: { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } }) {
  if (ctx.user) return `user:${ctx.user.id}`;
  const forwarded = ctx.req?.headers?.["x-forwarded-for"];
  const address = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim() ?? ctx.req?.ip ?? ctx.req?.socket?.remoteAddress ?? "anonymous";
  return `client:${address.slice(0, 128)}`;
}

export const imageAnalysisRouter = router({
  process: publicProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(160),
        mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
        dataBase64: z.string().min(1),
        config: analysisConfig,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await analyzeImage(input, admissionKey(ctx));
      } catch (error) {
        if (error instanceof AnalysisAdmissionError) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Image analysis could not be completed.",
        });
      }
    }),
  result: publicProcedure.input(z.object({ jobId: z.string().min(1) })).query(({ input }) => {
    const result = getAnalysisResult(input.jobId);
    if (!result) {
      throw new TRPCError({ code: "NOT_FOUND", message: "This analysis result is no longer available in memory." });
    }
    return result;
  }),
  entity: publicProcedure.input(z.object({ jobId: z.string().min(1), entityId: z.string().min(1) })).query(({ input }) => {
    const result = getAnalysisResult(input.jobId);
    const entity = (result?.representation.entities as Array<{ id: string }> | undefined)?.find(item => item.id === input.entityId);
    if (!entity) throw new TRPCError({ code: "NOT_FOUND", message: "The requested entity is not available." });
    return entity;
  }),
  hierarchy: publicProcedure.input(z.object({ jobId: z.string().min(1) })).query(({ input }) => {
    const result = getAnalysisResult(input.jobId);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "This analysis result is no longer available in memory." });
    return {
      hierarchy: result.representation.hierarchy,
      pixelLevel: result.representation.pixelLevel,
      entities: result.representation.entities,
      scaleLevels: result.representation.scaleLevels,
    };
  }),
  relationships: publicProcedure.input(z.object({ jobId: z.string().min(1), entityId: z.string().min(1).optional() })).query(({ input }) => {
    const result = getAnalysisResult(input.jobId);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "This analysis result is no longer available in memory." });
    const relationships = result.representation.relationships as Array<{ sourceId: string; targetId: string }>;
    return input.entityId ? relationships.filter(item => item.sourceId === input.entityId || item.targetId === input.entityId) : relationships;
  }),
  cacheTelemetry: adminProcedure.query(() => getAnalysisCacheTelemetry()),
  artifacts: publicProcedure.input(z.object({ jobId: z.string().min(1) })).query(({ input }) => {
    const result = getAnalysisResult(input.jobId);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "This analysis result is no longer available in memory." });
    return result.artifactUrls;
  }),
});
