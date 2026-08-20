import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { analyzeImage, getAnalysisResult } from "../imageAnalysis";
import { publicProcedure, router } from "../_core/trpc";

const analysisConfig = z.object({
  maxFileSizeBytes: z.number().int().min(256 * 1024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  maxImagePixels: z.number().int().min(64 * 64).max(2_000_000).default(Number(process.env.MAX_IMAGE_PIXELS ?? 786_432)),
  groupingMethod: z.literal("slic").default("slic"),
  scaleLevels: z.array(z.number().int().min(1).max(8)).min(1).max(4).default([1, 2, 4, 8]),
  slicSegments: z.number().int().min(8).max(180).default(72),
  slicCompactness: z.number().min(0.1).max(50).default(10),
  minimumRegionPixels: z.number().int().min(1).max(500).default(12),
  hierarchyGroupSize: z.number().int().min(2).max(8).default(3),
});

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
    .mutation(async ({ input }) => {
      try {
        return await analyzeImage(input);
      } catch (error) {
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
  artifacts: publicProcedure.input(z.object({ jobId: z.string().min(1) })).query(({ input }) => {
    const result = getAnalysisResult(input.jobId);
    if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "This analysis result is no longer available in memory." });
    return result.artifactUrls;
  }),
});
