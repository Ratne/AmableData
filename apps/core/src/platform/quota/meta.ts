import type { QuotaSnapshot } from '@amable/core/platform';
import { z } from 'zod';

/** `installation_meta` keys owned by the platform link. */
export const META_QUOTA = 'platform:quota';
export const META_REPORTING = 'platform:reporting';
export const META_HEARTBEAT = 'platform:heartbeat';

/**
 * Snapshots come from the control plane: unknown extra fields are stripped (not
 * rejected) so a newer control plane never breaks an older installation.
 */
export const quotaSnapshotSchema = z.object({
  serviceState: z.enum(['trial', 'active', 'grace', 'suspended', 'self_hosted']),
  includedRemaining: z.number().int().min(0),
  includedMonthly: z.number().int().min(0),
  periodStart: z.string(),
  periodEnd: z.string(),
  balanceMicros: z.number().int(),
  overagePer1000Micros: z.number().int().min(0),
  caps: z.object({
    hourly: z.number().int().min(0).nullable(),
    daily: z.number().int().min(0).nullable(),
  }),
  emailMetered: z.boolean().optional(),
  usedThisPeriod: z.number().int().min(0),
  issuedAt: z.string(),
  ttlSeconds: z.number().int().min(0),
});

export function parseQuotaSnapshot(value: unknown): QuotaSnapshot | null {
  const parsed = quotaSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readMeta(db: D1Database, key: string): Promise<unknown> {
  const row = await db
    .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  if (row === null) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

export async function writeMeta(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare(
      `INSERT INTO installation_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, JSON.stringify(value))
    .run();
}
