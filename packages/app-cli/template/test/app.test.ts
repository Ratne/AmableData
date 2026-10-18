import { generateAppKey, kvInstallStore } from '@amable/app-sdk';
import { fakeCrm, fixtureFetch, memoryKv, routeFetch, signedCaller, testInstall } from '@amable/app-sdk/testing';
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';
import worker from '../src/index';

/**
 * Every app ships tests that run offline: the CRM is `fakeCrm()`, your
 * provider answers from recorded responses in `test/fixtures/<provider>/`
 * (see the README there). Reviewers of the catalog run `npm test`.
 */

/** Signed calls are routed by path: any origin works in tests. */
const APP_URL = 'https://app.test';

async function setup() {
  const kv = memoryKv();
  const install = testInstall({ scopes: manifest.scopes });
  await kvInstallStore(kv).put(install);
  const crm = fakeCrm();
  // Your provider's API: load recorded fixtures, e.g. `fixtureFetch([listItems, notFound])`.
  const provider = fixtureFetch([]);
  const env = { APP_KEYS: JSON.stringify([await generateAppKey()]), INSTALLS: kv as unknown as KVNamespace };
  const fetch = routeFetch(crm.fetch, provider.fetch);
  const call = signedCaller({ fetch: (request) => worker.fetch(request, env), baseUrl: APP_URL, install });
  return { crm, provider, call, fetch };
}

describe('__APP_NAME__', () => {
  it('answers the contact.validate hook', async () => {
    const { call } = await setup();
    expect((await call('/hooks/validate', { hook: 'contact.validate', source: 'crm', values: { email: 'ada@example.com' } })).body).toEqual({ valid: true });
    expect((await call('/hooks/validate', { hook: 'contact.validate', source: 'form', values: { email: 'bob@example.invalid' } })).body).toMatchObject({
      valid: false,
      tags: ['Invalid email'],
    });
  });

  it('refuses unsigned calls', async () => {
    const env = { APP_KEYS: JSON.stringify([await generateAppKey()]), INSTALLS: memoryKv() as unknown as KVNamespace };
    const response = await worker.fetch(new Request(`${APP_URL}/hooks/validate`, { method: 'POST', body: '{}' }), env);
    expect(response.status).toBe(401);
  });
});
