import { generateAppKey, signPayload } from '@amable/app-sdk';
import { describe, expect, it } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import { hookAnswer, mapLimited, verifyEmail, type Fetch } from '../src/emailable';

const SECRET = 'whsec_emailable_test';

function memoryKv() {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key: string) => map.get(key) ?? null,
    put: async (key: string, value: string) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup(state: string, options: { apiKey?: string | null } = {}) {
  const kv = memoryKv();
  const install = (id: string) => ({
    id,
    origin: 'https://crm.example',
    tenant: { id: 't1', slug: 'acme' },
    apiBase: `https://crm.example/api/v2/t/${id}`,
    scopes: ['contacts:read', 'contacts:write'],
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
    webhookSecrets: [SECRET],
  });
  // One install per test: the API key cache is per install id.
  const installId = `ai_${Math.random().toString(36).slice(2, 10)}`;
  kv.map.set(`install:${installId}`, JSON.stringify(install(installId)));
  const calls: string[] = [];
  const outbound: Fetch = async (input) => {
    calls.push(input);
    if (input.startsWith('https://api.emailable.com/v1/verify')) {
      const email = new URL(input).searchParams.get('email');
      return json({ email, state, reason: state === 'undeliverable' ? 'rejected_email' : 'accepted_email', score: 10, disposable: false });
    }
    if (input.endsWith('/apps/data/emailable_api_key')) {
      return options.apiKey === null ? json({ error: { code: 'not_found' } }, 404) : json({ key: 'emailable_api_key', value: options.apiKey ?? 'live_123', secret: true });
    }
    return json({ error: 'unexpected' }, 500);
  };
  const env = { APP_KEYS: JSON.stringify([await generateAppKey()]), INSTALLS: kv };
  const worker = createWorker({ fetch: outbound });
  const fetch = (input: string, init?: RequestInit) => worker.fetch(new Request(input, init), env);
  const signed = async (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ installation_id: installId, tenant: 'acme', api_version: '2026-10', ...payload });
    const response = await fetch(`${manifest.base_url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Amable-Signature': await signPayload(SECRET, body), 'Amable-Installation': installId },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { fetch, signed, calls, installId };
}

describe('emailable app', () => {
  it('maps Emailable states to hook answers', () => {
    expect(hookAnswer(null)).toEqual({ valid: null });
    expect(hookAnswer({ state: 'deliverable', reason: null, score: 98, disposable: false })).toMatchObject({ valid: true, tags: [], set_fields: { email_status: 'deliverable' } });
    expect(hookAnswer({ state: 'undeliverable', reason: 'rejected_email', score: 0, disposable: true })).toMatchObject({
      valid: false,
      tags: ['Invalid email', 'Disposable email'],
      entity_data: { score: 0, reason: 'rejected_email', disposable: true },
    });
    expect(hookAnswer({ state: 'risky', reason: null, score: 50, disposable: false })).toMatchObject({ valid: null, tags: ['Risky email'] });
  });

  it('gives no verdict when Emailable is slow, still verifying or failing', async () => {
    const slow: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await verifyEmail('k', 'a@b.it', { fetch: slow, timeoutMs: 20 })).toBeNull();
    expect(await verifyEmail('k', 'a@b.it', { fetch: async () => json({ message: 'in progress' }, 249) })).toBeNull();
    expect(await verifyEmail('k', 'a@b.it', { fetch: async () => json({ message: 'unauthorized' }, 401) })).toBeNull();
    expect(await verifyEmail('k', 'a@b.it', { fetch: async () => json({ state: 'weird' }) })).toBeNull();
  });

  it('limits batch concurrency and stops at the deadline', async () => {
    let inFlight = 0;
    let peak = 0;
    let clock = 0;
    const out = await mapLimited(
      Array.from({ length: 30 }, (_, i) => i),
      4,
      20,
      async (i) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        clock += 1;
        inFlight -= 1;
        return `done ${String(i)}`;
      },
      (i) => `late ${String(i)}`,
      () => clock,
    );
    expect(peak).toBe(4);
    expect(out).toHaveLength(30);
    expect(out[0]).toBe('done 0');
    expect(out[29]).toBe('late 29');
  });

  it('answers the validation hook and its batch with the workspace key', async () => {
    const app = await setup('undeliverable');
    const single = await app.signed('/hooks/validate', { hook: 'contact.validate', source: 'crm', values: { email: 'nobody@example.com' } });
    expect(single).toMatchObject({ status: 200, body: { valid: false, tags: ['Invalid email'], set_fields: { email_status: 'undeliverable' } } });
    expect(app.calls.some((u) => u.includes('api_key=live_123') && u.includes('email=nobody%40example.com'))).toBe(true);

    const batch = await app.signed('/hooks/validate-batch', {
      hook: 'contact.validate',
      source: 'import',
      items: [
        { ref: 'c1', values: { email: 'one@example.com' } },
        { ref: 'c2', values: { phone: '+39333' } },
      ],
    });
    expect(batch.body['results']).toEqual([
      expect.objectContaining({ ref: 'c1', valid: false }),
      { ref: 'c2', valid: null },
    ]);
    // The key is read once per install and cached.
    expect(app.calls.filter((u) => u.endsWith('/apps/data/emailable_api_key'))).toHaveLength(1);
  });

  it('gives no verdict without an API key, and passes the conformance suite', async () => {
    const app = await setup('deliverable', { apiKey: null });
    const answer = await app.signed('/hooks/validate', { hook: 'contact.validate', source: 'form', values: { email: 'ada@example.com' } });
    expect(answer.body).toEqual({ valid: null });
    expect(app.calls.some((u) => u.startsWith('https://api.emailable.com'))).toBe(false);

    const results = await runConformance({ manifest, fetch: app.fetch, secret: SECRET, installationId: app.installId });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
  });
});
