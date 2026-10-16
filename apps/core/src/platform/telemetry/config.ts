import type { Env } from '../../env';
import { platformLink } from '../license';

/**
 * Where error events go (`ERROR_REPORTING`):
 * - unset / `local` → console only, nothing leaves the installation (open source default);
 * - `control_plane` → the control plane monitor (requires a valid `LICENSE_KEY`, else local);
 * - an `https://…` URL → the operator's own endpoint, same `ErrorBatchRequest` body.
 */
export type ErrorSink =
  | { readonly kind: 'local' }
  | { readonly kind: 'control_plane' }
  | { readonly kind: 'url'; readonly url: string };

export function resolveErrorSink(env: Env): ErrorSink {
  const raw = env.ERROR_REPORTING?.trim() ?? '';
  if (raw === 'control_plane') {
    return platformLink(env).mode === 'licensed' ? { kind: 'control_plane' } : { kind: 'local' };
  }
  if (/^https:\/\/[^\s/]+/i.test(raw)) return { kind: 'url', url: raw };
  return { kind: 'local' };
}

/** Knobs pushed by the control plane in heartbeat responses (`installation_meta`). */
export const REPORTING_META_KEY = 'platform:reporting';
export const DEFAULT_MAX_BATCH = 50;
const MAX_BATCH_CAP = 100;
const KNOBS_TTL_MS = 60_000;

export interface ReportingKnobs {
  readonly sampleRate: number;
  readonly maxBatch: number;
}

let cached: { at: number; db: D1Database; knobs: ReportingKnobs } | null = null;

function clampRate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** `ERROR_SAMPLE_RATE` and the pushed knobs; the stricter sample rate wins. */
export async function reportingKnobs(env: Env, nowMs: number): Promise<ReportingKnobs> {
  if (cached !== null && cached.db === env.DB && nowMs - cached.at < KNOBS_TTL_MS) return cached.knobs;
  const envRate = clampRate(env.ERROR_SAMPLE_RATE === undefined ? undefined : Number(env.ERROR_SAMPLE_RATE));
  let pushedRate: number | null = null;
  let maxBatch = DEFAULT_MAX_BATCH;
  try {
    const row = await env.DB.prepare(`SELECT value FROM installation_meta WHERE key = ?`)
      .bind(REPORTING_META_KEY)
      .first<{ value: string }>();
    if (row !== null) {
      const parsed: unknown = JSON.parse(row.value);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        pushedRate = clampRate(record.sampleRate);
        const batch = record.maxBatch;
        if (typeof batch === 'number' && Number.isInteger(batch) && batch > 0) maxBatch = Math.min(batch, MAX_BATCH_CAP);
      }
    }
  } catch {
    // malformed or missing meta → defaults
  }
  const knobs: ReportingKnobs = { sampleRate: Math.min(envRate ?? 1, pushedRate ?? 1), maxBatch };
  cached = { at: nowMs, db: env.DB, knobs };
  return knobs;
}

/** Test hook. */
export function resetReportingKnobsCache(): void {
  cached = null;
}
