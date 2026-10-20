import type { EmailSettings, UpdateEmailSettingsInput } from '@amable/api-types';
import { MailError, toIso, type MailDeps, type SendingState } from './context';

/**
 * Tenant email settings (mail_meta key/value), warm-up cap, per-minute rate
 * limit, sending health and automatic suspension.
 */

const DAY_MS = 86_400_000;

/**
 * Daily cap by warm-up day (day 0 = first real send). After the last entry the
 * tenant has no warm-up cap (the control plane still assigns hourly/daily caps).
 */
export const WARMUP_CAPS: readonly number[] = [
  50, 100, 200, 400, 800, 1_500, 3_000, 5_000, 10_000, 20_000, 40_000, 80_000,
];

export const DEFAULT_RATE_PER_MINUTE = 600;

/** Auto-suspension: evaluated over a rolling window once enough mail was sent. */
export const HEALTH_POLICY = {
  windowDays: 7,
  minSent: 100,
  maxBounceRate: 0.05,
  maxComplaintRate: 0.003,
} as const;

type SettingKey =
  | 'from_name'
  | 'from_email'
  | 'reply_to'
  | 'physical_address'
  | 'timezone'
  | 'rate_per_minute'
  | 'warmup_started_at'
  | 'suspended_at'
  | 'suspended_reason';

export function getSetting(deps: MailDeps, key: SettingKey): string | null {
  const row = deps.db.all<{ value: string }>(`SELECT value FROM mail_meta WHERE key = ?`, key)[0];
  return row?.value ?? null;
}

export function setSetting(deps: MailDeps, key: SettingKey, value: string | null): void {
  if (value === null) {
    deps.db.run(`DELETE FROM mail_meta WHERE key = ?`, key);
  } else {
    deps.db.run(
      `INSERT INTO mail_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function tenantTimeZone(deps: MailDeps): string {
  const tz = getSetting(deps, 'timezone');
  return tz !== null && isValidTimeZone(tz) ? tz : 'UTC';
}

/** The plan's rate when the managed offering sets one (`planRate`), else the workspace setting. */
export function ratePerMinute(deps: MailDeps, planRate: number | null = null): number {
  if (planRate !== null) return planRate;
  const value = Number(getSetting(deps, 'rate_per_minute'));
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_RATE_PER_MINUTE;
}

// ------------------------------------------------------------------ counters

const dayBucket = (ms: number): string => `day:${new Date(ms).toISOString().slice(0, 10)}`;
const minuteBucket = (ms: number): string => `min:${String(Math.floor(ms / 60_000))}`;

function counter(deps: MailDeps, bucket: string): number {
  return (
    deps.db.all<{ count: number }>(`SELECT count FROM mail_counters WHERE bucket = ?`, bucket)[0]
      ?.count ?? 0
  );
}

function bump(deps: MailDeps, bucket: string, delta: number): void {
  deps.db.run(
    `INSERT INTO mail_counters (bucket, count) VALUES (?, MAX(?, 0))
     ON CONFLICT(bucket) DO UPDATE SET count = MAX(count + ?, 0)`,
    bucket,
    delta,
    delta,
  );
}

export function sentToday(deps: MailDeps): number {
  return counter(deps, dayBucket(deps.now()));
}

export interface WarmupState {
  readonly startedAt: number | null;
  readonly day: number;
  /** null = no warm-up cap any more. */
  readonly dailyCap: number | null;
}

export function warmupState(deps: MailDeps): WarmupState {
  const started = Number(getSetting(deps, 'warmup_started_at'));
  const startedAt = Number.isFinite(started) && started > 0 ? started : null;
  // Calendar days (UTC), aligned with the daily counter buckets.
  const day =
    startedAt === null ? 0 : Math.max(0, Math.floor(deps.now() / DAY_MS) - Math.floor(startedAt / DAY_MS));
  return { startedAt, day, dailyCap: WARMUP_CAPS[day] ?? null };
}

export type SlotDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'warmup_cap' | 'rate_limit'; readonly retryAfterSeconds: number };

/**
 * Reserves one send slot (daily warm-up cap + per-minute rate). Synchronous so
 * the check and the increment are atomic inside the DO.
 */
/**
 * `ignoreWarmup`: transactional sends still count towards the caps but are never held by them.
 * `planRate`: per-minute rate of the managed plan, overriding the workspace setting.
 */
export function reserveSlot(deps: MailDeps, options: { ignoreWarmup?: boolean; planRate?: number | null } = {}): SlotDecision {
  const now = deps.now();
  const warmup = warmupState(deps);
  if (
    options.ignoreWarmup !== true &&
    warmup.dailyCap !== null &&
    counter(deps, dayBucket(now)) >= warmup.dailyCap
  ) {
    const nextDay = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    return { ok: false, reason: 'warmup_cap', retryAfterSeconds: Math.ceil((nextDay - now) / 1000) + 5 };
  }
  if (counter(deps, minuteBucket(now)) >= ratePerMinute(deps, options.planRate ?? null)) {
    const nextMinute = (Math.floor(now / 60_000) + 1) * 60_000;
    return { ok: false, reason: 'rate_limit', retryAfterSeconds: Math.ceil((nextMinute - now) / 1000) + 1 };
  }
  if (warmup.startedAt === null) setSetting(deps, 'warmup_started_at', String(now));
  bump(deps, dayBucket(now), 1);
  bump(deps, minuteBucket(now), 1);
  return { ok: true };
}

/** Gives a slot back after a failed provider call. */
export function releaseSlot(deps: MailDeps, reservedAt: number): void {
  bump(deps, dayBucket(reservedAt), -1);
  bump(deps, minuteBucket(reservedAt), -1);
}

/** Drops counters older than two days (called opportunistically). */
export function pruneCounters(deps: MailDeps): void {
  const now = deps.now();
  deps.db.run(
    `DELETE FROM mail_counters WHERE bucket LIKE 'min:%' AND CAST(substr(bucket, 5) AS INTEGER) < ?`,
    Math.floor(now / 60_000) - 5,
  );
  deps.db.run(
    `DELETE FROM mail_counters WHERE bucket LIKE 'day:%' AND substr(bucket, 5) < ?`,
    new Date(now - 2 * DAY_MS).toISOString().slice(0, 10),
  );
  deps.db.run(`DELETE FROM mail_webhook_seen WHERE expires_at < ?`, now);
}

// -------------------------------------------------------------- suspension

export interface Suspension {
  readonly suspended: boolean;
  readonly reason: string | null;
  readonly at: number | null;
}

export function suspension(deps: MailDeps): Suspension {
  const at = Number(getSetting(deps, 'suspended_at'));
  return Number.isFinite(at) && at > 0
    ? { suspended: true, reason: getSetting(deps, 'suspended_reason'), at }
    : { suspended: false, reason: null, at: null };
}

export interface SendingHealth {
  readonly sent: number;
  readonly bounced: number;
  readonly complained: number;
  readonly bounceRate: number;
  readonly complaintRate: number;
}

export function sendingHealth(deps: MailDeps): SendingHealth {
  const since = deps.now() - HEALTH_POLICY.windowDays * DAY_MS;
  const row = deps.db.all<{ sent: number; bounced: number; complained: number }>(
    `SELECT COUNT(*) AS sent,
            COALESCE(SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS bounced,
            COALESCE(SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS complained
       FROM mail_messages WHERE sent_at IS NOT NULL AND sent_at >= ? AND source_type != 'test'`,
    since,
  )[0] ?? { sent: 0, bounced: 0, complained: 0 };
  return {
    ...row,
    bounceRate: row.sent === 0 ? 0 : row.bounced / row.sent,
    complaintRate: row.sent === 0 ? 0 : row.complained / row.sent,
  };
}

/** Suspends sending when bounce or complaint rates cross the thresholds. Returns the reason if it did. */
export function evaluateHealth(deps: MailDeps): string | null {
  if (suspension(deps).suspended) return null;
  const health = sendingHealth(deps);
  if (health.sent < HEALTH_POLICY.minSent) return null;
  let reason: string | null = null;
  if (health.bounceRate > HEALTH_POLICY.maxBounceRate) reason = 'bounce_rate';
  else if (health.complaintRate > HEALTH_POLICY.maxComplaintRate) reason = 'complaint_rate';
  if (reason !== null) suspend(deps, reason);
  return reason;
}

export function suspend(deps: MailDeps, reason: string): void {
  setSetting(deps, 'suspended_at', String(deps.now()));
  setSetting(deps, 'suspended_reason', reason);
  deps.db.run(
    `UPDATE mail_broadcasts SET status = 'paused', updated_at = ?
      WHERE status IN ('scheduled', 'sending') AND deleted_at IS NULL`,
    deps.now(),
  );
}

export function resumeSending(deps: MailDeps): void {
  setSetting(deps, 'suspended_at', null);
  setSetting(deps, 'suspended_reason', null);
}

// ---------------------------------------------------------------- can send

export interface SendGate {
  readonly canSend: boolean;
  readonly blockReason: string | null;
}

/** Whether real (non-test) sends are allowed right now. */
export function sendGate(deps: MailDeps, sending: SendingState): SendGate {
  if (suspension(deps).suspended) return { canSend: false, blockReason: 'sending_suspended' };
  if (sending.state === 'unverified') return { canSend: false, blockReason: 'domain_not_verified' };
  const from = getSetting(deps, 'from_email');
  if (from === null) return { canSend: false, blockReason: 'missing_from_email' };
  if (sending.state === 'verified') {
    const domain = from.split('@')[1]?.toLowerCase() ?? '';
    const ok = sending.domains.some(
      (d) =>
        d.kind === 'sending' &&
        d.status === 'verified' &&
        (domain === d.hostname || domain.endsWith(`.${d.hostname}`)),
    );
    if (!ok) return { canSend: false, blockReason: 'from_domain_not_verified' };
  }
  return { canSend: true, blockReason: null };
}

export function fromAddress(deps: MailDeps, fromName: string | null): string {
  const email = getSetting(deps, 'from_email') ?? 'no-reply@localhost';
  const name = (fromName ?? getSetting(deps, 'from_name') ?? '').replace(/["\r\n<>]/g, '').trim();
  return name === '' ? email : `"${name}" <${email}>`;
}

// ----------------------------------------------------------------- API shape

export async function readSettings(deps: MailDeps): Promise<EmailSettings> {
  const sending = await deps.sending();
  const planRate = (await deps.quota.ratePerMinute?.()) ?? null;
  const gate = sendGate(deps, sending);
  const warmup = warmupState(deps);
  const s = suspension(deps);
  const health = sendingHealth(deps);
  return {
    from_name: getSetting(deps, 'from_name'),
    from_email: getSetting(deps, 'from_email'),
    reply_to: getSetting(deps, 'reply_to'),
    physical_address: getSetting(deps, 'physical_address'),
    timezone: tenantTimeZone(deps),
    rate_per_minute: ratePerMinute(deps, planRate),
    rate_managed: planRate !== null,
    rate_dedicated: planRate !== null && ((await deps.quota.dedicatedCapacity?.()) ?? false),
    sending: {
      state: sending.state,
      domains: sending.domains.map((d) => ({ hostname: d.hostname, kind: d.kind, status: d.status })),
      tracking_origin: sending.trackingOrigin,
      can_send: gate.canSend,
      block_reason: gate.blockReason,
    },
    warmup: {
      started_at: toIso(warmup.startedAt),
      day: warmup.day,
      daily_cap: warmup.dailyCap,
      sent_today: sentToday(deps),
    },
    suspension: { suspended: s.suspended, reason: s.reason, at: toIso(s.at) },
    health: {
      window_days: HEALTH_POLICY.windowDays,
      sent: health.sent,
      bounce_rate: health.bounceRate,
      complaint_rate: health.complaintRate,
    },
  };
}

export async function updateSettings(
  deps: MailDeps,
  input: UpdateEmailSettingsInput,
): Promise<EmailSettings> {
  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
    throw new MailError('validation_failed', 422, `unknown timezone ${input.timezone}`);
  }
  if (input.rate_per_minute !== undefined && ((await deps.quota.ratePerMinute?.()) ?? null) !== null) {
    throw new MailError('rate_managed', 422, 'the sending rate is set by your plan');
  }
  deps.db.transaction(() => {
    const text = (key: SettingKey, value: string | null | undefined): void => {
      if (value !== undefined) setSetting(deps, key, value === null || value === '' ? null : value);
    };
    text('from_name', input.from_name);
    text('from_email', input.from_email === undefined ? undefined : (input.from_email?.toLowerCase() ?? null));
    text('reply_to', input.reply_to);
    text('physical_address', input.physical_address);
    text('timezone', input.timezone);
    if (input.rate_per_minute !== undefined) setSetting(deps, 'rate_per_minute', String(input.rate_per_minute));
  });
  return readSettings(deps);
}
