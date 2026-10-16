import {
  allowAllQuotaGuard,
  type QuotaCheck,
  type QuotaDecision,
  type QuotaGuard,
} from '@amable/core';
import type { QuotaSnapshot } from '@amable/core/platform';
import type { Env } from '../../env';
import { platformLink } from '../license';
import { loadQuotaSnapshot } from './snapshot';

type QuotaUsage = Parameters<NonNullable<QuotaGuard['recordUsage']>>[0];

export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Automation / single sends held by an empty wallet are re-checked after this. */
export const BALANCE_RETRY_MS = 10 * 60_000;

export interface LocalUsage {
  /** Metered sends of the current period not yet accepted by the control plane. */
  readonly unreported: number;
  readonly thisHour: number;
  readonly today: number;
}

export function hourStart(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS;
}

function dayStart(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

export function overageCost(count: number, per1000Micros: number): number {
  return count <= 0 ? 0 : Math.ceil((count * per1000Micros) / 1000);
}

/**
 * Pure decision for `count` messages given the snapshot and the local meter.
 * Local unreported usage first eats the included quota, then the balance; the
 * remainder of the balance must cover the overage of this request.
 */
export function decideQuota(
  snapshot: QuotaSnapshot,
  usage: LocalUsage,
  input: Pick<QuotaCheck, 'count' | 'source'>,
  nowMs: number,
): QuotaDecision {
  const broadcast = input.source.type === 'broadcast';
  if (snapshot.serviceState === 'suspended') {
    return broadcast
      ? { action: 'deny', reason: 'services_suspended' }
      : { action: 'pause', reason: 'services_suspended', retryAfterMs: BALANCE_RETRY_MS };
  }
  if (!broadcast) {
    const { hourly, daily } = snapshot.caps;
    if (hourly !== null && usage.thisHour + input.count > hourly) {
      return {
        action: 'pause',
        reason: `hourly_cap_reached: cap=${String(hourly)}`,
        retryAfterMs: hourStart(nowMs) + HOUR_MS - nowMs,
      };
    }
    if (daily !== null && usage.today + input.count > daily) {
      return {
        action: 'pause',
        reason: `daily_cap_reached: cap=${String(daily)}`,
        retryAfterMs: dayStart(nowMs) + DAY_MS - nowMs,
      };
    }
  }
  const priorExcess = Math.max(usage.unreported - snapshot.includedRemaining, 0);
  const remaining = Math.max(snapshot.includedRemaining - usage.unreported, 0);
  const excess = Math.max(input.count - remaining, 0);
  const balance = snapshot.balanceMicros - overageCost(priorExcess, snapshot.overagePer1000Micros);
  const cost = overageCost(excess, snapshot.overagePer1000Micros);
  if (cost > 0 && cost > balance) {
    const reason = `insufficient_balance: cost=${String(cost)}, balance=${String(Math.max(balance, 0))}`;
    return broadcast
      ? { action: 'deny', reason }
      : { action: 'pause', reason, retryAfterMs: BALANCE_RETRY_MS };
  }
  return { action: 'allow' };
}

export async function localUsage(db: D1Database, snapshot: QuotaSnapshot, nowMs: number): Promise<LocalUsage> {
  const periodStart = Date.parse(snapshot.periodStart);
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN reported_at IS NULL AND hour_start >= ? THEN count END), 0) AS unreported,
         COALESCE(SUM(CASE WHEN hour_start = ? THEN count END), 0) AS this_hour,
         COALESCE(SUM(CASE WHEN hour_start >= ? THEN count END), 0) AS today
       FROM platform_usage WHERE channel = 'email'`,
    )
    .bind(Number.isNaN(periodStart) ? 0 : periodStart, hourStart(nowMs), dayStart(nowMs))
    .first<{ unreported: number; this_hour: number; today: number }>();
  return {
    unreported: row?.unreported ?? 0,
    thisHour: row?.this_hour ?? 0,
    today: row?.today ?? 0,
  };
}

/** Adds `count` sends to the hourly meter (reported later in idempotent blocks). */
export async function recordPlatformUsage(
  db: D1Database,
  usage: Pick<QuotaUsage, 'tenantId' | 'channel' | 'count'>,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO platform_usage (tenant_id, channel, hour_start, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, channel, hour_start) DO UPDATE SET count = count + excluded.count`,
    )
    .bind(usage.tenantId, usage.channel, hourStart(nowMs), usage.count)
    .run();
}

/**
 * QuotaGuard of the managed offering. Open source (no license): allows
 * everything and meters nothing, since no one would ever read the meter.
 * Licensed: decides locally from the cached snapshot; without any snapshot
 * (control plane unreachable, none stored) sending is allowed — our outage must
 * not stop customers' email.
 */
export function createPlatformQuotaGuard(
  env: Env,
  deps: { now?: () => number } = {},
): QuotaGuard {
  if (platformLink(env).mode !== 'licensed') return allowAllQuotaGuard;
  const now = deps.now ?? Date.now;
  return {
    async check(input) {
      const nowMs = now();
      const { snapshot } = await loadQuotaSnapshot(env, nowMs);
      if (snapshot === null) return { action: 'allow' };
      return decideQuota(snapshot, await localUsage(env.DB, snapshot, nowMs), input, nowMs);
    },
    async recordUsage(usage) {
      // Never throws: the message is already sent, a failure here must not trigger a resend.
      try {
        await recordPlatformUsage(env.DB, usage, now());
      } catch (error) {
        console.error('[platform] usage metering failed', error);
      }
    },
  };
}
