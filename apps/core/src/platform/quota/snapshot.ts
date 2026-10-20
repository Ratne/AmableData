import type { QuotaSnapshot } from '@amable/core/platform';
import type { Env } from '../../env';
import { controlPlaneClient } from '../client';
import { META_QUOTA, parseQuotaSnapshot, readMeta, writeMeta } from './meta';

/** Isolate memory layer: shields D1 from a read per message. */
export const MEMORY_TTL_MS = 5_000;
export const DEFAULT_SNAPSHOT_TTL_SECONDS = 30;
/** With the control plane unreachable, an older snapshot is still trusted up to this age. */
export const STALE_SNAPSHOT_MAX_AGE_MS = 24 * 3_600_000;

interface StoredSnapshot {
  readonly snapshot: QuotaSnapshot;
  /** Installation clock when the snapshot was received. */
  readonly storedAt: number;
}

const memory = new WeakMap<D1Database, { entry: StoredSnapshot; cachedAt: number }>();
/** Last failed fetch: the control plane is not asked again for MEMORY_TTL_MS. */
const failures = new WeakMap<D1Database, number>();
let lastUnreachableLog = 0;

/** Drops the isolate cache (a fresh snapshot was pushed by the control plane). */
export function dropQuotaMemoryCache(db: D1Database): void {
  memory.delete(db);
  failures.delete(db);
}

export async function storeQuotaSnapshot(
  db: D1Database,
  snapshot: QuotaSnapshot,
  nowMs: number,
): Promise<void> {
  const entry: StoredSnapshot = { snapshot, storedAt: nowMs };
  await writeMeta(db, META_QUOTA, entry);
  memory.set(db, { entry, cachedAt: nowMs });
}

async function readStored(db: D1Database): Promise<StoredSnapshot | null> {
  const raw = await readMeta(db, META_QUOTA);
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as { snapshot?: unknown; storedAt?: unknown };
  const snapshot = parseQuotaSnapshot(value.snapshot);
  if (snapshot === null || typeof value.storedAt !== 'number') return null;
  return { snapshot, storedAt: value.storedAt };
}

/** Last snapshot stored by the installation, whatever its age; never calls the control plane. */
export async function storedQuotaSnapshot(db: D1Database): Promise<QuotaSnapshot | null> {
  return memory.get(db)?.entry.snapshot ?? (await readStored(db))?.snapshot ?? null;
}

function ttlMs(snapshot: QuotaSnapshot): number {
  return (snapshot.ttlSeconds > 0 ? snapshot.ttlSeconds : DEFAULT_SNAPSHOT_TTL_SECONDS) * 1000;
}

export type SnapshotSource = 'memory' | 'd1' | 'control_plane' | 'stale' | 'none';

/**
 * Current quota snapshot, through the layers isolate memory (≤ 5 s) → D1
 * (`installation_meta['platform:quota']`, honoring `ttlSeconds`) →
 * `GET /v1/installation/quota`. With the control plane unreachable the last
 * stored snapshot is used up to 24 h old; with none, `snapshot` is null.
 */
export async function loadQuotaSnapshot(
  env: Env,
  nowMs: number,
): Promise<{ snapshot: QuotaSnapshot | null; source: SnapshotSource }> {
  const cached = memory.get(env.DB);
  if (cached !== undefined && nowMs - cached.cachedAt <= MEMORY_TTL_MS) {
    return { snapshot: cached.entry.snapshot, source: 'memory' };
  }
  const stored = await readStored(env.DB);
  if (stored !== null && nowMs - stored.storedAt <= ttlMs(stored.snapshot)) {
    memory.set(env.DB, { entry: stored, cachedAt: nowMs });
    return { snapshot: stored.snapshot, source: 'd1' };
  }
  const client = controlPlaneClient(env);
  const failedAt = failures.get(env.DB);
  if (client !== null && (failedAt === undefined || nowMs - failedAt > MEMORY_TTL_MS)) {
    try {
      const fresh = parseQuotaSnapshot(await client.get<unknown>('/quota'));
      if (fresh !== null) {
        failures.delete(env.DB);
        await storeQuotaSnapshot(env.DB, fresh, nowMs);
        return { snapshot: fresh, source: 'control_plane' };
      }
    } catch {
      // handled below: stale snapshot or allow
    }
    failures.set(env.DB, nowMs);
  }
  if (nowMs - lastUnreachableLog > 60_000) {
    lastUnreachableLog = nowMs;
    console.warn('[platform] quota snapshot unavailable from the control plane');
  }
  if (stored !== null && nowMs - stored.storedAt <= STALE_SNAPSHOT_MAX_AGE_MS) {
    memory.set(env.DB, { entry: stored, cachedAt: nowMs });
    return { snapshot: stored.snapshot, source: 'stale' };
  }
  return { snapshot: null, source: 'none' };
}
