import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import {
  createHarness,
  currentTotp,
  lastEmail,
  login,
  seedUser,
  TEST_PASSWORD,
  tokenFromEmail,
} from './helpers/harness';

afterEach(() => overrideAuthServices(null));

const NEW_PASSWORD = 'brand-new-password-42';

describe('password reset (email link only)', () => {
  it('answers identically for known and unknown emails (no enumeration)', async () => {
    const h = await createHarness();
    await seedUser(h, { email: 'known@example.com' });
    const known = await h.client().post('/api/auth/password/forgot', { email: 'known@example.com' });
    const unknown = await h.client().post('/api/auth/password/forgot', { email: 'ghost@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(h.emails.map((e) => e.to)).toEqual(['known@example.com']);
  });

  it('works once within 1 hour, closes every session and does not log in', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'r@example.com' });
    const session = await login(h, user.email);
    expect((await session.get('/api/me')).status).toBe(200);

    await h.client().post('/api/auth/password/forgot', { email: user.email });
    const token = tokenFromEmail(lastEmail(h, user.email));
    h.clock.advance(59 * 60_000);
    const client = h.client();
    const reset = await client.post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect(client.cookies.has('__Host-sid')).toBe(false);

    // Single use.
    const again = await h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_token');

    // Every existing session is closed, a confirmation email went out.
    expect((await session.get('/api/me')).status).toBe(401);
    expect(lastEmail(h, user.email).subject).toMatch(/password was changed/);

    // New password works (and still requires 2FA); the old one does not.
    const old = await h.client().post('/api/auth/login', { email: user.email, password: TEST_PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await h.client().post('/api/auth/login', { email: user.email, password: NEW_PASSWORD });
    expect(fresh.status).toBe(200);
    expect(fresh.body.status).toBe('mfa_required');
  });

  it('expires after 1 hour', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'late@example.com' });
    await h.client().post('/api/auth/password/forgot', { email: user.email });
    const token = tokenFromEmail(lastEmail(h));
    h.clock.advance(60 * 60_000);
    const res = await h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('invalidates older links when a new one is requested', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'twice@example.com' });
    await h.client().post('/api/auth/password/forgot', { email: user.email });
    const first = tokenFromEmail(lastEmail(h));
    await h.client().post('/api/auth/password/forgot', { email: user.email });
    const second = tokenFromEmail(lastEmail(h));
    expect((await h.client().post('/api/auth/password/reset', { token: first, password: NEW_PASSWORD })).status).toBe(400);
    expect((await h.client().post('/api/auth/password/reset', { token: second, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('rejects weak or breached passwords without burning the token', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'weak@example.com' });
    await h.client().post('/api/auth/password/forgot', { email: user.email });
    const token = tokenFromEmail(lastEmail(h));
    const short = await h.client().post('/api/auth/password/reset', { token, password: 'short' });
    expect(short.status).toBe(422);
    expect(short.body.error).toBe('password_too_short');
    const breached = await h.client().post('/api/auth/password/reset', {
      token,
      password: 'correct horse battery',
    });
    expect(breached.body.error).toBe('password_breached');
    const ok = await h.client().post('/api/auth/password/reset', { token, password: NEW_PASSWORD });
    expect(ok.status).toBe(200);
  });
});

describe('magic link', () => {
  it('is single use, expires in 15 minutes and still requires 2FA', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'magic@example.com' });
    const unknown = await h.client().post('/api/auth/magic-link', { email: 'nobody@example.com' });
    const known = await h.client().post('/api/auth/magic-link', { email: user.email });
    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(h.emails).toHaveLength(1);
    const token = tokenFromEmail(lastEmail(h));

    const client = h.client();
    const consumed = await client.post('/api/auth/magic-link/consume', { token });
    expect(consumed.status).toBe(200);
    expect(consumed.body.status).toBe('mfa_required');
    // A TOTP user cannot fall back to an email code after a magic link.
    expect(consumed.body.methods).toEqual(['totp', 'recovery']);
    expect(client.cookies.has('__Host-sid')).toBe(false);

    const reuse = await h.client().post('/api/auth/magic-link/consume', { token });
    expect(reuse.status).toBe(400);

    h.clock.advance(30_000);
    const done = await client.post('/api/auth/challenge/verify', { method: 'totp', code: await currentTotp(h) });
    expect(done.status).toBe(200);
    expect(client.cookies.has('__Host-sid')).toBe(true);
  });

  it('expires after 15 minutes', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'magic2@example.com' });
    await h.client().post('/api/auth/magic-link', { email: user.email });
    const token = tokenFromEmail(lastEmail(h));
    h.clock.advance(15 * 60_000);
    expect((await h.client().post('/api/auth/magic-link/consume', { token })).status).toBe(400);
  });
});
