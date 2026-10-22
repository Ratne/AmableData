import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DEPLOYED_APP_ORIGIN,
  appBaseUrl,
  appKeysLoader,
  createAppHandler,
  d1InstallStore,
  d1KeyValue,
  purgeExpiredKeyValues,
  resolveAppManifest,
  storedAppKeys,
  type SqlDatabase,
  type SqlStatement,
} from '../src';

function memoryDb(): SqlDatabase & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  const statement = (sql: string, values: unknown[] = []): SqlStatement => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (sqlite.prepare(sql).get(...(values as Array<string | number | null>)) as T | undefined) ?? null,
    run: async () => sqlite.prepare(sql).run(...(values as Array<string | number | null>)),
  });
  return { sqlite, prepare: (sql) => statement(sql) };
}

describe('app storage on D1', () => {
  it('stores key-value data with an optional time to live', async () => {
    let clock = 1_000_000;
    const db = memoryDb();
    const kv = d1KeyValue(db, () => clock);
    await kv.put('a', '1');
    await kv.put('b', '2', { expirationTtl: 60 });
    expect(await kv.get('a')).toBe('1');
    expect(await kv.get('b')).toBe('2');
    await kv.put('a', '3');
    expect(await kv.get('a')).toBe('3');
    clock += 61_000;
    expect(await kv.get('b')).toBeNull();
    await kv.put('c', 'x', { expirationTtl: 1 });
    await purgeExpiredKeyValues(db, clock + 2_000);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS n FROM amable_kv').get() as { n: number }).n).toBe(1);
    await kv.delete('a');
    expect(await kv.get('a')).toBeNull();
  });

  it('keeps installs, with the origins they come from', async () => {
    const store = d1InstallStore(memoryDb());
    const record = {
      id: 'ins_1',
      origin: 'https://crm.example.com',
      tenant: { id: 't1', slug: 'acme' },
      apiBase: 'https://crm.example.com/api/apps/v1',
      scopes: ['contacts:read'],
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 1,
      webhookSecrets: ['s'],
    };
    await store.put(record);
    expect(await store.get('ins_1')).toEqual(record);
    expect(await store.hasOrigin('https://crm.example.com')).toBe(true);
    expect(await store.hasOrigin('https://other.example.com')).toBe(false);
    await store.delete('ins_1');
    expect(await store.get('ins_1')).toBeNull();
  });

  it('creates the signing keys once, the same for isolates starting together', async () => {
    const db = memoryDb();
    const [a, b] = await Promise.all([storedAppKeys(db, { kid: 'app-1' }), storedAppKeys(db, { kid: 'app-1' })]);
    expect(a).toHaveLength(1);
    expect(a[0]!.kid).toBe('app-1');
    expect(b).toEqual(a);
    expect(await appKeysLoader()({ DB: db })).toEqual(a);
    const fromEnv = await storedAppKeys(memoryDb(), { kid: 'env' });
    expect(await appKeysLoader()({ DB: db, APP_KEYS: JSON.stringify(fromEnv) })).toEqual(fromEnv);
  });
});

describe('deployed app origin', () => {
  const manifest = {
    id: 'demo',
    base_url: DEPLOYED_APP_ORIGIN,
    jwks_url: `${DEPLOYED_APP_ORIGIN}/.well-known/jwks.json`,
    redirect_uris: [`${DEPLOYED_APP_ORIGIN}/install`],
    icon_url: 'https://raw.githubusercontent.com/Ratne/amable-apps/main/apps/demo/icon.png',
    deployment: { kind: 'cloudflare_worker' },
  };

  it('runs on APP_BASE_URL and serves its manifest there', async () => {
    const base = appBaseUrl(manifest.base_url, 'https://amable-app-demo.acme.workers.dev/');
    expect(base).toBe('https://amable-app-demo.acme.workers.dev');
    expect(appBaseUrl('https://apps.example.com/demo', 'https://ignored.example.com')).toBe('https://apps.example.com/demo');
    expect(appBaseUrl(manifest.base_url, undefined, new Request('https://amable-app-demo.acme.workers.dev/ui/x'))).toBe(
      'https://amable-app-demo.acme.workers.dev',
    );
    const resolved = resolveAppManifest(manifest, base);
    expect(resolved).toEqual({
      id: 'demo',
      base_url: base,
      jwks_url: `${base}/.well-known/jwks.json`,
      redirect_uris: [`${base}/install`],
      icon_url: manifest.icon_url,
    });

    const keys = await storedAppKeys(memoryDb());
    const app = createAppHandler({ appId: 'demo', baseUrl: manifest.base_url, keys, store: d1InstallStore(memoryDb()), manifest });
    const served = (await (await app.fetch(new Request('https://amable-app-demo.acme.workers.dev/manifest.json'))).json()) as {
      base_url: string;
    };
    expect(served.base_url).toBe('https://amable-app-demo.acme.workers.dev');
    expect((await app.fetch(new Request('https://amable-app-demo.acme.workers.dev/.well-known/jwks.json'))).status).toBe(200);
  });

  it('serves the assets inlined in the bundle', async () => {
    const app = createAppHandler({
      appId: 'demo',
      baseUrl: manifest.base_url,
      keys: await storedAppKeys(memoryDb()),
      store: d1InstallStore(memoryDb()),
      assets: { '/screen.js': { type: 'text/javascript; charset=utf-8', body: 'export {};' } },
    });
    const response = await app.fetch(new Request('https://amable-app-demo.acme.workers.dev/screen.js'));
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await response.text()).toBe('export {};');
    expect((await app.fetch(new Request('https://amable-app-demo.acme.workers.dev/other.js'))).status).toBe(404);
  });
});
