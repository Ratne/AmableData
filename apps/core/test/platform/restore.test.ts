import { generateSigningKeyPair, importSigningKey, signPlatformRequest, CP_SIGNATURE_HEADER } from '@amable/core/platform';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { POINT_IN_TIME_WINDOW_MS } from '../../src/platform/restore';
import { createHarness, ORIGIN, seedTenant, START, type Harness } from '../helpers/harness';

const PATH = '/api/platform/v1/restore';

/** Records every RPC; `failArm` objects reject the bookmark, applying always rejects (abort). */
function namespace(binding: string, calls: string[], failArm: ReadonlySet<string> = new Set()) {
  return {
    idFromName: (name: string) => name,
    get: (tenantId: string) => ({
      pointInTimeArm: (at: number) => {
        calls.push(`${binding}:${tenantId}:arm:${String(at)}`);
        return failArm.has(tenantId) ? Promise.reject(new Error('no history')) : Promise.resolve('bookmark');
      },
      pointInTimeApply: () => {
        calls.push(`${binding}:${tenantId}:apply`);
        return Promise.reject(new Error('Durable Object reset'));
      },
    }),
  };
}

async function setup(): Promise<{ h: Harness; calls: string[]; privateKey: string }> {
  const h = await createHarness();
  const keys = await generateSigningKeyPair();
  const calls: string[] = [];
  Object.assign(h.env, {
    CONTROL_PLANE_PUBLIC_KEY: keys.publicKey,
    TENANT_DB: namespace('tenant_db', calls),
    MAIL_DB: namespace('mail_db', calls, new Set(['t_beta'])),
    ENGINE: namespace('engine', calls),
  });
  return { h, calls, privateKey: keys.privateKey };
}

async function restore(h: Harness, privateKey: string, at: number) {
  const body = JSON.stringify({ at });
  const key = await importSigningKey(privateKey);
  const signature = await signPlatformRequest(key, { method: 'POST', path: PATH, body, nowMs: h.clock.now });
  const res = await app.request(
    `${ORIGIN}${PATH}`,
    { method: 'POST', body, headers: { [CP_SIGNATURE_HEADER]: signature, 'content-type': 'application/json' } },
    h.env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('point-in-time restore of the tenant objects', () => {
  it('arms every object of every tenant first, then restarts them, reporting failures', async () => {
    const { h, calls, privateKey } = await setup();
    await seedTenant(h, 'alpha');
    await seedTenant(h, 'beta');
    const at = START - 60_000;
    const res = await restore(h, privateKey, at);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      tenants: 2,
      objects: 5,
      failed: [{ tenantId: 't_beta', object: 'mail_db', error: 'no history' }],
    });
    const arms = calls.filter((c) => c.includes(':arm:'));
    expect(arms).toHaveLength(6);
    expect(calls.indexOf(arms[5] as string)).toBeLessThan(calls.findIndex((c) => c.endsWith(':apply')));
    expect(calls.filter((c) => c.endsWith(':apply'))).not.toContain('mail_db:t_beta:apply');
  });

  it('refuses instants outside the 30-day history and unsigned calls', async () => {
    const { h, calls, privateKey } = await setup();
    await seedTenant(h, 'alpha');
    expect((await restore(h, privateKey, h.clock.now + 1)).body).toEqual({ error: 'restore_point_out_of_range' });
    expect((await restore(h, privateKey, h.clock.now - POINT_IN_TIME_WINDOW_MS - 1)).body).toEqual({
      error: 'restore_point_out_of_range',
    });
    const unsigned = await app.request(`${ORIGIN}${PATH}`, { method: 'POST', body: '{"at":1}' }, h.env);
    expect(unsigned.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
