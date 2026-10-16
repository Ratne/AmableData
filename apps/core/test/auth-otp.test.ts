import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import {
  createHarness,
  currentTotp,
  seedUser,
  TEST_PASSWORD,
  TEST_RECOVERY,
  type Harness,
  type TestClient,
} from './helpers/harness';

afterEach(() => overrideAuthServices(null));

async function startLogin(h: Harness, email: string): Promise<TestClient> {
  const client = h.client();
  const res = await client.post('/api/auth/login', { email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('mfa_required');
  return client;
}

async function failChallenge(h: Harness, email: string) {
  const client = await startLogin(h, email);
  for (let i = 0; i < 3; i += 1) {
    await client.post('/api/auth/challenge/verify', { method: 'totp', code: '000000' });
  }
  return client;
}

describe('second factor: 3 attempts per challenge', () => {
  it('cancels the challenge at the 3rd wrong code, even if a correct code follows', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'otp@example.com' });
    const client = await startLogin(h, user.email);

    const first = await client.post('/api/auth/challenge/verify', { method: 'totp', code: '111111' });
    expect(first.status).toBe(401);
    expect(first.body).toMatchObject({ error: 'invalid_code', attemptsLeft: 2 });
    const second = await client.post('/api/auth/challenge/verify', { method: 'totp', code: '222222' });
    expect(second.body).toMatchObject({ error: 'invalid_code', attemptsLeft: 1 });
    const third = await client.post('/api/auth/challenge/verify', { method: 'totp', code: '333333' });
    expect(third.status).toBe(401);
    expect(third.body.error).toBe('challenge_cancelled');

    // A correct code afterwards is useless: the challenge is gone, back to login.
    const late = await client.post('/api/auth/challenge/verify', {
      method: 'totp',
      code: await currentTotp(h),
    });
    expect(late.status).toBe(401);
    expect(late.body.error).toBe('no_challenge');
    expect(client.cookies.has('__Host-sid')).toBe(false);

    // The user is warned by email.
    expect(h.emails.some((e) => e.to === user.email && /cancelled after 3/.test(e.text))).toBe(true);
  });

  it('cancels the pending email code together with the challenge', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'mail@example.com', mfa: 'email' });
    const client = await startLogin(h, user.email);
    expect((await client.post('/api/auth/challenge/email-code')).status).toBe(200);
    const code = /(\d{6})/.exec(h.emails.at(-1)?.text ?? '')?.[1] ?? '';
    for (let i = 0; i < 3; i += 1) {
      await client.post('/api/auth/challenge/verify', { method: 'email', code: '999999' });
    }
    const late = await client.post('/api/auth/challenge/verify', { method: 'email', code });
    expect(late.status).toBe(401);
    const row = await h.env.DB.prepare(
      `SELECT status, email_code_hash FROM auth_challenges WHERE user_id = ?`,
    )
      .bind(user.id)
      .first<{ status: string; email_code_hash: string | null }>();
    expect(row).toEqual({ status: 'cancelled', email_code_hash: null });
  });

  it('never tests more than 3 codes under parallel requests', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'race@example.com' });
    const client = await startLogin(h, user.email);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.post('/api/auth/challenge/verify', { method: 'totp', code: '123456' }),
      ),
    );
    expect(results.every((r) => r.status === 401)).toBe(true);
    const row = await h.env.DB.prepare(`SELECT attempts, status FROM auth_challenges WHERE user_id = ?`)
      .bind(user.id)
      .first<{ attempts: number; status: string }>();
    expect(row?.attempts).toBeLessThanOrEqual(3);
    expect(row?.status).toBe('cancelled');
  });

  it('rejects a TOTP code that was already used (replay)', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'replay@example.com' });
    const a = await startLogin(h, user.email);
    const code = await currentTotp(h);
    expect((await a.post('/api/auth/challenge/verify', { method: 'totp', code })).status).toBe(200);
    const b = await startLogin(h, user.email);
    const replay = await b.post('/api/auth/challenge/verify', { method: 'totp', code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe('invalid_code');
  });

  it('accepts a recovery code exactly once', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'rc@example.com' });
    const a = await startLogin(h, user.email);
    const ok = await a.post('/api/auth/challenge/verify', { method: 'recovery', code: TEST_RECOVERY[0] });
    expect(ok.status).toBe(200);
    const b = await startLogin(h, user.email);
    const again = await b.post('/api/auth/challenge/verify', {
      method: 'recovery',
      code: TEST_RECOVERY[0],
    });
    expect(again.status).toBe(401);
  });

  it('expires the challenge after 5 minutes', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'slow@example.com' });
    const client = await startLogin(h, user.email);
    h.clock.advance(5 * 60_000 + 1);
    const res = await client.post('/api/auth/challenge/verify', {
      method: 'totp',
      code: await currentTotp(h),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('no_challenge');
  });

  it('limits email codes to 1 per minute', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'spam@example.com', mfa: 'email' });
    const client = await startLogin(h, user.email);
    expect((await client.post('/api/auth/challenge/email-code')).status).toBe(200);
    expect((await client.post('/api/auth/challenge/email-code')).status).toBe(429);
    h.clock.advance(61_000);
    expect((await client.post('/api/auth/challenge/email-code')).status).toBe(200);
  });
});

describe('account lockout', () => {
  it('locks for 15 minutes after 3 cancelled challenges, then doubles', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'lock@example.com' });
    await failChallenge(h, user.email);
    await failChallenge(h, user.email);
    await failChallenge(h, user.email);

    const locked = await h.client().post('/api/auth/login', {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(locked.status).toBe(423);
    expect(locked.body.lockedUntil).toBe(h.clock.now + 15 * 60_000);
    expect(h.emails.some((e) => /temporarily locked/.test(e.subject))).toBe(true);

    h.clock.advance(15 * 60_000 + 1);
    // Lock over: three more cancelled challenges → 30 minutes.
    await failChallenge(h, user.email);
    await failChallenge(h, user.email);
    await failChallenge(h, user.email);
    const again = await h.client().post('/api/auth/login', {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(again.status).toBe(423);
    expect(again.body.lockedUntil).toBe(h.clock.now + 30 * 60_000);
  });

  it('does not reveal the lock to a wrong password', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'quiet@example.com' });
    for (let i = 0; i < 3; i += 1) await failChallenge(h, user.email);
    const res = await h.client().post('/api/auth/login', { email: user.email, password: 'nope-nope-nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('resets the consecutive counter after a successful sign-in', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'reset-counter@example.com' });
    await failChallenge(h, user.email);
    await failChallenge(h, user.email);
    h.clock.advance(30_000);
    const ok = await startLogin(h, user.email);
    expect(
      (await ok.post('/api/auth/challenge/verify', { method: 'totp', code: await currentTotp(h) }))
        .status,
    ).toBe(200);
    await failChallenge(h, user.email);
    const res = await h.client().post('/api/auth/login', { email: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });
});
