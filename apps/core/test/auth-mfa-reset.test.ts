import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import {
  createHarness,
  lastEmail,
  login,
  seedUser,
  stepUp,
  TEST_PASSWORD,
  TEST_RECOVERY,
  tokenFromEmail,
  type Harness,
  type TestClient,
} from './helpers/harness';

afterEach(() => overrideAuthServices(null));

const DAY = 24 * 60 * 60_000;

async function startLogin(h: Harness, email: string): Promise<TestClient> {
  h.clock.advance(30_000);
  const client = h.client();
  const res = await client.post('/api/auth/login', { email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return client;
}

function codeFrom(h: Harness, to: string): string {
  return /(\d{6})/.exec(lastEmail(h, to).text)?.[1] ?? '';
}

/** Lost-factor request from the sign-in challenge; returns the due time. */
async function requestReset(h: Harness, email: string): Promise<number> {
  const client = await startLogin(h, email);
  expect((await client.post('/api/auth/challenge/mfa-reset/email-code')).status).toBe(200);
  const res = await client.post('/api/auth/challenge/mfa-reset/confirm', { code: codeFrom(h, email) });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('mfa_reset_scheduled');
  return res.body.dueAt as number;
}

async function pendingDueAt(h: Harness, userId: string) {
  const row = await h.env.DB.prepare(`SELECT mfa_reset_due_at AS due FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ due: number | null }>();
  return row?.due ?? null;
}

describe('lost second factor', () => {
  it('offers the recovery to authenticator users only', async () => {
    const h = await createHarness();
    const totp = await seedUser(h, { email: 'totp@example.com' });
    const mail = await seedUser(h, { email: 'mail@example.com', mfa: 'email' });

    const a = await startLogin(h, totp.email);
    expect((await a.get('/api/auth/challenge')).body).toMatchObject({ resetAvailable: true, resetDueAt: null });

    const b = await startLogin(h, mail.email);
    expect((await b.get('/api/auth/challenge')).body.resetAvailable).toBe(false);
    const send = await b.post('/api/auth/challenge/mfa-reset/email-code');
    expect(send.status).toBe(400);
    expect(send.body.error).toBe('method_not_allowed');
  });

  it('schedules the reset in 24 hours, then clears the factor and every session', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'lost@example.com' });
    const other = await login(h, user.email);

    const requestedAt = h.clock.now + 30_000;
    const dueAt = await requestReset(h, user.email);
    expect(dueAt).toBe(requestedAt + DAY);
    const warning = lastEmail(h, user.email);
    expect(warning.subject).toMatch(/will be removed/);
    expect(warning.text).toContain('/auth/mfa-reset/cancel#token=');

    // Before the due time nothing changes: the old factor is still asked.
    h.clock.advance(DAY - 60 * 60_000);
    const early = await startLogin(h, user.email);
    const state = await early.get('/api/auth/challenge');
    expect(state.body).toMatchObject({ enrolled: true, resetDueAt: dueAt });
    expect((await other.get('/api/me')).status).toBe(200);

    // After it, the next sign-in applies the reset and asks for a new factor.
    h.clock.advance(2 * 60 * 60_000);
    const late = await startLogin(h, user.email);
    const enroll = await late.get('/api/auth/challenge');
    expect(enroll.body).toMatchObject({ enrolled: false, methods: ['enroll_totp', 'enroll_email'] });
    expect(lastEmail(h, user.email).subject).toMatch(/was removed/);
    expect((await other.get('/api/me')).status).toBe(401);
    const codes = await h.env.DB.prepare(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?`)
      .bind(user.id)
      .first<{ n: number }>();
    expect(codes?.n).toBe(0);

    expect((await late.post('/api/auth/challenge/email-code')).status).toBe(200);
    const done = await late.post('/api/auth/challenge/verify', {
      method: 'enroll_email',
      code: codeFrom(h, user.email),
    });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
  });

  it('never signs in with the confirmation code, and the verify route refuses the method', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'nosignin@example.com' });
    const client = await startLogin(h, user.email);
    await client.post('/api/auth/challenge/mfa-reset/email-code');
    const code = codeFrom(h, user.email);

    const asLogin = await client.post('/api/auth/challenge/verify', { method: 'email', code });
    expect(asLogin.status).toBe(401);
    expect(asLogin.body.error).toBe('invalid_code');
    const direct = await client.post('/api/auth/challenge/verify', { method: 'reset_email', code });
    expect(direct.status).toBe(422);
    expect(client.cookies.has('__Host-sid')).toBe(false);
  });

  it('shares the 3 attempts of the challenge', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'guess@example.com' });
    const client = await startLogin(h, user.email);
    await client.post('/api/auth/challenge/mfa-reset/email-code');
    await client.post('/api/auth/challenge/mfa-reset/confirm', { code: '000000' });
    await client.post('/api/auth/challenge/mfa-reset/confirm', { code: '000001' });
    const third = await client.post('/api/auth/challenge/mfa-reset/confirm', { code: '000002' });
    expect(third.body.error).toBe('challenge_cancelled');
    expect(await pendingDueAt(h, user.id)).toBeNull();
  });

  it('keeps the due time when asked again', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'again@example.com' });
    const first = await requestReset(h, user.email);
    h.clock.advance(2 * 60 * 60_000);
    expect(await requestReset(h, user.email)).toBe(first);
  });

  it('is cancelled by the email link, once', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'link@example.com' });
    await requestReset(h, user.email);
    const token = tokenFromEmail(lastEmail(h, user.email));

    const client = h.client();
    const res = await client.post('/api/auth/mfa-reset/cancel', { token });
    expect(res.body).toEqual({ ok: true, cancelled: true });
    expect(lastEmail(h, user.email).subject).toMatch(/cancelled/);
    expect((await client.post('/api/auth/mfa-reset/cancel', { token })).status).toBe(400);

    h.clock.advance(DAY + 60_000);
    const later = await startLogin(h, user.email);
    expect((await later.get('/api/auth/challenge')).body.enrolled).toBe(true);
  });

  it('is cancelled by signing in with the old factor, not by an email code', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'found@example.com' });
    await requestReset(h, user.email);

    const viaEmail = await startLogin(h, user.email);
    h.clock.advance(61_000);
    await viaEmail.post('/api/auth/challenge/email-code');
    const signedIn = await viaEmail.post('/api/auth/challenge/verify', {
      method: 'email',
      code: codeFrom(h, user.email),
    });
    expect(signedIn.status).toBe(200);
    expect(await pendingDueAt(h, user.id)).not.toBeNull();

    const viaRecovery = await startLogin(h, user.email);
    const recovered = await viaRecovery.post('/api/auth/challenge/verify', {
      method: 'recovery',
      code: TEST_RECOVERY[0],
    });
    expect(recovered.status).toBe(200);
    expect(await pendingDueAt(h, user.id)).toBeNull();
    expect(lastEmail(h, user.email).subject).toMatch(/cancelled/);
  });

  it('works from the step-up of a live session, shows up in /api/me and is cancelled from Security', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'session@example.com' });
    const client = await login(h, user.email);

    const start = await client.post('/api/auth/step-up/start');
    expect(start.body.resetAvailable).toBe(true);
    expect((await client.post('/api/auth/step-up/mfa-reset/email-code')).status).toBe(200);
    const confirm = await client.post('/api/auth/step-up/mfa-reset/confirm', {
      code: codeFrom(h, user.email),
    });
    expect(confirm.status).toBe(200);

    const me = await client.get('/api/me');
    expect(me.body.mfa).toMatchObject({ method: 'totp', resetDueAt: confirm.body.dueAt });

    const cancel = await client.post('/api/me/2fa/reset/cancel');
    expect(cancel.body).toEqual({ ok: true, cancelled: true });
    expect((await client.get('/api/me')).body.mfa).toMatchObject({ resetDueAt: null });
  });

  it('signs the session out at the step-up once the reset is due', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'due@example.com' });
    const client = await login(h, user.email);
    await requestReset(h, user.email);
    h.clock.advance(DAY + 60_000);

    const start = await client.post('/api/auth/step-up/start');
    expect(start.status).toBe(401);
    expect((await client.get('/api/me')).status).toBe(401);
  });

  it('tells the app how long the step-up holds', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'holds@example.com' });
    const client = await login(h, user.email);
    expect((await client.get('/api/me')).body.stepUpValidUntil).toBeNull();
    await stepUp(h, client);
    const now = h.clock.now;
    expect((await client.get('/api/me')).body.stepUpValidUntil).toBe(now + 5 * 60_000);
    h.clock.advance(5 * 60_000 + 1);
    expect((await client.get('/api/me')).body.stepUpValidUntil).toBeNull();
  });
});
