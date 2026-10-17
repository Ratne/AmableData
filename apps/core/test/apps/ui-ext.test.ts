import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices } from '../../src/auth/services';
import { appFrameOrigins, FRAME_TOKEN_TTL_S } from '../../src/apps/frames';
import { decodeJwt, verifyJwtSignature } from '../../src/apps/jwt';
import { pauseInstall } from '../../src/apps/lifecycle';
import { installById } from '../../src/apps/store';
import { installationJwks } from '../../src/apps/well-known';
import { contentSecurityPolicy } from '../../src/middleware/spa';
import { createAppsHarness, resetAppsHarness } from './helpers';
import { installApp } from './oauth-helpers';

afterEach(() => {
  resetAppsHarness();
  overrideAuthServices(null);
});

const screens = {
  extensions: {
    ui: [
      { slot: 'contact.sidebar' as const, key: 'card', path: '/ui/card', title: { en: 'Email check' }, height: 180 },
      { slot: 'app.settings' as const, key: 'settings', path: '/ui/settings', title: { en: 'Settings' } },
    ],
  },
};

describe('app screens', () => {
  it('opens a screen with a short session token signed by the installation', async () => {
    const h = await createAppsHarness();
    const installed = await installApp(h, screens);
    const contact = await installed.owner.post('/api/v2/t/acme/contacts', { given_name: 'Ada' });
    const opened = await installed.owner.post('/api/t/acme/apps/frames', { app_id: 'emailable', key: 'card', contact_id: contact.body.id });
    expect(opened.status).toBe(200);
    const url = new URL(String(opened.body.url));
    expect(url.origin + url.pathname).toBe('https://apps.example.com/ui/card');
    expect(url.searchParams.get('host')).toMatch(/^https?:\/\//);
    expect(opened.body).toMatchObject({ origin: 'https://apps.example.com', slot: 'contact.sidebar', height: 180 });

    const token = url.searchParams.get('session_token')!;
    expect(token).toBe(opened.body.token);
    const decoded = decodeJwt(token)!;
    expect(await verifyJwtSignature(decoded, (await installationJwks(h.env)).keys)).toBe(true);
    expect(decoded.claims).toMatchObject({
      aud: 'https://apps.example.com',
      app_id: 'emailable',
      tenant: { id: 't_acme', slug: 'acme' },
      role: 'owner',
      slot: 'contact.sidebar',
      contact_id: contact.body.id,
    });
    expect(Number(decoded.claims['exp']) - Number(decoded.claims['iat'])).toBe(FRAME_TOKEN_TTL_S);

    expect((await installed.owner.post('/api/t/acme/apps/frames', { app_id: 'emailable', key: 'card' })).status).toBe(422);
    expect((await installed.owner.post('/api/t/acme/apps/frames', { app_id: 'emailable', key: 'nope' })).status).toBe(404);
    expect((await installed.owner.post('/api/t/acme/apps/frames', { app_id: 'emailable', key: 'settings' })).status).toBe(200);

    await pauseInstall(h.env, (await installById(h.env.DB, installed.installId))!, 'paused_by_admin', h.clock.now);
    expect((await installed.owner.post('/api/t/acme/apps/frames', { app_id: 'emailable', key: 'settings' })).status).toBe(409);
  });

  it('allows framing only the hosts of the apps with screens in the user workspaces', async () => {
    const h = await createAppsHarness();
    await installApp(h, screens);
    const owner = await h.env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind('owner@acme.test').first<{ id: string }>();
    const origins = await appFrameOrigins(h.env.DB, owner!.id);
    expect(origins).toEqual(['https://apps.example.com']);
    expect(await appFrameOrigins(h.env.DB, 'u_nobody')).toEqual([]);
    const csp = contentSecurityPolicy('N', true, origins);
    expect(csp).toMatch(/frame-src [^;]*https:\/\/apps\.example\.com/);
    expect(contentSecurityPolicy('N', true)).not.toContain('apps.example.com');
  });
});
