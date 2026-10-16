import { formatLicenseKey, type QuotaSnapshot, type UsageBlock } from '@amable/core/platform';
import { ulid } from 'ulid';
import { overrideControlPlaneFetch } from '../../../src/platform/client';
import type { Env } from '../../../src/env';

export const CP_URL = 'https://cp.test';
export const LICENSE_KEY = formatLicenseKey(ulid(), 'a'.repeat(40));

/** Gives a harness env a license (managed offering) pointing at the fake control plane. */
export function license(env: Env): Env {
  Object.assign(env, { LICENSE_KEY, CONTROL_PLANE_URL: CP_URL });
  return env;
}

export interface FakeControlPlane {
  balanceMicros: number;
  includedRemaining: number;
  serviceState: QuotaSnapshot['serviceState'];
  caps: QuotaSnapshot['caps'];
  ttlSeconds: number;
  /** Network down: every call throws. */
  down: boolean;
  /** Next /usage answers with this status (once). */
  failUsageOnce: number | null;
  /** Block ids the fake answers as accepted (default: all new ones). */
  acceptOnly: ((blockId: string) => boolean) | null;
  readonly calls: { method: string; path: string; auth: string | null; body: unknown }[];
  readonly blocks: Map<string, UsageBlock>;
  snapshot(): QuotaSnapshot;
  routes: Record<string, (body: unknown) => Response | Promise<Response>>;
  restore(): void;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * In-memory control plane answering the installation API: keeps a balance and
 * an included quota, debits reported usage blocks (idempotently by block id).
 */
export function fakeControlPlane(now: () => number): FakeControlPlane {
  const cp: FakeControlPlane = {
    balanceMicros: 0,
    includedRemaining: 10_000,
    serviceState: 'active',
    caps: { hourly: null, daily: null },
    ttlSeconds: 30,
    down: false,
    failUsageOnce: null,
    acceptOnly: null,
    calls: [],
    blocks: new Map(),
    routes: {},
    snapshot: () => ({
      serviceState: cp.serviceState,
      includedRemaining: cp.includedRemaining,
      includedMonthly: 10_000,
      periodStart: new Date(Date.UTC(2026, 9, 1)).toISOString(),
      periodEnd: new Date(Date.UTC(2026, 10, 1)).toISOString(),
      balanceMicros: cp.balanceMicros,
      overagePer1000Micros: 1_000_000,
      caps: cp.caps,
      usedThisPeriod: 0,
      issuedAt: new Date(now()).toISOString(),
      ttlSeconds: cp.ttlSeconds,
    }),
    restore: () => overrideControlPlaneFetch(null),
  };

  overrideControlPlaneFetch(async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body: unknown = raw === null ? null : JSON.parse(raw);
    const auth = new Headers(init?.headers).get('authorization');
    cp.calls.push({ method, path: url.pathname, auth, body });
    if (cp.down) throw new TypeError('fetch failed');
    if (auth !== `Bearer ${LICENSE_KEY}`) return json({ error: 'invalid_license' }, 401);
    const custom = cp.routes[`${method} ${url.pathname}`];
    if (custom !== undefined) return custom(body);
    if (method === 'GET' && url.pathname === '/v1/installation/quota') return json(cp.snapshot());
    if (method === 'POST' && url.pathname === '/v1/installation/usage') {
      if (cp.failUsageOnce !== null) {
        const status = cp.failUsageOnce;
        cp.failUsageOnce = null;
        return json({ error: 'boom' }, status);
      }
      const accepted: string[] = [];
      const duplicates: string[] = [];
      for (const block of (body as { blocks: UsageBlock[] }).blocks) {
        if (cp.blocks.has(block.blockId)) {
          duplicates.push(block.blockId);
          continue;
        }
        if (cp.acceptOnly !== null && !cp.acceptOnly(block.blockId)) continue;
        cp.blocks.set(block.blockId, block);
        accepted.push(block.blockId);
        const included = Math.min(cp.includedRemaining, block.count);
        cp.includedRemaining -= included;
        cp.balanceMicros -= Math.ceil(((block.count - included) * 1_000_000) / 1000);
      }
      return json({ accepted, duplicates, quota: cp.snapshot() });
    }
    if (method === 'POST' && url.pathname === '/v1/installation/heartbeat') {
      return json({
        ok: true,
        installationId: 'inst',
        serviceState: cp.serviceState,
        channel: 'stable',
        targetVersion: '2026.10.2',
        quota: cp.snapshot(),
        reporting: { sampleRate: 0.5, maxBatch: 25 },
      });
    }
    return json({ error: 'not_found' }, 404);
  });
  return cp;
}
