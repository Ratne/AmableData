import type { HeartbeatRequest, UsageReportRequest } from '@amable/core/platform';
import { installationMigrations, latestSchemaVersion } from '@amable/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHeartbeat } from '../../../src/platform/heartbeat';
import { runPlatformCron } from '../../../src/platform/inbound';
import { recordPlatformUsage, readMeta } from '../../../src/platform/quota';
import { flushUsage, usageBlockId } from '../../../src/platform/usage';
import { createHarness, seedTenant, START, type Harness } from '../../helpers/harness';
import { fakeControlPlane, license, type FakeControlPlane } from './helpers';

const HOUR = 3_600_000;

let cp: FakeControlPlane | null = null;
afterEach(() => cp?.restore());

async function setup(): Promise<{ h: Harness; cp: FakeControlPlane }> {
  const h = await createHarness();
  license(h.env);
  cp = fakeControlPlane(() => h.clock.now);
  return { h, cp };
}

function usageRows(h: Harness) {
  return h.shim.sqlite.prepare(`SELECT tenant_id, hour_start, count, reported_at FROM platform_usage ORDER BY hour_start, tenant_id`).all();
}

const usageCalls = (fake: FakeControlPlane) =>
  fake.calls.filter((c) => c.path === '/v1/installation/usage').map((c) => c.body as UsageReportRequest);

describe('usage metering and idempotent block reports', () => {
  it('meters per tenant and UTC hour, reporting only closed hours with deterministic block ids', async () => {
    const { h, cp: fake } = await setup();
    await recordPlatformUsage(h.env.DB, { tenantId: 't_a', channel: 'email', count: 3 }, START + 60_000);
    await recordPlatformUsage(h.env.DB, { tenantId: 't_a', channel: 'email', count: 1 }, START + 30 * 60_000);
    await recordPlatformUsage(h.env.DB, { tenantId: 't_b', channel: 'email', count: 2 }, START + 10 * 60_000);
    await recordPlatformUsage(h.env.DB, { tenantId: 't_a', channel: 'email', count: 5 }, START + HOUR + 60_000);

    const now = START + HOUR + 10 * 60_000;
    expect(await flushUsage(h.env, now)).toEqual({ reported: 2, pending: 0 });
    const [report] = usageCalls(fake);
    expect(report?.blocks).toEqual([
      { blockId: usageBlockId('t_a', START), tenantId: 't_a', channel: 'email', count: 4, periodStart: '2026-10-15T12:00:00.000Z' },
      { blockId: usageBlockId('t_b', START), tenantId: 't_b', channel: 'email', count: 2, periodStart: '2026-10-15T12:00:00.000Z' },
    ]);
    expect(usageBlockId('t_a', START)).toBe('t_a:email:2026-10-15T12:00:00.000Z');
    expect(usageRows(h)).toEqual([
      { tenant_id: 't_a', hour_start: START, count: 4, reported_at: now },
      { tenant_id: 't_b', hour_start: START, count: 2, reported_at: now },
      { tenant_id: 't_a', hour_start: START + HOUR, count: 5, reported_at: null },
    ]);
    // Nothing closed left: no call.
    expect(await flushUsage(h.env, now + 60_000)).toEqual({ reported: 0, pending: 0 });
    expect(usageCalls(fake)).toHaveLength(1);
    // The returned snapshot is stored for the guard.
    expect(await readMeta(h.env.DB, 'platform:quota')).toMatchObject({ storedAt: now });
  });

  it('keeps blocks unreported on failure and replays the same ids (duplicates are marked too)', async () => {
    const { h, cp: fake } = await setup();
    await recordPlatformUsage(h.env.DB, { tenantId: 't_a', channel: 'email', count: 7 }, START);
    await recordPlatformUsage(h.env.DB, { tenantId: 't_b', channel: 'email', count: 1 }, START);
    const now = START + 2 * HOUR;
    fake.failUsageOnce = 503;
    await expect(flushUsage(h.env, now)).rejects.toThrow();
    expect(usageRows(h).every((r) => (r as { reported_at: unknown }).reported_at === null)).toBe(true);

    // Only t_a accepted: t_b stays pending.
    fake.acceptOnly = (id) => id.startsWith('t_a:');
    expect(await flushUsage(h.env, now)).toEqual({ reported: 1, pending: 1 });
    // The answer for t_a got lost: simulate by clearing reported_at; the replay is a duplicate.
    h.shim.sqlite.prepare(`UPDATE platform_usage SET reported_at = NULL`).run();
    fake.acceptOnly = null;
    expect(await flushUsage(h.env, now)).toEqual({ reported: 2, pending: 0 });
    const ids = usageCalls(fake).map((r) => r.blocks.map((b) => b.blockId));
    expect(ids[0]).toEqual(ids[2]);
    expect(fake.blocks.get('t_a:email:2026-10-15T12:00:00.000Z')?.count).toBe(7);
    expect(fake.blocks.size).toBe(2);
  });

  it('reports at most 100 blocks per call', async () => {
    const { h, cp: fake } = await setup();
    for (let i = 0; i < 120; i += 1) {
      await recordPlatformUsage(h.env.DB, { tenantId: `t_${String(i)}`, channel: 'email', count: 1 }, START);
    }
    expect(await flushUsage(h.env, START + HOUR)).toEqual({ reported: 100, pending: 0 });
    expect(await flushUsage(h.env, START + HOUR)).toEqual({ reported: 20, pending: 0 });
    expect(usageCalls(fake).map((r) => r.blocks.length)).toEqual([100, 20]);
  });
});

describe('heartbeat', () => {
  it('sends version, schema, tenants and pending errors and stores the answer', async () => {
    const { h, cp: fake } = await setup();
    Object.assign(h.env, { APP_VERSION: '2026.10.1' });
    await seedTenant(h, 'acme');
    await seedTenant(h, 'beta');
    h.shim.sqlite
      .prepare(
        `INSERT INTO platform_error_outbox (id, fingerprint, payload, attempts, next_attempt_at, created_at) VALUES ('e1', 'f', '{}', 0, 0, 0)`,
      )
      .run();
    await runPlatformCron(h.env, START);
    const call = fake.calls.find((c) => c.path === '/v1/installation/heartbeat');
    const body = call?.body as HeartbeatRequest;
    expect(body).toEqual({
      version: '2026.10.1',
      schemaVersion: latestSchemaVersion(installationMigrations),
      tenants: 2,
      queueBacklog: null,
      emailFailureRate: null,
      latencyMs: null,
      pendingErrors: 1,
      sentAt: '2026-10-15T12:00:00.000Z',
    });
    expect(await readMeta(h.env.DB, 'platform:reporting')).toEqual({ sampleRate: 0.5, maxBatch: 25 });
    expect(await readMeta(h.env.DB, 'platform:heartbeat')).toEqual({
      at: START,
      serviceState: 'active',
      channel: 'stable',
      targetVersion: '2026.10.2',
    });
    expect(await readMeta(h.env.DB, 'platform:quota')).toMatchObject({ storedAt: START });
  });

  it('defaults the version to dev', async () => {
    const { h } = await setup();
    expect((await buildHeartbeat(h.env, START)).version).toBe('dev');
  });

  it('never throws out of the cron when the control plane is down', async () => {
    const { h, cp: fake } = await setup();
    await recordPlatformUsage(h.env.DB, { tenantId: 't_a', channel: 'email', count: 1 }, START);
    fake.down = true;
    await expect(runPlatformCron(h.env, START + 2 * HOUR)).resolves.toBeUndefined();
    expect(fake.calls.map((c) => c.path)).toEqual(['/v1/installation/usage', '/v1/installation/heartbeat']);
  });

  it('is a no-op without a license', async () => {
    const h = await createHarness();
    cp = fakeControlPlane(() => h.clock.now);
    await runPlatformCron(h.env, START);
    expect(cp.calls).toHaveLength(0);
  });
});
