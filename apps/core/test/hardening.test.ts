import { createStaticTurnstile } from '@amable/auth';
import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { overrideAuthServices } from '../src/auth/services';
import { contentSecurityPolicy } from '../src/middleware/spa';
import type { Env } from '../src/env';
import { createHarness, ORIGIN, seedUser, TEST_PASSWORD } from './helpers/harness';
import { createShimD1 } from './helpers/d1-shim';

afterEach(() => overrideAuthServices(null));

describe('security headers', () => {
  it('sets the API baseline headers', async () => {
    const h = await createHarness();
    const res = await h.client().get('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('builds a strict nonce-based document CSP with HSTS on https', () => {
    const csp = contentSecurityPolicy('abc', true);
    expect(csp).toContain("script-src 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
});

describe('CORS', () => {
  const preflight = (h: Awaited<ReturnType<typeof createHarness>>, path: string, origin: string) =>
    app.request(
      `${ORIGIN}${path}`,
      {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
      },
      h.env,
    );

  it('answers preflights on /api/v2 only for configured origins, never with credentials', async () => {
    const h = await createHarness();
    (h.env as { API_CORS_ORIGINS?: string }).API_CORS_ORIGINS = 'https://shop.example.com, https://b.example.com';
    const ok = await preflight(h, '/api/v2/t/acme/contacts', 'https://shop.example.com');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();

    const denied = await preflight(h, '/api/v2/t/acme/contacts', 'https://evil.example.com');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const actual = await app.request(
      `${ORIGIN}/api/v2/t/acme/contacts`,
      { headers: { origin: 'https://shop.example.com', authorization: 'Bearer amb_live_nope' } },
      h.env,
    );
    expect(actual.status).toBe(401);
    expect(actual.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
    expect(actual.headers.get('vary')).toContain('Origin');
  });

  it('emits no CORS headers on session and auth routes, even for configured origins', async () => {
    const h = await createHarness();
    (h.env as { API_CORS_ORIGINS?: string }).API_CORS_ORIGINS = '*';
    for (const path of ['/api/auth/login', '/api/me', '/api/t/acme/members']) {
      const res = await preflight(h, path, 'https://shop.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const v2 = await preflight(h, '/api/v2/t/acme/contacts', 'https://any.example.com');
    expect(v2.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('is closed by default', async () => {
    const h = await createHarness();
    const res = await preflight(h, '/api/v2/t/acme/contacts', 'https://shop.example.com');
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('production configuration', () => {
  it('refuses auth without the pepper / encryption secrets (fail closed)', async () => {
    const { db } = createShimD1();
    const env = { DB: db, ENVIRONMENT: 'production' } as unknown as Env;
    const res = await app.request(
      `${ORIGIN}/api/auth/login`,
      {
        method: 'POST',
        headers: { origin: ORIGIN, 'x-amable-csrf': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', password: 'x' }),
      },
      env,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_not_configured' });
  });
});

describe('rate limiting and Turnstile', () => {
  it('limits password attempts per account', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'rl@example.com' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await h.client().post('/api/auth/login', { email: user.email, password: 'wrong-password-x' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Even the right password is refused while limited.
    const ok = await h.client().post('/api/auth/login', { email: user.email, password: TEST_PASSWORD });
    expect(ok.status).toBe(429);
  });

  it('requires Turnstile after 3 failed logins and on magic-link requests', async () => {
    const h = await createHarness({ turnstile: createStaticTurnstile({ acceptToken: 'human' }) });
    const user = await seedUser(h, { email: 'bot@example.com' });
    for (let i = 0; i < 3; i += 1) {
      await h.client().post('/api/auth/login', { email: user.email, password: 'wrong-password-x' });
    }
    const blocked = await h.client().post('/api/auth/login', { email: user.email, password: TEST_PASSWORD });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('turnstile_required');
    const passed = await h.client().post('/api/auth/login', {
      email: user.email,
      password: TEST_PASSWORD,
      turnstileToken: 'human',
    });
    expect(passed.status).toBe(200);

    const magic = await h.client().post('/api/auth/magic-link', { email: user.email });
    expect(magic.status).toBe(403);
    const magicOk = await h.client().post('/api/auth/magic-link', { email: user.email, turnstileToken: 'human' });
    expect(magicOk.status).toBe(202);
  });

  it('rejects unknown body fields (strict schemas)', async () => {
    const h = await createHarness();
    const res = await h.client().post('/api/auth/login', { email: 'a@b.co', password: 'x', admin: true });
    expect(res.status).toBe(422);
  });
});

describe('audit log', () => {
  it('records logins and failures without secrets', async () => {
    const h = await createHarness();
    const user = await seedUser(h, { email: 'audit@example.com' });
    await h.client().post('/api/auth/login', { email: user.email, password: 'wrong-password-x' });
    const rows = await h.env.DB.prepare(`SELECT action, details FROM audit_log`).all<{
      action: string;
      details: string | null;
    }>();
    expect(rows.results.map((r) => r.action)).toContain('auth.login_failed');
    expect(JSON.stringify(rows.results)).not.toContain('wrong-password-x');
  });
});
