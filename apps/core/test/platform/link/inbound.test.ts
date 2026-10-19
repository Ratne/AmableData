import {
  CP_SIGNATURE_HEADER,
  generateSigningKeyPair,
  importSigningKey,
  signPlatformRequest,
  type ResumeEmailRequest,
} from '@amable/core/platform';
import type { EmailSendRequest } from '@amable/core';
import { installationMigrations, latestSchemaVersion } from '@amable/db';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationEngine } from '../../../src/automation/engine';
import { engineMigrations } from '../../../src/automation/migrations';
import { runAutomationOp } from '../../../src/automation/ops';
import { ENGINE_ACTOR } from '../../../src/automation/ports';
import { runCrmOp, type CrmResult } from '../../../src/crm/ops';
import type { Env } from '../../../src/env';
import { createPlatformQuotaGuard } from '../../../src/platform/quota';
import { edge, goal, graph, seq, tagStep } from '../../automation/helpers';
import { createNodeSqlDb, createTestTenant } from '../../crm/helpers';
import { app } from '../../../src/app';
import { createHarness, ORIGIN, seedTenant, type Harness } from '../../helpers/harness';
import { fakeControlPlane, license, type FakeControlPlane } from './helpers';

const PATH = '/api/platform/v1/resume-email';

let cp: FakeControlPlane | null = null;
afterEach(() => cp?.restore());

async function signed(
  privateKey: string,
  body: string,
  nowMs: number,
  path = PATH,
): Promise<Record<string, string>> {
  const key = await importSigningKey(privateKey);
  return {
    [CP_SIGNATURE_HEADER]: await signPlatformRequest(key, { method: 'POST', path, body, nowMs }),
    'content-type': 'application/json',
  };
}

async function post(
  h: Harness,
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const res = await app.request(`${ORIGIN}${path}`, { method: 'POST', headers, body }, h.env);
  return { status: res.status, body: await res.json() };
}

/** The CRM-side automation engine of one tenant, using the real platform quota guard. */
function tenantEngine(h: Harness, tenantId: string) {
  const tenant = createTestTenant();
  const clock = tenant.clock;
  const db = createNodeSqlDb();
  for (const migration of engineMigrations) {
    for (const statement of migration.statements) db.raw.exec(statement);
  }
  const emails: EmailSendRequest[] = [];
  const nextId = monotonicFactory();
  const engine = new AutomationEngine(db, {
    tenantId,
    crm: {
      call: (op: string, input: unknown): Promise<CrmResult<unknown>> =>
        Promise.resolve(
          structuredClone(
            runCrmOp({ db: tenant.db, searchMode: tenant.mode, now: () => clock.now }, ENGINE_ACTOR, op, structuredClone(input)),
          ),
        ),
    },
    email: {
      send: (message) => {
        emails.push(message);
        return Promise.resolve();
      },
    },
    quota: createPlatformQuotaGuard(h.env, { now: () => h.clock.now }),
    fetch: () => Promise.resolve(new Response('ok')),
    alarm: { set: () => Promise.resolve() },
    now: () => clock.now,
    newId: () => nextId(clock.now),
  });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
      await engine.drainOutbox();
      if ((await engine.runDue()) === 0) return;
    }
  };
  return { tenant, engine, db, emails, flush };
}

function engineNamespace(engines: Map<string, AutomationEngine>, calls: string[]): Env['ENGINE'] {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      resumeEmailSteps: (tenantId: string) => {
        calls.push(tenantId);
        const engine = engines.get(tenantId);
        if (engine === undefined) return Promise.reject(new Error('engine: tenant not bound'));
        return engine.resumePaused();
      },
      id,
    }),
  } as unknown as Env['ENGINE'];
}

describe('signed resume-email: end-to-end pause → top-up → resume', () => {
  it('pauses an automation email at zero balance and resumes it after a signed top-up', async () => {
    const h = await createHarness();
    license(h.env);
    const keys = await generateSigningKeyPair();
    Object.assign(h.env, { CONTROL_PLANE_PUBLIC_KEY: keys.publicKey });
    cp = fakeControlPlane(() => h.clock.now);
    cp.includedRemaining = 0;
    cp.balanceMicros = 0;

    const acme = await seedTenant(h, 'acme');
    await seedTenant(h, 'other');
    const t = tenantEngine(h, acme.id);
    const calls: string[] = [];
    Object.assign(h.env, { ENGINE: engineNamespace(new Map([[acme.id, t.engine]]), calls) });

    const go = t.tenant.op('tags.create', { name: 'Go' }).id;
    const after = t.tenant.op('tags.create', { name: 'After' }).id;
    const op = async (name: string, input: unknown) => {
      const result = await runAutomationOp(t.db, t.engine, { userId: 'user_1' }, name, input);
      if (!result.ok) throw new Error(result.error.message);
      return result.value as { id: string };
    };
    const created = await op('automations.create', {
      name: 'Welcome',
      graph: graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [go] }]),
          seq('s', [{ id: 'mail', type: 'send_email', template_id: 'tpl_1' }, tagStep('x', after)]),
        ],
        [edge('g', 's')],
      ),
      settings: {},
    });
    await op('automations.publish', { id: created.id });
    const ada = t.tenant.op('contacts.create', { given_name: 'Ada', emails: [{ email: 'ada@example.com' }] }).id;
    t.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [go] } });
    await t.flush();
    expect(t.emails).toHaveLength(0);
    expect(t.db.all(`SELECT status FROM eng_tokens`)).toEqual([{ status: 'paused' }]);

    // Top-up on the control plane, then the signed push with the fresh snapshot.
    cp.balanceMicros = 10_000_000;
    const request: ResumeEmailRequest = { reason: 'top_up', quota: cp.snapshot() };
    const body = JSON.stringify(request);
    const res = await post(h, PATH, body, await signed(keys.privateKey, body, h.clock.now));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tenants: 2, resumed: 1 });
    expect(calls.sort()).toEqual([acme.id, 't_other'].sort());

    await t.flush();
    expect(t.emails).toHaveLength(1);
    expect(t.emails[0]).toMatchObject({ contactId: ada, source: { type: 'automation', stepId: 'mail' } });
    // The guard decided from the pushed snapshot (stored in D1), without asking the control plane.
    expect(cp.calls.filter((c) => c.path === '/v1/installation/quota')).toHaveLength(1);
  });
});

describe('signed control plane routes', () => {
  async function setup() {
    const h = await createHarness();
    const keys = await generateSigningKeyPair();
    Object.assign(h.env, { CONTROL_PLANE_PUBLIC_KEY: keys.publicKey });
    const calls: string[] = [];
    Object.assign(h.env, { ENGINE: engineNamespace(new Map(), calls) });
    cp = fakeControlPlane(() => h.clock.now);
    const body = JSON.stringify({ reason: 'manual', quota: cp.snapshot() } satisfies ResumeEmailRequest);
    return { h, keys, body, calls };
  }

  it('rejects unsigned, expired and foreign-key signatures with 401 invalid_signature', async () => {
    const { h, keys, body, calls } = await setup();
    const unsigned = await post(h, PATH, body, { 'content-type': 'application/json' });
    expect(unsigned.status).toBe(401);
    expect(unsigned.body).toEqual({ error: 'invalid_signature' });

    const expired = await post(h, PATH, body, await signed(keys.privateKey, body, h.clock.now - 10 * 60_000));
    expect(expired.status).toBe(401);

    const other = await generateSigningKeyPair();
    const foreign = await post(h, PATH, body, await signed(other.privateKey, body, h.clock.now));
    expect(foreign.status).toBe(401);

    const tampered = await post(h, PATH, body.replace('manual', 'top_up'), await signed(keys.privateKey, body, h.clock.now));
    expect(tampered.status).toBe(401);

    const wrongPath = await post(h, PATH, body, await signed(keys.privateKey, body, h.clock.now, '/api/platform/v1/status'));
    expect(wrongPath.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects everything when no public key is configured outside dev', async () => {
    const { h, keys, body } = await setup();
    Object.assign(h.env, { CONTROL_PLANE_PUBLIC_KEY: undefined });
    const res = await post(h, PATH, body, await signed(keys.privateKey, body, h.clock.now));
    expect(res.status).toBe(401);
  });

  it('validates the signed body strictly', async () => {
    const { h, keys } = await setup();
    const bad = JSON.stringify({ reason: 'top_up', quota: { nope: true } });
    const res = await post(h, PATH, bad, await signed(keys.privateKey, bad, h.clock.now));
    expect(res.status).toBe(422);
  });

  it('is not blocked by the CSRF check (cross-origin, no CSRF header) and stores the snapshot', async () => {
    const { h, keys, body } = await setup();
    const headers = {
      ...(await signed(keys.privateKey, body, h.clock.now)),
      origin: 'https://app.amabledata.com',
      'x-amable-csrf': '',
    };
    const res = await post(h, PATH, body, headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tenants: 0, resumed: 0 });
    const row = h.shim.sqlite.prepare(`SELECT value FROM installation_meta WHERE key = 'platform:quota'`).get() as
      | { value: string }
      | undefined;
    expect(JSON.parse(row?.value ?? 'null')).toMatchObject({ storedAt: h.clock.now, snapshot: { serviceState: 'active' } });
  });

  it('answers a signed status probe', async () => {
    const { h, keys } = await setup();
    license(h.env);
    const res = await post(h, '/api/platform/v1/status', '{}', await signed(keys.privateKey, '{}', h.clock.now, '/api/platform/v1/status'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, licensed: true, version: 'dev', schemaVersion: latestSchemaVersion(installationMigrations) });
  });

  it('bootstraps the first workspace and owner invitation once, never after a sign-up', async () => {
    const { h, keys } = await setup();
    license(h.env);
    const path = '/api/platform/v1/bootstrap-owner';
    const call = async () => {
      const body = JSON.stringify({ email: 'Owner@Example.com', workspaceName: 'ZZZ Srl', locale: 'it' });
      return post(h, path, body, await signed(keys.privateKey, body, h.clock.now, path));
    };
    const unsigned = await post(h, path, '{}', { 'content-type': 'application/json' });
    expect(unsigned.status).toBe(401);

    const first = await call();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, status: 'invited', workspace: 'ZZZ Srl' });
    expect(String((first.body as { url: string }).url)).toMatch(new RegExp(`^${ORIGIN}/invite#token=`));
    const second = await call();
    expect((second.body as { url: string }).url).not.toBe((first.body as { url: string }).url);
    const tenants = h.shim.sqlite.prepare(`SELECT slug, name FROM tenants`).all();
    expect(tenants).toEqual([{ slug: 'zzz-srl', name: 'ZZZ Srl' }]);
    const pending = h.shim.sqlite
      .prepare(`SELECT email, role, locale FROM invites WHERE accepted_at IS NULL AND revoked_at IS NULL`)
      .all();
    expect(pending).toEqual([{ email: 'owner@example.com', role: 'owner', locale: 'it' }]);

    h.shim.sqlite
      .prepare(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'someone@example.com', 0, 0)`)
      .run();
    expect((await call()).body).toEqual({ ok: true, status: 'has_users' });
  });
});
