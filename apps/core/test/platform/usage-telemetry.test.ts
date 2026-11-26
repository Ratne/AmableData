import type { TelemetryPing } from '@amable/core/platform';
import { installationMigrations, latestSchemaVersion } from '@amable/db';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_ACTOR } from '../../src/crm/context';
import { runPlatformCron } from '../../src/platform/inbound';
import { tenantUsageCounts } from '../../src/platform/usage-counts';
import {
  applyPortalTelemetry,
  buildUsagePing,
  contactsBucket,
  readTelemetryState,
  runTelemetryPing,
  setLocalTelemetry,
  TELEMETRY_INTERVAL_MS,
  telemetryStatus,
} from '../../src/platform/usage-telemetry';
import { createTestTenant } from '../crm/helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  START,
  type Harness,
} from '../helpers/harness';
import { fakeControlPlane, license, type FakeControlPlane } from './link/helpers';

const URL_DEFAULT = 'https://app.amabledata.com/v1/public/telemetry';
const HOUR = 3_600_000;

function collector(status = 200) {
  const calls: { url: string; headers: Headers; body: TelemetryPing }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as TelemetryPing,
    });
    return new Response('{"ok":true}', { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

async function release(vars: Record<string, string> = {}): Promise<Harness> {
  const h = await createHarness();
  Object.assign(h.env, { APP_VERSION: '2026.11.25', ...vars });
  return h;
}

async function addContacts(h: Harness, tenantId: string, n: number) {
  const stub = h.env.TENANT_DB.get(h.env.TENANT_DB.idFromName(tenantId));
  for (let i = 0; i < n; i += 1) {
    await stub.crm('contacts.create', SYSTEM_ACTOR, { given_name: `Contact ${String(i)}` });
  }
}

function addApp(h: Harness, id: string, tenantId: string, appId: string, source: string, status: string) {
  h.shim.sqlite
    .prepare(
      `INSERT INTO app_installs (id, tenant_id, app_id, source, manifest, manifest_hash, api_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', 'h', '1', ?, 0, 0)`,
    )
    .run(id, tenantId, appId, source, status);
}

let cp: FakeControlPlane | null = null;
afterEach(() => cp?.restore());

describe('usage counts', () => {
  it('counts the live rows of a workspace only', () => {
    const t = createTestTenant();
    const a = t.op('contacts.create', { given_name: 'Ada' });
    t.op('contacts.create', { given_name: 'Bob' });
    t.op('contacts.delete', { id: a.id });
    t.op('pages.create', { title: 'Home', path: '/' });
    expect(tenantUsageCounts(t.db)).toEqual({
      contacts: 1,
      forms: 0,
      pages: 1,
      products: 0,
      bookingCalendars: 0,
    });
  });

  it('reports contacts as a range only', () => {
    expect([0, 1, 100, 101, 1000, 1001, 10_000, 10_001].map(contactsBucket)).toEqual([
      '0',
      '1-100',
      '1-100',
      '101-1k',
      '101-1k',
      '1k-10k',
      '1k-10k',
      '10k+',
    ]);
  });
});

describe('usage ping', () => {
  it('sums the workspaces without anything identifying', async () => {
    const h = await release();
    const acme = await seedTenant(h, 'acme-secret-co');
    const beta = await seedTenant(h, 'beta');
    await seedUser(h, { email: 'owner@acme-secret.example' });
    await addContacts(h, acme.id, 3);
    await addContacts(h, beta.id, 2);
    addApp(h, 'i1', acme.id, 'mapbox', 'catalog', 'active');
    addApp(h, 'i2', beta.id, 'mapbox', 'catalog', 'active');
    addApp(h, 'i3', beta.id, 'zeta', 'catalog', 'pending');
    addApp(h, 'i4', beta.id, 'private-app', 'url', 'active');

    const ping = await buildUsagePing(h.env, 'id-1');
    expect(ping).toEqual({
      anonymousId: 'id-1',
      version: '2026.11.25',
      schemaVersion: latestSchemaVersion(installationMigrations),
      edition: 'open_source',
      counts: {
        tenants: 2,
        users: 1,
        sites: 0,
        funnels: 0,
        forms: 0,
        pages: 0,
        automations: 0,
        products: 0,
        bookingCalendars: 0,
      },
      contactsBucket: '1-100',
      apps: ['mapbox'],
    });
    const text = JSON.stringify(ping);
    for (const secret of ['acme', 'beta', 'example', acme.id, beta.id, 'private-app', 'localhost']) {
      expect(text).not.toContain(secret);
    }
  });

  it('sends once a day, unauthenticated, and retries a failure after an hour', async () => {
    const h = await release();
    const down = collector(503);
    await runTelemetryPing(h.env, START, down.fetcher);
    expect(down.calls).toHaveLength(1);
    const id = down.calls[0]?.body.anonymousId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await runTelemetryPing(h.env, START + HOUR - 1, down.fetcher);
    expect(down.calls).toHaveLength(1);

    const up = collector();
    await runTelemetryPing(h.env, START + HOUR, up.fetcher);
    expect(up.calls).toHaveLength(1);
    const [call] = up.calls;
    expect(call?.url).toBe(URL_DEFAULT);
    expect(call?.headers.get('authorization')).toBeNull();
    expect(call?.body.anonymousId).toBe(id);
    await runTelemetryPing(h.env, START + HOUR + TELEMETRY_INTERVAL_MS - 1, up.fetcher);
    expect(up.calls).toHaveLength(1);
    await runTelemetryPing(h.env, START + HOUR + TELEMETRY_INTERVAL_MS, up.fetcher);
    expect(up.calls).toHaveLength(2);
    expect(up.calls[1]?.body.anonymousId).toBe(id);
    expect((await telemetryStatus(h.env)).lastSentAt).toBe(START + HOUR + TELEMETRY_INTERVAL_MS);
  });

  it('never sends from development builds or with TELEMETRY=off', async () => {
    const cases: Record<string, string>[] = [{ APP_VERSION: 'dev' }, { TELEMETRY: 'off' }, { TELEMETRY: ' OFF ' }];
    for (const vars of cases) {
      const h = await release(vars);
      const c = collector();
      await runTelemetryPing(h.env, START, c.fetcher);
      expect(c.calls).toEqual([]);
    }
    const off = await release({ TELEMETRY: 'off' });
    expect(await telemetryStatus(off.env)).toEqual({ enabled: false, control: 'env_off', lastSentAt: null });
  });

  it('forgets the id when switched off and starts over with a new one', async () => {
    const h = await release();
    const c = collector();
    await runTelemetryPing(h.env, START, c.fetcher);
    const first = c.calls[0]?.body.anonymousId;

    await setLocalTelemetry(h.env, false);
    expect(await readTelemetryState(h.env.DB)).toMatchObject({ enabled: false, anonymousId: null, lastSentAt: 0 });
    await runTelemetryPing(h.env, START + 2 * TELEMETRY_INTERVAL_MS, c.fetcher);
    expect(c.calls).toHaveLength(1);

    await setLocalTelemetry(h.env, true);
    await runTelemetryPing(h.env, START + 2 * TELEMETRY_INTERVAL_MS, c.fetcher);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1]?.body.anonymousId).not.toBe(first);
  });
});

describe('linked installations', () => {
  it('waits for the portal choice delivered by the heartbeat', async () => {
    const h = await release();
    license(h.env);
    cp = fakeControlPlane(() => h.clock.now);
    const c = collector();
    await runTelemetryPing(h.env, START, c.fetcher);
    expect(c.calls).toEqual([]);
    expect(await telemetryStatus(h.env)).toMatchObject({ enabled: false, control: 'portal' });

    const answer = (telemetry: boolean) => {
      cp!.routes['POST /v1/installation/heartbeat'] = () =>
        Response.json({
          ok: true,
          installationId: 'inst',
          serviceState: 'active',
          channel: 'stable',
          targetVersion: null,
          quota: cp!.snapshot(),
          reporting: { sampleRate: 1, maxBatch: 10 },
          telemetry,
        });
    };
    answer(true);
    await runPlatformCron(h.env, START);
    await runTelemetryPing(h.env, START, c.fetcher);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.body.edition).toBe('managed');
    expect(c.calls[0]?.headers.get('authorization')).toBeNull();

    answer(false);
    await runPlatformCron(h.env, START + HOUR);
    expect(await readTelemetryState(h.env.DB)).toMatchObject({ portal: false, anonymousId: null });
    await runTelemetryPing(h.env, START + 2 * TELEMETRY_INTERVAL_MS, c.fetcher);
    expect(c.calls).toHaveLength(1);
  });

  it('labels a self-hosted linked installation', async () => {
    const h = await release();
    license(h.env);
    cp = fakeControlPlane(() => h.clock.now);
    cp.serviceState = 'self_hosted';
    await runPlatformCron(h.env, START);
    await applyPortalTelemetry(h.env.DB, true);
    expect((await buildUsagePing(h.env, 'x')).edition).toBe('self_hosted_licensed');
  });
});

describe('Settings > Operations API', () => {
  async function workspace() {
    const h = await release();
    const tenant = await seedTenant(h, 'acme');
    const owner = await seedUser(h, { email: 'owner@example.com' });
    const admin = await seedUser(h, { email: 'admin@example.com' });
    await addMember(h, owner.id, tenant.id, 'owner');
    await addMember(h, admin.id, tenant.id, 'admin');
    return { h, path: '/api/v2/t/acme/ops/telemetry' };
  }

  it('shows the exact next ping and lets owners switch it off', async () => {
    const { h, path } = await workspace();
    const owner = await login(h, 'owner@example.com');
    const shown = await owner.get(path);
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ enabled: true, control: 'local', can_change: true, last_sent_at: null });
    expect(shown.body['preview']).toMatchObject({ edition: 'open_source', counts: { tenants: 1, users: 2 } });

    const off = await owner.request('PUT', path, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: false });
    const c = collector();
    await runTelemetryPing(h.env, START, c.fetcher);
    expect(c.calls).toEqual([]);
  });

  it('is read-only for admins and for linked installations', async () => {
    const { h, path } = await workspace();
    const admin = await login(h, 'admin@example.com');
    expect((await admin.get(path)).body).toMatchObject({ can_change: false });
    expect((await admin.request('PUT', path, { enabled: false })).status).toBe(403);

    license(h.env);
    const owner = await login(h, 'owner@example.com');
    expect((await owner.get(path)).body).toMatchObject({ control: 'portal', can_change: false });
    expect((await owner.request('PUT', path, { enabled: false })).status).toBe(409);
  });
});
