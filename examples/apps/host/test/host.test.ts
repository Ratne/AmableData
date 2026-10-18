import { generateAppKey, kvInstallStore } from '@amable/app-sdk';
import { fakeCrm, memoryKv, routeFetch, signedCaller, testInstall } from '@amable/app-sdk/testing';
import { describe, expect, it } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import emailableManifest from '../../emailable/manifest.json';
import { createWorker as emailable } from '../../emailable/src/app';
import kapsoManifest from '../../kapso/manifest.json';
import { createWorker as kapso } from '../../kapso/src/app';
import mapboxManifest from '../../mapbox/manifest.json';
import { createWorker as mapbox } from '../../mapbox/src/app';
import hosted from '../apps.json';
import { APPS, createHost, prefixedStore, type Env, type HostedApp } from '../src/host';

const HOST = 'https://apps.amabledata.com';

async function setup() {
  const kv = memoryKv();
  const crm = fakeCrm();
  const offline = routeFetch(crm.fetch, async (input) => Response.json({ error: `unexpected ${input}` }, { status: 599 }));
  const apps: Record<string, HostedApp> = {
    emailable: { worker: emailable({ fetch: offline }), keys: (env) => env.EMAILABLE_APP_KEYS },
    kapso: { worker: kapso({ fetch: offline }), keys: (env) => env.KAPSO_APP_KEYS },
    mapbox: { worker: mapbox({ fetch: offline }), keys: (env) => env.MAPBOX_APP_KEYS },
  };
  const env: Env = {
    INSTALLS: kv,
    EMAILABLE_APP_KEYS: JSON.stringify([await generateAppKey('emailable')]),
    KAPSO_APP_KEYS: JSON.stringify([await generateAppKey('kapso')]),
    MAPBOX_APP_KEYS: JSON.stringify([await generateAppKey('mapbox')]),
  };
  const host = createHost(apps);
  const fetch = (input: string, init?: RequestInit) => host.fetch(new Request(input, init), env);
  return { kv, crm, env, fetch };
}

describe('apps host', () => {
  it('hosts every app of apps.json under its own path', () => {
    expect(Object.keys(APPS).sort()).toEqual([...hosted].sort());
    for (const manifest of [emailableManifest, kapsoManifest, mapboxManifest]) {
      expect(manifest.base_url).toBe(`${HOST}/${manifest.id}`);
      expect(manifest.jwks_url).toBe(`${manifest.base_url}/.well-known/jwks.json`);
      expect(manifest.redirect_uris).toEqual([`${manifest.base_url}/install`]);
      expect(manifest.icon_url).toBe(`${manifest.base_url}/icon.png`);
    }
  });

  it('routes each path to its app, with its own keys', async () => {
    const app = await setup();
    expect(await (await app.fetch(`${HOST}/kapso/manifest.json`)).json()).toMatchObject({ id: 'kapso' });
    expect(await (await app.fetch(`${HOST}/emailable/manifest.json`)).json()).toMatchObject({ id: 'emailable' });
    const kid = async (id: string) => ((await (await app.fetch(`${HOST}/${id}/.well-known/jwks.json`)).json()) as { keys: Array<{ kid: string }> }).keys[0]?.kid;
    expect(await kid('kapso')).toBe('kapso');
    expect(await kid('emailable')).toBe('emailable');
    expect((await app.fetch(`${HOST}/nope/manifest.json`)).status).toBe(404);
    expect((await app.fetch(`${HOST}/manifest.json`)).status).toBe(404);
    expect(await (await app.fetch(`${HOST}/`)).json()).toEqual({ apps: ['emailable', 'kapso', 'mapbox'] });
  });

  it('serves screens whose scripts and API calls stay under the app path', async () => {
    const app = await setup();
    const html = await (await app.fetch(`${HOST}/kapso/ui/templates?session_token=x`)).text();
    expect(html).toContain(`<base href="${HOST}/kapso/" />`);
    expect(html).toContain('<script type="module" src="templates.js"></script>');
    expect(await (await app.fetch(`${HOST}/emailable/ui/settings`)).text()).toContain(`<base href="${HOST}/emailable/" />`);
  });

  it('keeps the storage of each app apart', async () => {
    const app = await setup();
    const install = testInstall({ scopes: emailableManifest.scopes });
    await kvInstallStore(prefixedStore(app.kv, 'emailable:')).put(install);
    const call = signedCaller({ fetch: (request) => createHost().fetch(request, app.env), baseUrl: emailableManifest.base_url, install });
    // Signed calls work through the host; the same install id means nothing to Kapso.
    expect(await call('/hooks/validate', { hook: 'contact.validate', source: 'crm', values: { phone: '+39333' } })).toEqual({ status: 200, body: { valid: null } });
    const kapsoCall = signedCaller({ fetch: (request) => createHost().fetch(request, app.env), baseUrl: kapsoManifest.base_url, install });
    expect((await kapsoCall('/channels/templates', { channel: 'whatsapp' })).status).toBe(401);
    expect([...app.kv.map.keys()].every((key) => key.startsWith('emailable:'))).toBe(true);
  });

  it('passes the conformance suite for every app through the host', async () => {
    const app = await setup();
    for (const manifest of [emailableManifest, kapsoManifest, mapboxManifest]) {
      const install = testInstall({ scopes: manifest.scopes });
      await kvInstallStore(prefixedStore(app.kv, `${manifest.id}:`)).put(install);
      const results = await runConformance({ manifest, fetch: app.fetch, secret: install.webhookSecrets[0]!, installationId: install.id });
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(passed(results)).toBe(true);
    }
  });
});
