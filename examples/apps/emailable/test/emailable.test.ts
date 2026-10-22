import { d1InstallStore } from '@amable/app-sdk';
import {
  fakeCrm,
  fixtureFetch,
  routeFetch,
  signedCaller,
  testInstall,
  type Fixture,
} from '@amable/app-sdk/testing';
import { memoryD1 } from '@amable/app-sdk/testing/d1';
import { describe, expect, it } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import {
  hookAnswer,
  mapLimited,
  requestVerification,
  verifyEmail,
  type Fetch,
} from '../src/emailable';
import account from './fixtures/emailable/account.json';
import invalidKey from './fixtures/emailable/error-invalid-key.json';
import noCredits from './fixtures/emailable/error-no-credits.json';
import rateLimited from './fixtures/emailable/error-rate-limited.json';
import deliverable from './fixtures/emailable/verify-deliverable.json';
import disposable from './fixtures/emailable/verify-disposable.json';
import pending from './fixtures/emailable/verify-pending.json';
import roleRisky from './fixtures/emailable/verify-role-risky.json';
import typo from './fixtures/emailable/verify-typo.json';
import undeliverable from './fixtures/emailable/verify-undeliverable.json';

const fx = (value: unknown) => value as Fixture;
const API_KEY = 'live_test_key_1234';
const VERIFIED = [deliverable, undeliverable, disposable, roleRisky, typo].map(fx);

async function setup(options: { apiKey?: string | null } = {}) {
  const db = memoryD1();
  // One install per test: the API key cache is per install id.
  const install = testInstall({ scopes: manifest.scopes });
  await d1InstallStore(db).put(install);
  const crm = fakeCrm();
  if (options.apiKey !== null)
    crm.data.set('emailable_api_key', { value: options.apiKey ?? API_KEY, secret: true });
  const emailable = fixtureFetch([...VERIFIED, fx(account)]);
  const worker = createWorker({ fetch: routeFetch(crm.fetch, emailable.fetch) });
  // As deployed by the CRM: only the database, the keys are created in it.
  const env = { DB: db };
  const fetch = (input: string, init?: RequestInit) => worker.fetch(new Request(input, init), env);
  const call = signedCaller({
    fetch: (request) => worker.fetch(request, env),
    baseUrl: manifest.base_url,
    install,
  });
  const screen = async (method: 'GET' | 'POST', body?: unknown) => {
    const token = await crm.sessionToken({
      appId: manifest.id,
      audience: manifest.base_url,
      install,
    });
    const response = await fetch(`${manifest.base_url}/api/settings`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { crm, emailable, install, fetch, call, screen };
}

describe('emailable: verification', () => {
  it('reads the recorded answers of every state', async () => {
    const { fetch } = fixtureFetch(VERIFIED);
    const verify = (email: string) => verifyEmail(API_KEY, email, { fetch });
    expect(await verify('john.smith@gmail.com')).toEqual({
      state: 'deliverable',
      reason: 'accepted_email',
      score: 100,
      disposable: false,
      didYouMean: null,
    });
    expect(await verify('no-such-user-amable-fixture-7f3a@gmail.com')).toMatchObject({
      state: 'undeliverable',
      reason: 'rejected_email',
      score: 0,
    });
    expect(await verify('amable-fixture@mailinator.com')).toMatchObject({
      state: 'risky',
      disposable: true,
    });
    expect(await verify('support@emailable.com')).toMatchObject({
      state: 'risky',
      reason: 'low_quality',
    });
    expect(await verify('amable.fixture@gmial.com')).toMatchObject({
      state: 'undeliverable',
      reason: 'invalid_domain',
      didYouMean: 'amable.fixture@gmail.com',
    });
  });

  it('sends the key in the Authorization header, never in the URL', async () => {
    const emailable = fixtureFetch(VERIFIED);
    await verifyEmail(API_KEY, 'john.smith@gmail.com', { fetch: emailable.fetch });
    const [call] = emailable.calls;
    expect(call?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(call?.url).toBe(
      'https://api.emailable.com/v1/verify?email=john.smith%40gmail.com&timeout=2',
    );
  });

  it('tells pending, refused and slow answers apart', async () => {
    const answer = async (fixture: unknown) =>
      requestVerification(API_KEY, 'a@b.it', { fetch: fixtureFetch([fx(fixture)]).fetch });
    expect(await answer(pending)).toEqual({ kind: 'pending' });
    expect(await answer(noCredits)).toEqual({
      kind: 'failed',
      status: 402,
      message: 'You don’t have enough credits to complete this request.',
    });
    expect(await answer(rateLimited)).toMatchObject({ kind: 'failed', status: 429 });
    expect(
      await answer({
        ...invalidKey,
        request: { method: 'GET', url: 'https://api.emailable.com/v1/verify' },
      }),
    ).toEqual({
      kind: 'failed',
      status: 403,
      message: 'Invalid API key or access token.',
    });
    const slow: Fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    expect(
      await requestVerification(API_KEY, 'a@b.it', { fetch: slow, timeoutMs: 20 }),
    ).toMatchObject({ kind: 'failed', status: 0 });
    // The hooks never wait for a verdict that is not there.
    expect(
      await verifyEmail(API_KEY, 'a@b.it', { fetch: fixtureFetch([fx(pending)]).fetch }),
    ).toBeNull();
  });

  it('maps states to hook answers, with the suggested fix of a typo', () => {
    expect(hookAnswer(null)).toEqual({ valid: null });
    expect(
      hookAnswer({
        state: 'deliverable',
        reason: null,
        score: 98,
        disposable: false,
        didYouMean: null,
      }),
    ).toMatchObject({
      valid: true,
      tags: [],
      set_fields: { email_status: 'deliverable' },
    });
    expect(
      hookAnswer({
        state: 'undeliverable',
        reason: 'invalid_domain',
        score: 0,
        disposable: true,
        didYouMean: 'ada@gmail.com',
      }),
    ).toMatchObject({
      valid: false,
      reason: 'This email address does not receive mail. Did you mean ada@gmail.com?',
      tags: ['Invalid email', 'Disposable email'],
      entity_data: {
        score: 0,
        reason: 'invalid_domain',
        disposable: true,
        did_you_mean: 'ada@gmail.com',
      },
    });
    expect(
      hookAnswer({ state: 'risky', reason: null, score: 50, disposable: false, didYouMean: null }),
    ).toMatchObject({ valid: null, tags: ['Risky email'] });
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
});

describe('emailable: app', () => {
  it('answers the validation hook and its batch with the workspace key', async () => {
    const app = await setup();
    const single = await app.call('/hooks/validate', {
      hook: 'contact.validate',
      source: 'form',
      values: { email: 'amable.fixture@gmial.com' },
    });
    expect(single).toMatchObject({
      status: 200,
      body: {
        valid: false,
        reason: 'This email address does not receive mail. Did you mean amable.fixture@gmail.com?',
        set_fields: { email_status: 'undeliverable' },
      },
    });

    const batch = await app.call('/hooks/validate-batch', {
      hook: 'contact.validate',
      source: 'import',
      items: [
        { ref: 'c1', values: { email: 'john.smith@gmail.com' } },
        { ref: 'c2', values: { email: 'amable-fixture@mailinator.com' } },
        { ref: 'c3', values: { phone: '+39333' } },
      ],
    });
    expect(batch.body['results']).toEqual([
      expect.objectContaining({ ref: 'c1', valid: true, tags: [] }),
      expect.objectContaining({
        ref: 'c2',
        valid: null,
        tags: ['Risky email', 'Disposable email'],
      }),
      { ref: 'c3', valid: null },
    ]);
    // The key is read once per install and cached.
    expect(
      app.crm.calls.filter((c) => c.url.endsWith('/apps/data/emailable_api_key')),
    ).toHaveLength(1);
    expect(app.emailable.unmatched).toEqual([]);
  });

  it('gives no verdict without an API key', async () => {
    const app = await setup({ apiKey: null });
    const answer = await app.call('/hooks/validate', {
      hook: 'contact.validate',
      source: 'form',
      values: { email: 'ada@example.com' },
    });
    expect(answer.body).toEqual({ valid: null });
    expect(app.emailable.calls).toEqual([]);
  });

  it('verifies an address in an automation and returns the outcome to the flow', async () => {
    const app = await setup();
    const step = {
      action: 'verify_email',
      input: { email: '' },
      contact_id: 'ct_1',
      contact: {
        id: 'ct_1',
        first_name: 'Ada',
        last_name: null,
        email: 'amable.fixture@gmial.com',
        phone: null,
      },
      idempotency_key: 'run_1:step_1',
    };
    expect(await app.call('/actions/verify-email', step)).toEqual({
      status: 200,
      body: {
        output: {
          state: 'undeliverable',
          score: 0,
          reason: 'invalid_domain',
          did_you_mean: 'amable.fixture@gmail.com',
          disposable: false,
        },
      },
    });
    // Waits up to 10 s on Emailable's side: actions have a 15 s budget.
    expect(app.emailable.calls.at(-1)?.url).toContain('timeout=10');
    expect(app.crm.entities.get('contact:ct_1')).toMatchObject({
      did_you_mean: 'amable.fixture@gmail.com',
      score: 0,
    });

    const typed = await app.call('/actions/verify-email', {
      ...step,
      input: { email: ' john.smith@gmail.com ' },
    });
    expect(typed.body).toMatchObject({ output: { state: 'deliverable', score: 100 } });
    expect(
      (await app.call('/actions/verify-email', { ...step, input: { email: 'not an email' } }))
        .status,
    ).toBe(422);
    expect(
      (
        await app.call('/actions/verify-email', {
          ...step,
          contact: { ...step.contact, email: null },
        })
      ).status,
    ).toBe(422);
  });

  it('lets the CRM retry the step while Emailable is busy, and fails it on account problems', async () => {
    const app = await setup();
    const step = {
      action: 'verify_email',
      input: { email: 'ada@example.com' },
      contact_id: 'ct_1',
      idempotency_key: 'k',
    };
    app.emailable.use(fx(pending));
    expect(await app.call('/actions/verify-email', step)).toEqual({
      status: 503,
      body: { error: 'Emailable is still verifying this address' },
    });
    app.emailable.use(fx(rateLimited));
    expect((await app.call('/actions/verify-email', step)).status).toBe(429);
    app.emailable.use(fx(noCredits));
    expect(await app.call('/actions/verify-email', step)).toEqual({
      status: 422,
      body: { error: 'You don’t have enough credits to complete this request.' },
    });

    const unconfigured = await setup({ apiKey: null });
    expect((await unconfigured.call('/actions/verify-email', step)).body).toEqual({
      error: 'add your Emailable API key in the app settings',
    });
  });

  it('checks the key before saving it and shows the credits left', async () => {
    const app = await setup({ apiKey: null });
    expect((await app.screen('GET')).body).toEqual({ configured: false });
    app.emailable.use(fx(invalidKey));
    expect(await app.screen('POST', { api_key: 'live_wrong' })).toEqual({
      status: 422,
      body: { error: 'invalid_api_key' },
    });
    expect(app.crm.data.has('emailable_api_key')).toBe(false);

    app.emailable.use(fx(account));
    expect((await app.screen('POST', { api_key: API_KEY })).body).toEqual({
      configured: true,
      last4: '1234',
      credits: 40232,
    });
    expect(app.crm.data.get('emailable_api_key')).toEqual({ value: API_KEY, secret: true });
    expect(app.emailable.calls.at(-1)?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect((await app.screen('GET')).body).toEqual({
      configured: true,
      last4: '1234',
      credits: 40232,
    });
    expect((await app.screen('POST', { api_key: '' })).body).toEqual({ configured: false });
    expect(app.crm.data.has('emailable_api_key')).toBe(false);
  });

  it('passes the conformance suite', async () => {
    const app = await setup({ apiKey: null });
    const results = await runConformance({
      manifest,
      fetch: app.fetch,
      secret: app.install.webhookSecrets[0]!,
      installationId: app.install.id,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
  });
});
