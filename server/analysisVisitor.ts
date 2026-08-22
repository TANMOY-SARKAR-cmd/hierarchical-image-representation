import { nanoid } from "nanoid";
import type { TrpcContext } from "./_core/context";
import { getSessionCookieOptions } from "./_core/cookies";

export const ANALYSIS_VISITOR_COOKIE = "hir_analysis_visitor";
const VISITOR_TTL_MS = 24 * 60 * 60 * 1000;

function readCookie(header: string | undefined, name: string) {
  if (!header) return null;
  const entry = header.split(";").map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  const value = entry?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{20,80}$/.test(value) ? value : null;
}

export function resolveAnalysisOwner(ctx: TrpcContext) {
  if (ctx.user) return String(ctx.user.id);
  const existing = readCookie(ctx.req?.headers?.cookie, ANALYSIS_VISITOR_COOKIE);
  if (existing) return `visitor:${existing}`;
  const visitorId = nanoid(32);
  if (ctx.req && ctx.res?.cookie) ctx.res.cookie(ANALYSIS_VISITOR_COOKIE, visitorId, { ...getSessionCookieOptions(ctx.req), maxAge: VISITOR_TTL_MS });
  return `visitor:${visitorId}`;
}

export function visitorAdmissionKey(ctx: TrpcContext, ownerId: string) {
  const forwarded = ctx.req?.headers?.["x-forwarded-for"];
  const address = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim() ?? ctx.req?.ip ?? ctx.req?.socket?.remoteAddress ?? "anonymous";
  return `${ownerId}:client:${address.slice(0, 128)}`;
}
