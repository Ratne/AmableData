import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import {
  addMember,
  createHarness,
  lastEmail,
  login,
  seedTenant,
  seedUser,
  stepUp,
  TEST_PASSWORD,
  tokenFromEmail,
} from './helpers/harness';

afterEach(() => overrideAuthServices(null));

async function setup() {
  const h = await createHarness();
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const admin = await seedUser(h, { email: 'admin@acme.test' });
  await addMember(h, admin.id, acme.id, 'admin');
  const client = await login(h, admin.email);
  return { h, acme, other, admin, client };
}

describe('API keys', () => {
  it('requires a step-up to create one', async () => {
    const { client } = await setup();
    const res = await client.post('/api/t/acme/api-keys', { name: 'n', scopes: ['contacts:read'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('step_up_required');
  });

  it('caps scopes at the creator role and shows the key only once (hash at rest)', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    const tooBroad = await client.post('/api/t/acme/api-keys', {
      name: 'billing',
      scopes: ['contacts:read', 'tenant:billing'],
    });
    expect(tooBroad.status).toBe(403);
    expect(tooBroad.body).toMatchObject({ error: 'scope_exceeds_role', scopes: ['tenant:billing'] });

    const unknownScope = await client.post('/api/t/acme/api-keys', { name: 'x', scopes: ['root:all'] });
    expect(unknownScope.status).toBe(422);

    const created = await client.post('/api/t/acme/api-keys', { name: 'sync', scopes: ['contacts:read'] });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^amb_live_/);
    const listed = await client.get('/api/t/acme/api-keys');
    expect(JSON.stringify(listed.body)).not.toContain(key);
    const row = await h.env.DB.prepare(`SELECT key_hash FROM api_keys`).first<{ key_hash: string }>();
    expect(row?.key_hash).not.toBe(key);
  });

  it('authenticates tenant routes within its scopes, only on its own tenant', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    const created = await client.post('/api/t/acme/api-keys', { name: 'k', scopes: ['audit:read'] });
    const auth = { authorization: `Bearer ${created.body.key as string}`, origin: '' };
    const anon = h.client();

    expect((await anon.get('/api/t/acme/audit', auth)).status).toBe(200);
    // Outside its scopes (admin could, the key cannot).
    expect((await anon.get('/api/t/acme/members', auth)).status).toBe(403);
    // Another tenant: invisible.
    expect((await anon.get('/api/t/other/audit', auth)).status).toBe(404);
    // Account routes never accept API keys.
    expect((await anon.get('/api/me', auth)).status).toBe(401);
    // No CSRF requirement for Bearer calls, but step-up actions are impossible.
    const write = await anon.post('/api/t/acme/api-keys', { name: 'y', scopes: ['audit:read'] }, auth);
    expect(write.status).toBe(403);

    // Revoking needs a session with a fresh step-up, never a key.
    const manager = await client.post('/api/t/acme/api-keys', { name: 'm', scopes: ['api_keys:manage'] });
    const managerAuth = { authorization: `Bearer ${manager.body.key as string}`, origin: '' };
    const byKey = await anon.delete(`/api/t/acme/api-keys/${created.body.id as string}`, managerAuth);
    expect(byKey.status).toBe(403);
    expect(byKey.body.error).toBe('session_required');
    h.clock.advance(10 * 60_000);
    const stale = await client.delete(`/api/t/acme/api-keys/${created.body.id as string}`);
    expect(stale.body.error).toBe('step_up_required');
    await stepUp(h, client);

    // Revocation is immediate.
    await client.delete(`/api/t/acme/api-keys/${created.body.id as string}`);
    expect((await anon.get('/api/t/acme/audit', auth)).status).toBe(401);
  });

  it('shrinks with the creator: a demoted creator caps the key at the new role', async () => {
    const { h, acme, admin, client } = await setup();
    await stepUp(h, client);
    const created = await client.post('/api/t/acme/api-keys', { name: 'k', scopes: ['audit:read'] });
    const auth = { authorization: `Bearer ${created.body.key as string}` };
    await h.env.DB.prepare(`UPDATE memberships SET role = 'viewer' WHERE user_id = ? AND tenant_id = ?`)
      .bind(admin.id, acme.id)
      .run();
    expect((await h.client().get('/api/t/acme/audit', auth)).status).toBe(403);
    await h.env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(admin.id).run();
    expect((await h.client().get('/api/t/acme/audit', auth)).status).toBe(401);
  });

  it('answers 429 with Retry-After, not 401, once a key exceeds its rate limit', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    const created = await client.post('/api/t/acme/api-keys', { name: 'k', scopes: ['audit:read'] });
    const auth = { authorization: `Bearer ${created.body.key as string}` };
    expect((await h.client().get('/api/t/acme/audit', auth)).status).toBe(200);
    await h.env.DB.prepare(`UPDATE rate_limits SET count = 100000 WHERE key LIKE ?`)
      .bind(`%:${created.body.id as string}:%`)
      .run();
    const limited = await h.client().get('/api/t/acme/audit', auth);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rejects malformed and unknown keys', async () => {
    const { h } = await setup();
    const res = await h.client().get('/api/t/acme/audit', { authorization: 'Bearer amb_live_nope' });
    expect(res.status).toBe(401);
  });
});

describe('invites', () => {
  it('revoking an invite needs a session step-up', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    const sent = await client.post('/api/t/acme/invites', { email: 'gone@acme.test', role: 'viewer' });
    const listed = await client.get('/api/t/acme/invites');
    const invite = (listed.body.invites as { id: string; email: string }[]).find((i) => i.email === 'gone@acme.test');
    expect(sent.status).toBe(201);
    h.clock.advance(10 * 60_000);
    const stale = await client.delete(`/api/t/acme/invites/${invite?.id ?? ''}`);
    expect(stale.status).toBe(403);
    expect(stale.body.error).toBe('step_up_required');
    await stepUp(h, client);
    expect((await client.delete(`/api/t/acme/invites/${invite?.id ?? ''}`)).status).toBe(200);
    const token = tokenFromEmail(lastEmail(h, 'gone@acme.test'));
    expect((await h.client().post('/api/invites/peek', { token })).status).toBe(400);
  });

  it('new user: 7-day single-use link, then mandatory 2FA enrollment', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    const sent = await client.post('/api/t/acme/invites', { email: 'New@Acme.test', role: 'marketer' });
    expect(sent.status).toBe(201);
    const email = lastEmail(h, 'new@acme.test');
    expect(email.subject).toMatch(/invited you/);
    const token = tokenFromEmail(email);

    const invitee = h.client();
    const peek = await invitee.post('/api/invites/peek', { token });
    expect(peek.body).toMatchObject({ email: 'new@acme.test', role: 'marketer', accountExists: false });

    h.clock.advance(6 * 24 * 3600_000);
    const accepted = await invitee.post('/api/invites/accept', {
      token,
      name: 'New Person',
      password: 'invitee-password-123',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'mfa_required', enrolled: false, slug: 'acme' });
    expect(accepted.body.methods).toEqual(['enroll_totp', 'enroll_email']);

    // Enrollment with TOTP.
    const setupRes = await invitee.post('/api/auth/challenge/totp-setup');
    const secret = setupRes.body.secret as string;
    expect(setupRes.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const { totpCode } = await import('@amable/auth');
    const done = await invitee.post('/api/auth/challenge/verify', {
      method: 'enroll_totp',
      code: await totpCode(secret, h.clock.now),
    });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect((await invitee.get('/api/t/acme/me')).body.role).toBe('marketer');

    // Single use.
    expect((await h.client().post('/api/invites/accept', { token })).status).toBe(400);
  });

  it('expires after 7 days', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    await client.post('/api/t/acme/invites', { email: 'late@acme.test', role: 'viewer' });
    const token = tokenFromEmail(lastEmail(h, 'late@acme.test'));
    h.clock.advance(7 * 24 * 3600_000);
    expect((await h.client().post('/api/invites/accept', { token })).status).toBe(400);
  });

  it('existing user: must be signed in as the invited address', async () => {
    const { h, other, client } = await setup();
    const existing = await seedUser(h, { email: 'known@acme.test' });
    await addMember(h, existing.id, other.id, 'owner');
    await stepUp(h, client);
    await client.post('/api/t/acme/invites', { email: existing.email, role: 'sales' });
    const token = tokenFromEmail(lastEmail(h, existing.email));

    const anonymous = await h.client().post('/api/invites/accept', { token });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('login_required');

    const session = await login(h, existing.email);
    const joined = await session.post('/api/invites/accept', { token });
    expect(joined.body).toEqual({ status: 'joined', slug: 'acme' });
    expect((await session.get('/api/t/acme/me')).body.role).toBe('sales');
  });

  it('a new account without password can sign in with a magic link + 2FA', async () => {
    const { h, client } = await setup();
    await stepUp(h, client);
    await client.post('/api/t/acme/invites', { email: 'nopw@acme.test', role: 'viewer' });
    const token = tokenFromEmail(lastEmail(h, 'nopw@acme.test'));
    const invitee = h.client();
    await invitee.post('/api/invites/accept', { token });
    await invitee.post('/api/auth/challenge/email-code');
    const code = /(\d{6})/.exec(lastEmail(h, 'nopw@acme.test').text)?.[1] ?? '';
    const done = await invitee.post('/api/auth/challenge/verify', { method: 'enroll_email', code });
    expect(done.status).toBe(200);
    // Password login is impossible (no password set).
    const pw = await h.client().post('/api/auth/login', { email: 'nopw@acme.test', password: TEST_PASSWORD });
    expect(pw.status).toBe(401);
  });
});
