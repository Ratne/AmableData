import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../src/auth/services';
import { createHarness, login, seedUser, stepUp, TEST_PASSWORD } from './helpers/harness';

afterEach(() => overrideAuthServices(null));

const DAY = 24 * 3600_000;

describe('sessions', () => {
  it('sets a __Host- cookie (HttpOnly, Secure, SameSite=Lax) and stores only a hash', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 's@example.com' });
    const client = await login(h, user.email);
    const cookie = client.setCookieLog.find((c) => c.startsWith('__Host-sid='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    const token = client.cookies.get('__Host-sid') ?? '';
    const row = await h.env.DB.prepare(`SELECT id FROM sessions WHERE user_id = ?`)
      .bind(user.id)
      .first<{ id: string }>();
    expect(row?.id).not.toBe(token);
    expect(row?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('expires after 7 days of inactivity', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'idle@example.com' });
    const client = await login(h, user.email);
    h.clock.advance(7 * DAY);
    const res = await client.get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_expired');
  });

  it('slides the idle expiry on use but never past the 30-day absolute limit', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'abs@example.com' });
    const client = await login(h, user.email);
    // Used every 6 days: still valid at day 24 although the 7-day idle window passed 3 times.
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(6 * DAY);
      expect((await client.get('/api/me')).status).toBe(200);
    }
    // Day 30: idle expiry would be day 31, but the absolute limit wins.
    h.clock.advance(6 * DAY);
    const res = await client.get('/api/me');
    expect(res.status).toBe(401);
  });

  it('issues a different token at every login', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'rot@example.com' });
    const a = await login(h, user.email);
    const b = await login(h, user.email);
    expect(a.cookies.get('__Host-sid')).not.toBe(b.cookies.get('__Host-sid'));
  });

  it('rotates the token on step-up: the old token stops working', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'step@example.com' });
    const client = await login(h, user.email);
    const before = client.cookies.get('__Host-sid') ?? '';
    await stepUp(h, client);
    const after = client.cookies.get('__Host-sid') ?? '';
    expect(after).not.toBe(before);
    expect((await client.get('/api/me')).status).toBe(200);
    const stale = await h.client().get('/api/me', { cookie: `__Host-sid=${before}` });
    expect(stale.status).toBe(401);
  });

  it('requires a recent step-up for sensitive actions', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'sens@example.com' });
    const client = await login(h, user.email);
    const denied = await client.post('/api/me/2fa/recovery-codes');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe('step_up_required');
    await stepUp(h, client);
    const ok = await client.post('/api/me/2fa/recovery-codes');
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    h.clock.advance(5 * 60_000 + 1);
    expect((await client.post('/api/me/2fa/recovery-codes')).status).toBe(403);
  });

  it('lists devices and revokes one', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'dev@example.com' });
    const laptop = await login(h, user.email);
    const phone = await login(h, user.email);
    const list = await laptop.get('/api/me/sessions');
    const sessions = list.body.sessions as Array<{ id: string; current: boolean }>;
    expect(sessions).toHaveLength(2);
    const other = sessions.find((s) => !s.current);
    expect((await laptop.delete(`/api/me/sessions/${other?.id ?? ''}`)).status).toBe(200);
    expect((await phone.get('/api/me')).status).toBe(401);
    expect((await laptop.get('/api/me')).status).toBe(200);
  });

  it('logs out', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'out@example.com' });
    const client = await login(h, user.email);
    const token = client.cookies.get('__Host-sid') ?? '';
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await h.client().get('/api/me', { cookie: `__Host-sid=${token}` })).status).toBe(401);
  });

  it('emails on a new device, not on a known one', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'nd@example.com' });
    await login(h, user.email);
    await login(h, user.email);
    expect(h.emails.filter((e) => /New sign-in/.test(e.subject))).toHaveLength(0);
    h.clock.advance(30_000);
    const other = h.client();
    const first = await other.post(
      '/api/auth/login',
      { email: user.email, password: TEST_PASSWORD },
      { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0' },
    );
    expect(first.status).toBe(200);
    const { totpCode } = await import('@amable/auth');
    await other.post(
      '/api/auth/challenge/verify',
      { method: 'totp', code: await totpCode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', h.clock.now) },
      { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0' },
    );
    expect(h.emails.filter((e) => /New sign-in/.test(e.subject))).toHaveLength(1);
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without a valid Origin and custom header', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'csrf@example.com' });
    const client = await login(h, user.email);
    const body = { locale: 'it' };

    const noOrigin = await client.patch('/api/me/preferences', body, { origin: '' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body).toMatchObject({ error: 'csrf_rejected', reason: 'missing_origin' });

    const evil = await client.patch('/api/me/preferences', body, { origin: 'https://evil.example' });
    expect(evil.body).toMatchObject({ error: 'csrf_rejected', reason: 'bad_origin' });

    const noHeader = await client.patch('/api/me/preferences', body, { 'x-amable-csrf': '' });
    expect(noHeader.body).toMatchObject({ error: 'csrf_rejected', reason: 'missing_header' });

    // Login itself is protected too (login CSRF).
    const loginCsrf = await h.client().post(
      '/api/auth/login',
      { email: user.email, password: TEST_PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(loginCsrf.status).toBe(403);

    // Safe methods pass; the same request with proper headers passes.
    expect((await client.get('/api/me', { origin: '' })).status).toBe(200);
    expect((await client.patch('/api/me/preferences', body)).status).toBe(200);
  });
});

describe('preferences', () => {
  it('persists locale and theme on the user and mirrors them in the prefs cookie', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'prefs@example.com' });
    const client = await login(h, user.email);
    const res = await client.patch('/api/me/preferences', { locale: 'it', theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locale: 'it', theme: 'dark' });
    expect(client.cookies.get('amb_prefs')).toBe('it.dark');
    const prefsCookie = client.setCookieLog.filter((c) => c.startsWith('amb_prefs=')).at(-1);
    expect(prefsCookie).not.toMatch(/HttpOnly/);

    // Follows the user to another device.
    const other = await login(h, user.email);
    const me = await other.get('/api/me');
    expect(me.body.user).toMatchObject({ locale: 'it', theme: 'dark' });
    expect(other.cookies.get('amb_prefs')).toBe('it.dark');

    // Strict validation.
    expect((await client.patch('/api/me/preferences', { locale: 'fr' })).status).toBe(422);
    expect((await client.patch('/api/me/preferences', { theme: 'dark', extra: 1 })).status).toBe(422);
    expect((await client.patch('/api/me/preferences', {})).status).toBe(422);
  });

  it('injects the saved preferences into the initial HTML', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'html@example.com' });
    const client = await login(h, user.email);
    await client.patch('/api/me/preferences', { locale: 'it', theme: 'dark' });
    const { resolveBootConfig, injectBoot } = await import('../src/middleware/spa');
    const request = new Request('http://localhost/t/demo', {
      headers: { cookie: `__Host-sid=${client.cookies.get('__Host-sid') ?? ''}` },
    });
    const config = await resolveBootConfig(request, h.env, h.clock.now);
    expect(config).toMatchObject({ locale: 'it', theme: 'dark', authenticated: true });
    const html = injectBoot(
      '<!doctype html><html lang="en"><head><script type="module" src="/assets/a.js"></script></head><body></body></html>',
      config,
      'NONCE',
    );
    expect(html).toContain('<html lang="it" data-theme="dark" class="dark">');
    expect(html).toContain('<script nonce="NONCE" type="module"');
    expect(html).toContain('window.__AMABLE__=');

    const anonymous = await resolveBootConfig(
      new Request('http://localhost/', { headers: { 'accept-language': 'it-IT,it;q=0.9' } }),
      h.env,
      h.clock.now,
    );
    expect(anonymous).toMatchObject({ locale: 'it', theme: 'system', authenticated: false });
  });
});
