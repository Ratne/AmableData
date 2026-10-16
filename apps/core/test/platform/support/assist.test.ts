import {
  CP_SIGNATURE_HEADER,
  generateSigningKeyPair,
  importSigningKey,
  signPlatformRequest,
} from '@amable/core/platform';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../../../src/app';
import { sweepAssistGrants } from '../../../src/platform/support';
import { ORIGIN, stepUp, type TestClient } from '../../helpers/harness';
import { assistToken, json, world, type World } from './helpers';

let current: World | null = null;
afterEach(() => current?.cp.restore());

const HOUR = 3_600_000;

async function setup() {
  current = await world();
  current.cp.routes['POST /v1/installation/support/grants'] = () => json({ ok: true });
  return current;
}

async function grant(w: World, body: Record<string, unknown> = { reason: 'Import issue', days: 2 }): Promise<string> {
  await stepUp(w.h, w.owner);
  const res = await w.owner.post('/api/t/acme/platform/assist/grants', body);
  if (res.status !== 201) throw new Error(`grant failed ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body.grant as { id: string }).id;
}

async function enter(w: World, token: string): Promise<{ client: TestClient; status: number; body: Record<string, unknown> }> {
  const client = w.h.client();
  const res = await client.post('/api/platform/assist/enter', { token });
  return { client, status: res.status, body: res.body };
}

function row<T>(w: World, sql: string, ...params: (string | number)[]): T | undefined {
  return w.h.shim.sqlite.prepare(sql).get(...params) as T | undefined;
}

describe('assisted access grants', () => {
  it('only owners and admins can grant, and only after a step-up', async () => {
    const w = await setup();
    const viewer = await w.viewer.post('/api/t/acme/platform/assist/grants', { reason: 'x' });
    expect(viewer.status).toBe(403);
    const noStepUp = await w.admin.post('/api/t/acme/platform/assist/grants', { reason: 'x' });
    expect(noStepUp.body).toEqual({ error: 'step_up_required' });
    await stepUp(w.h, w.admin);
    const byDefault = await w.admin.post('/api/t/acme/platform/assist/grants', { reason: 'Help with automations' });
    expect(byDefault.body.grant).toMatchObject({ expiresAt: w.h.clock.now + 5 * 24 * HOUR });
    const ok = await w.admin.post('/api/t/acme/platform/assist/grants', { reason: 'Help with automations', days: 7 });
    expect(ok.status).toBe(201);
    expect(ok.body.grant).toMatchObject({ state: 'active', mirrored: true, expiresAt: w.h.clock.now + 7 * 24 * HOUR });
    for (const days of [8, 30]) {
      const tooLong = await w.admin.post('/api/t/acme/platform/assist/grants', { reason: 'x', days });
      expect(tooLong.status).toBe(422);
    }
  });

  it('mirrors the grant to the control plane and retries a failed mirror from the sweep', async () => {
    const w = await setup();
    w.cp.down = true;
    const id = await grant(w, { reason: 'Billing question', ticketId: 'tk_1' });
    expect(row<{ mirrored_at: number | null }>(w, `SELECT mirrored_at FROM platform_assist_grants WHERE id = ?`, id)?.mirrored_at).toBeNull();
    w.cp.down = false;
    await sweepAssistGrants(w.h.env, w.h.clock.now);
    const mirror = w.cp.calls.filter((c) => c.path === '/v1/installation/support/grants').at(-1);
    expect(mirror?.json).toMatchObject({
      grantId: id,
      tenantId: w.acme.id,
      tenantSlug: 'acme',
      reason: 'Billing question',
      ticketId: 'tk_1',
      grantedBy: { email: 'owner@acme.test', role: 'owner', tenantId: w.acme.id },
    });
    expect(row<{ mirrored_at: number | null }>(w, `SELECT mirrored_at FROM platform_assist_grants WHERE id = ?`, id)?.mirrored_at).not.toBeNull();
  });
});

describe('assisted access entry', () => {
  it('a valid token opens an admin session in that tenant only, emails the owners once and shows the banner', async () => {
    const w = await setup();
    const gid = await grant(w);
    const first = await enter(w, await assistToken(w, { gid }));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, redirect: '/t/acme/dashboard' });
    expect(first.client.cookies.has('__Host-sid')).toBe(true);

    const me = await first.client.get('/api/t/acme/me');
    expect(me.body).toMatchObject({ role: 'admin' });
    expect((await first.client.get('/api/t/other/me')).status).toBe(404);
    const memberships = w.h.shim.sqlite
      .prepare(`SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email LIKE '%@support.invalid'`)
      .all();
    expect(memberships).toEqual([{ role: 'admin' }]);
    expect(row<{ password_hash: string | null }>(w, `SELECT password_hash FROM users WHERE email LIKE '%@support.invalid'`)?.password_hash).toBeNull();

    const owners = w.h.emails.filter((e) => e.to === 'owner@acme.test' && e.subject.includes('Support'));
    expect(owners).toHaveLength(1);
    expect(owners[0]?.text).toContain('Sam Staff');
    expect(row<{ n: number }>(w, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'support.assist_entered' AND actor_type = 'support'`)?.n).toBe(1);

    const status = await w.viewer.get('/api/t/acme/platform/assist/status');
    expect(status.body).toMatchObject({ available: true, canManage: false, supportSession: false });
    expect(status.body.sessions).toMatchObject([{ staffName: 'Sam Staff', grantId: gid }]);
    const supportStatus = await first.client.get('/api/t/acme/platform/assist/status');
    expect(supportStatus.body).toMatchObject({ supportSession: true, canManage: false });

    // Second entry by another token: no second owner email.
    const second = await enter(w, await assistToken(w, { gid }));
    expect(second.status).toBe(200);
    expect(w.h.emails.filter((e) => e.to === 'owner@acme.test' && e.subject.includes('Support'))).toHaveLength(1);
  });

  it('the support user can never grant access itself (no owner powers, no step-up)', async () => {
    const w = await setup();
    const gid = await grant(w);
    const { client } = await enter(w, await assistToken(w, { gid }));
    expect((await client.post('/api/t/acme/platform/assist/grants', { reason: 'x' })).status).toBe(403);
    expect((await client.get('/api/t/acme/platform/assist/grants')).status).toBe(403);
  });

  it('rejects wrong installation, bad signature, expired, revoked, expired grant, other tenant, reused jti, outliving tokens', async () => {
    const w = await setup();
    const gid = await grant(w);
    const reason = async (token: string) => {
      const res = await enter(w, token);
      expect(res.status).toBe(401);
      return res.body.reason;
    };
    expect(await reason(await assistToken(w, { gid, iid: '01JOTHERINSTALLATION0000000' }))).toBe('wrong_installation');
    const foreign = await generateSigningKeyPair();
    expect(await reason(await assistToken(w, { gid }, foreign.privateKey))).toBe('invalid_signature');
    expect(await reason(await assistToken(w, { gid, tid: w.other.id }))).toBe('unknown_grant');
    expect(await reason(await assistToken(w, { gid: '01JUNKNOWNGRANT00000000000' }))).toBe('unknown_grant');
    expect(await reason('amb_assist.nope.nope')).toBe('invalid_signature');
    expect(await reason('not-a-token-at-all')).toBe('malformed');

    const reused = await assistToken(w, { gid });
    expect((await enter(w, reused)).status).toBe(200);
    expect(await reason(reused)).toBe('token_reused');

    const stale = await assistToken(w, { gid });
    w.h.clock.advance(2 * HOUR + 1000);
    expect(await reason(stale)).toBe('expired');

    // Token longer than the grant.
    const grantExpiry = w.h.clock.now + HOUR;
    w.h.shim.sqlite.prepare(`UPDATE platform_assist_grants SET expires_at = ? WHERE id = ?`).run(grantExpiry, gid);
    expect(await reason(await assistToken(w, { gid }))).toBe('outlives_grant');

    w.h.clock.advance(HOUR + 1000);
    expect(await reason(await assistToken(w, { gid, exp: Math.floor(w.h.clock.now / 1000) + 60 }))).toBe('grant_expired');

    const gid2 = await grant(w);
    expect((await w.owner.delete(`/api/t/acme/platform/assist/grants/${gid2}`)).status).toBe(200);
    expect(await reason(await assistToken(w, { gid: gid2 }))).toBe('grant_revoked');
  });
});

describe('assisted access revoke and expiry', () => {
  it('revoking from the CRM closes the support session immediately and mirrors the revoke', async () => {
    const w = await setup();
    const gid = await grant(w);
    w.cp.routes[`POST /v1/installation/support/grants/${gid}/revoke`] = () => json({ ok: true });
    const { client } = await enter(w, await assistToken(w, { gid }));
    expect((await client.get('/api/t/acme/me')).status).toBe(200);

    const res = await w.admin.delete(`/api/t/acme/platform/assist/grants/${gid}`);
    expect(res.body).toEqual({ ok: true, revoked: true });
    expect((await client.get('/api/t/acme/me')).status).toBe(401);
    expect(w.cp.calls.at(-1)).toMatchObject({ method: 'POST', path: `/v1/installation/support/grants/${gid}/revoke` });
    expect(row<{ n: number }>(w, `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email LIKE '%@support.invalid'`)?.n).toBe(0);
    const list = await w.owner.get('/api/t/acme/platform/assist/grants');
    expect(list.body.grants).toMatchObject([{ id: gid, state: 'revoked' }]);
    expect(list.body.sessions).toMatchObject([{ grantId: gid, active: false }]);
    expect((await w.viewer.get('/api/t/acme/platform/assist/status')).body).toMatchObject({ grants: [], sessions: [] });
  });

  it('queues a failed revoke mirror and retries it from the sweep', async () => {
    const w = await setup();
    const gid = await grant(w);
    w.cp.down = true;
    await w.owner.delete(`/api/t/acme/platform/assist/grants/${gid}`);
    w.cp.down = false;
    w.cp.routes[`POST /v1/installation/support/grants/${gid}/revoke`] = () => json({ ok: true });
    await sweepAssistGrants(w.h.env, w.h.clock.now);
    expect(w.cp.calls.filter((c) => c.path.endsWith('/revoke') && c.auth !== null)).toHaveLength(2);
    expect(row<{ value: string }>(w, `SELECT value FROM installation_meta WHERE key = 'platform:assist_revoke_pending'`)?.value).toBe('[]');
  });

  it('a signed control plane revoke closes the sessions; unsigned calls are rejected', async () => {
    const w = await setup();
    const gid = await grant(w);
    const { client } = await enter(w, await assistToken(w, { gid }));
    const path = '/api/platform/v1/assist/revoke';
    const body = JSON.stringify({ grantId: gid });
    const unsigned = await app.request(`${ORIGIN}${path}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } }, w.h.env);
    expect(unsigned.status).toBe(401);
    expect((await client.get('/api/t/acme/me')).status).toBe(200);

    const signature = await signPlatformRequest(await importSigningKey(w.keys.privateKey), {
      method: 'POST',
      path,
      body,
      nowMs: w.h.clock.now,
    });
    const res = await app.request(
      `${ORIGIN}${path}`,
      { method: 'POST', body, headers: { 'content-type': 'application/json', [CP_SIGNATURE_HEADER]: signature } },
      w.h.env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect((await client.get('/api/t/acme/me')).status).toBe(401);
    expect(row<{ n: number }>(w, `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'support.assist_revoked' AND actor_type = 'support'`)?.n).toBe(1);
  });

  it('sweepAssistGrants expires grants: ends assist sessions and removes the support membership', async () => {
    const w = await setup();
    const gid = await grant(w);
    w.h.shim.sqlite.prepare(`UPDATE platform_assist_grants SET expires_at = ? WHERE id = ?`).run(w.h.clock.now + HOUR, gid);
    const { client } = await enter(w, await assistToken(w, { gid, exp: Math.floor((w.h.clock.now + HOUR) / 1000) }));
    expect((await client.get('/api/t/acme/me')).status).toBe(200);
    w.h.clock.advance(HOUR + 1000);
    await sweepAssistGrants(w.h.env, w.h.clock.now);
    expect(row<{ ended_at: number | null }>(w, `SELECT ended_at FROM platform_assist_sessions WHERE grant_id = ?`, gid)?.ended_at).toBe(w.h.clock.now);
    expect(row<{ n: number }>(w, `SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email LIKE '%@support.invalid'`)?.n).toBe(0);
    expect((await client.get('/api/t/acme/me')).status).toBe(401);
    expect((await w.viewer.get('/api/t/acme/platform/assist/status')).body).toMatchObject({ grants: [], sessions: [] });
  });
});
