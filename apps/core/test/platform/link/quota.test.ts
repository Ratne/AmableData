import { allowAllQuotaGuard, type EmailSendSource } from '@amable/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPlatformQuotaGuard,
  decideQuota,
  loadQuotaSnapshot,
  storeQuotaSnapshot,
} from '../../../src/platform/quota';
import { createHarness, START, type Harness } from '../../helpers/harness';
import { fakeControlPlane, license, type FakeControlPlane } from './helpers';

const automation: EmailSendSource = {
  type: 'automation',
  automationId: 'a',
  versionId: 'v',
  nodeId: 'n',
  stepId: 's',
  enrollmentId: 'e',
};
const broadcast: EmailSendSource = { type: 'broadcast', broadcastId: 'b1' };

let cp: FakeControlPlane | null = null;
afterEach(() => cp?.restore());

async function setup(): Promise<{ h: Harness; cp: FakeControlPlane }> {
  const h = await createHarness();
  license(h.env);
  cp = fakeControlPlane(() => h.clock.now);
  return { h, cp };
}

function guardOf(h: Harness) {
  return createPlatformQuotaGuard(h.env, { now: () => h.clock.now });
}

function check(h: Harness, count: number, source: EmailSendSource) {
  return guardOf(h).check({ tenantId: 't_1', channel: 'email', count, source });
}

const quotaGets = (fake: FakeControlPlane): number =>
  fake.calls.filter((c) => c.path === '/v1/installation/quota').length;

describe('platform quota guard — decisions', () => {
  it('allows sends within the included quota', async () => {
    const { h } = await setup();
    expect(await check(h, 1, automation)).toEqual({ action: 'allow' });
    expect(await check(h, 10_000, broadcast)).toEqual({ action: 'allow' });
  });

  it('denies a 15,000 broadcast with 10,000 included and 1 $ balance, carrying cost and balance', async () => {
    const { h, cp: fake } = await setup();
    fake.balanceMicros = 1_000_000;
    const decision = await check(h, 15_000, broadcast);
    expect(decision.action).toBe('deny');
    expect(decision.action === 'deny' && decision.reason).toBe(
      'insufficient_balance: cost=5000000, balance=1000000',
    );
    // 11,000 → 1 $ overage, covered exactly.
    expect(await check(h, 11_000, broadcast)).toEqual({ action: 'allow' });
  });

  it('pauses automation sends when the wallet cannot cover the overage', async () => {
    const { h, cp: fake } = await setup();
    fake.includedRemaining = 0;
    fake.balanceMicros = 0;
    const decision = await check(h, 1, automation);
    expect(decision).toEqual({
      action: 'pause',
      reason: 'insufficient_balance: cost=1000, balance=0',
      retryAfterMs: 600_000,
    });
    expect((await check(h, 1, { type: 'single', userId: 'u' })).action).toBe('pause');
  });

  it('subtracts local unreported usage from the included quota and the balance', async () => {
    const { h, cp: fake } = await setup();
    fake.includedRemaining = 5;
    fake.balanceMicros = 2_000;
    const guard = guardOf(h);
    await guard.recordUsage?.({ tenantId: 't_1', channel: 'email', count: 6, source: automation });
    // 1 unreported email already beyond the included quota (1,000 µ$): 1,000 µ$ left = 1 email.
    expect(await check(h, 1, automation)).toEqual({ action: 'allow' });
    const second = await check(h, 2, automation);
    expect(second).toMatchObject({ action: 'pause', reason: 'insufficient_balance: cost=2000, balance=1000' });
  });

  it('suspended services: broadcasts denied, automations paused', async () => {
    const { h, cp: fake } = await setup();
    fake.serviceState = 'suspended';
    expect(await check(h, 1, broadcast)).toEqual({ action: 'deny', reason: 'services_suspended' });
    expect(await check(h, 1, automation)).toMatchObject({ action: 'pause', reason: 'services_suspended' });
  });

  it('pauses automation sends at the hourly and daily caps until the next window', async () => {
    const { h, cp: fake } = await setup();
    fake.caps = { hourly: 2, daily: 3 };
    const guard = guardOf(h);
    await guard.recordUsage?.({ tenantId: 't_1', channel: 'email', count: 2, source: automation });
    h.clock.advance(15 * 60_000);
    const hourly = await check(h, 1, automation);
    expect(hourly).toEqual({
      action: 'pause',
      reason: 'hourly_cap_reached: cap=2',
      retryAfterMs: 45 * 60_000,
    });
    // Broadcasts are throttled by the send pipeline, not by the caps here.
    expect(await check(h, 5, broadcast)).toEqual({ action: 'allow' });
    h.clock.advance(60 * 60_000);
    await guard.recordUsage?.({ tenantId: 't_2', channel: 'email', count: 1, source: automation });
    const daily = await check(h, 1, automation);
    expect(daily).toMatchObject({ action: 'pause', reason: 'daily_cap_reached: cap=3' });
    expect(daily.action === 'pause' && daily.retryAfterMs).toBe(Date.UTC(2026, 9, 16) - h.clock.now);
  });

  it('decideQuota is pure and treats a zero overage as allowed even with a negative balance', () => {
    const snapshot = {
      serviceState: 'active' as const,
      includedRemaining: 100,
      includedMonthly: 100,
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      balanceMicros: -5,
      overagePer1000Micros: 1_000_000,
      caps: { hourly: null, daily: null },
      usedThisPeriod: 0,
      issuedAt: '2026-10-15T12:00:00.000Z',
      ttlSeconds: 30,
    };
    const usage = { unreported: 0, thisHour: 0, today: 0 };
    expect(decideQuota(snapshot, usage, { count: 100, source: broadcast }, START)).toEqual({ action: 'allow' });
    expect(decideQuota(snapshot, usage, { count: 101, source: broadcast }, START).action).toBe('deny');
  });

  it('unmetered email (dedicated capacity): no wallet check, suspension and caps still apply', () => {
    const snapshot = {
      serviceState: 'active' as const,
      includedRemaining: 0,
      includedMonthly: 100,
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      balanceMicros: 0,
      overagePer1000Micros: 1_000_000,
      caps: { hourly: 10, daily: null },
      usedThisPeriod: 0,
      issuedAt: '2026-10-15T12:00:00.000Z',
      ttlSeconds: 30,
      emailMetered: false,
    };
    const usage = { unreported: 500, thisHour: 0, today: 0 };
    expect(decideQuota(snapshot, usage, { count: 50_000, source: broadcast }, START)).toEqual({ action: 'allow' });
    expect(decideQuota({ ...snapshot, serviceState: 'suspended' }, usage, { count: 1, source: broadcast }, START).action).toBe('deny');
    expect(decideQuota(snapshot, { ...usage, thisHour: 10 }, { count: 1, source: automation }, START).action).toBe('pause');
  });

  it('exposes the plan rate as the hourly cap per minute, none without a cap', async () => {
    const { h, cp: fake } = await setup();
    expect(await guardOf(h).ratePerMinute?.()).toBeNull();
    fake.caps = { hourly: 40_000, daily: 240_000 };
    h.clock.advance(60_000);
    expect(await guardOf(h).ratePerMinute?.()).toBe(666);
    expect(await allowAllQuotaGuard.ratePerMinute?.()).toBeUndefined();
  });
});

describe('platform quota guard — snapshot cache and outages', () => {
  it('reads through memory (5 s) → D1 (ttl) → control plane', async () => {
    const { h, cp: fake } = await setup();
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('control_plane');
    expect(quotaGets(fake)).toBe(1);
    h.clock.advance(4_000);
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('memory');
    h.clock.advance(6_000);
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('d1');
    expect(quotaGets(fake)).toBe(1);
    h.clock.advance(31_000);
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('control_plane');
    expect(quotaGets(fake)).toBe(2);
  });

  it('honors a longer ttlSeconds from the control plane', async () => {
    const { h, cp: fake } = await setup();
    fake.ttlSeconds = 300;
    await loadQuotaSnapshot(h.env, h.clock.now);
    h.clock.advance(200_000);
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('d1');
    expect(quotaGets(fake)).toBe(1);
  });

  it('uses a stored snapshot up to 24 h old when the control plane is unreachable', async () => {
    const { h, cp: fake } = await setup();
    fake.balanceMicros = 0;
    fake.includedRemaining = 0;
    await storeQuotaSnapshot(h.env.DB, fake.snapshot(), h.clock.now);
    fake.down = true;
    h.clock.advance(2 * 3_600_000);
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('stale');
    expect((await check(h, 1, automation)).action).toBe('pause');
    h.clock.advance(23 * 3_600_000);
    // Older than 24 h and nothing fresh: sending is allowed (our outage, not the customer's).
    expect((await loadQuotaSnapshot(h.env, h.clock.now)).source).toBe('none');
    expect(await check(h, 1, automation)).toEqual({ action: 'allow' });
  });

  it('allows without any snapshot and does not hammer the control plane', async () => {
    const { h, cp: fake } = await setup();
    fake.down = true;
    expect(await check(h, 1_000_000, broadcast)).toEqual({ action: 'allow' });
    expect(await check(h, 1, broadcast)).toEqual({ action: 'allow' });
    expect(quotaGets(fake)).toBe(1);
  });

  it('open source (no license): allow-all, no metering', async () => {
    const h = await createHarness();
    expect(createPlatformQuotaGuard(h.env)).toBe(allowAllQuotaGuard);
  });
});
