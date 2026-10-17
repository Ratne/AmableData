import { parseAppManifest } from '@amable/core/apps';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { passed, runConformance } from '../src/conformance';
import { createApp } from '../src/create';
import { readKeys, rotateKeys, pruneKeys, publicJwks } from '../src/keys';

// Inside the package so the generated app resolves @amable/app-sdk from its node_modules.
const ROOT = join(import.meta.dirname, '.tmp');
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function memoryKv() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
  };
}

describe('amable-app', () => {
  it('creates an app whose manifest is valid and whose keys are private', async () => {
    const created = await createApp({ dir: join(ROOT, 'hello-app'), name: 'Hello' });
    expect(created.appId).toBe('hello-app');
    const manifest = JSON.parse(readFileSync(join(created.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const parsed = parseAppManifest(manifest);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
    expect(manifest['name']).toBe('Hello');
    expect(readFileSync(join(created.dir, '.gitignore'), 'utf8')).toContain('.amable/');
    expect(statSync(join(created.dir, '.amable', 'keys.json')).mode & 0o077).toBe(0);
    expect(readFileSync(join(created.dir, '.dev.vars'), 'utf8')).toContain('APP_KEYS=');
    await expect(createApp({ dir: created.dir })).rejects.toThrow(/not empty/);
    await expect(createApp({ dir: join(ROOT, 'x'), appId: 'Bad_Id' })).rejects.toThrow(/invalid app id/);
  });

  it('rotates keys keeping the previous one published until pruned', async () => {
    const dir = join(ROOT, 'hello-app');
    const before = readKeys(dir).keys[0]!.kid;
    await rotateKeys(dir);
    const rotated = publicJwks(readKeys(dir)).keys;
    expect(rotated).toHaveLength(2);
    expect(rotated[1]!.kid).toBe(before);
    expect(rotated.some((k) => 'd' in k)).toBe(false);
    pruneKeys(dir);
    expect(publicJwks(readKeys(dir)).keys).toHaveLength(1);
  });

  it('the generated Worker passes the conformance suite', async () => {
    const created = await createApp({ dir: join(ROOT, 'conf-app'), baseUrl: 'https://conf-app.example.dev' });
    expect(existsSync(join(created.dir, 'src', 'index.ts'))).toBe(true);
    const worker = (await import(join(created.dir, 'src', 'index.ts'))) as {
      default: { fetch(request: Request, env: unknown): Promise<Response> };
    };
    const kv = memoryKv();
    const secret = 'whsec_conformance';
    kv.map.set(
      'install:ai_dev',
      JSON.stringify({
        id: 'ai_dev',
        origin: 'https://crm.example',
        tenant: { id: 't1', slug: 'acme' },
        apiBase: 'https://crm.example/api/v2/t/acme',
        scopes: ['contacts:read'],
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3_600_000,
        webhookSecrets: [secret],
      }),
    );
    const env = { APP_KEYS: created.secret, INSTALLS: kv };
    const fetch = (input: string, init?: RequestInit) => worker.default.fetch(new Request(input, init), env);
    const manifest = JSON.parse(readFileSync(join(created.dir, 'manifest.json'), 'utf8')) as unknown;

    const unsigned = await runConformance({ manifest, fetch });
    expect(unsigned.filter((r) => !r.ok)).toEqual([]);
    expect(unsigned.map((r) => r.name)).toContain('contact.validate rejects unsigned calls');

    const signed = await runConformance({ manifest, fetch, secret, installationId: 'ai_dev' });
    expect(signed.filter((r) => !r.ok)).toEqual([]);
    expect(passed(signed)).toBe(true);
    expect(signed.map((r) => r.name)).toContain('contact.validate answers { valid: boolean | null }');

    const broken = await runConformance({ manifest: { ...(manifest as object), base_url: 'http://conf-app.example.dev' }, fetch });
    expect(passed(broken)).toBe(false);
  });
});
