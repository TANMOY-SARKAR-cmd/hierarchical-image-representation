import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { analysisManifests, InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export type PersistedAnalysisManifest = {
  jobId: string;
  ownerId: string;
  status: "queued" | "running" | "uploading" | "completed" | "failed" | "cancelled" | "discarded" | "expired";
  expiresAt: Date;
  completedAt?: Date | null;
  discardedAt?: Date | null;
  revokedAt?: Date | null;
  revocationReason?: "discarded" | "expired" | null;
  error?: string | null;
  payload?: string | null;
  progressSnapshot?: string | null;
};

export async function saveAnalysisManifest(manifest: PersistedAnalysisManifest): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.insert(analysisManifests).values(manifest).onDuplicateKeyUpdate({
    set: {
      ownerId: manifest.ownerId,
      status: manifest.status,
      expiresAt: manifest.expiresAt,
      completedAt: manifest.completedAt ?? null,
      discardedAt: manifest.discardedAt ?? null,
      revokedAt: manifest.revokedAt ?? null,
      revocationReason: manifest.revocationReason ?? null,
      error: manifest.error ?? null,
      payload: manifest.payload ?? null,
      progressSnapshot: manifest.progressSnapshot ?? null,
    },
  });
}

export async function getAnalysisManifest(jobId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(analysisManifests).where(eq(analysisManifests.jobId, jobId)).limit(1);
  return rows[0] ?? null;
}

export async function discardAnalysisManifest(jobId: string, ownerId: string, now = new Date()): Promise<boolean> {
  return revokeAnalysisManifest(jobId, ownerId, "discarded", now);
}

export async function expireAnalysisManifest(jobId: string, ownerId: string, now = new Date()): Promise<boolean> {
  return revokeAnalysisManifest(jobId, ownerId, "expired", now);
}

async function revokeAnalysisManifest(jobId: string, ownerId: string, reason: "discarded" | "expired", now: Date): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const result = await db.update(analysisManifests).set({
    status: reason,
    payload: null,
    progressSnapshot: null,
    discardedAt: reason === "discarded" ? now : null,
    revokedAt: now,
    revocationReason: reason,
  }).where(and(eq(analysisManifests.jobId, jobId), eq(analysisManifests.ownerId, ownerId)));
  return Number(result[0]?.affectedRows ?? 0) > 0;
}
