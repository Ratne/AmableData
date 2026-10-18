import type { GatewayClientInfo } from '@amable/api-types';
import { devOAuthProvider, type OAuthTokenProvider, type SystemEmail } from '@amable/core';
import type { FormDefinitionInput } from '@amable/forms';
import { createGatewayContext, type GatewayContext } from '../../src/public/context';
import { runCrmOp } from '../../src/crm/ops';
import type { CrmActor } from '../../src/crm/context';
import type { Env } from '../../src/env';
import { overrideFormsRuntime } from '../../src/forms/runtime';
import { createTestTenant, type TestTenant } from '../crm/helpers';

/** TENANT_DB stand-in that also exposes each tenant's SQLite database to assertions. */
export function inspectableTenantDb(): { namespace: Env['TENANT_DB']; tenant(id: string): TestTenant } {
  const tenants = new Map<string, TestTenant>();
  const tenant = (id: string): TestTenant => {
    let found = tenants.get(id);
    if (found === undefined) {
      found = createTestTenant();
      tenants.set(id, found);
    }
    return found;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const current = tenant(id);
      return {
        crm: (op: string, actor: CrmActor, input: unknown) =>
          Promise.resolve(
            structuredClone(runCrmOp({ db: current.db, searchMode: current.mode }, actor, op, structuredClone(input))),
          ),
      };
    },
  };
  return { namespace: namespace as unknown as Env['TENANT_DB'], tenant };
}

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Fake outgoing HTTP: records requests, answers with `respond` (default 200 `{}`). */
export function fakeFetch(respond: (req: CapturedRequest) => Response | Promise<Response> = () => new Response('{}')) {
  const requests: CapturedRequest[] = [];
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const request: CapturedRequest = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    requests.push(request);
    return respond(request);
  };
  return { fetchFn, requests };
}

export interface RuntimeFakes {
  fetch: ReturnType<typeof fakeFetch>;
  emails: SystemEmail[];
  oauth: OAuthTokenProvider;
}

/** Routes the forms runtime to fakes (keeps the harness secret box and Turnstile). */
export function useFormsFakes(options: { respond?: Parameters<typeof fakeFetch>[0]; oauth?: OAuthTokenProvider } = {}): RuntimeFakes {
  const fakes: RuntimeFakes = {
    fetch: fakeFetch(options.respond),
    emails: [],
    oauth: options.oauth ?? devOAuthProvider(),
  };
  overrideFormsRuntime((base) => ({
    ...base,
    fetch: fakes.fetch.fetchFn,
    oauth: fakes.oauth,
    email: {
      send(email) {
        fakes.emails.push(email);
        return Promise.resolve();
      },
    },
  }));
  return fakes;
}

/** A Google service account JSON key with a freshly generated RSA key (never a real one). */
export async function serviceAccountKey(clientEmail: string): Promise<{ json: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'acme-crm',
    private_key_id: 'test',
    private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    client_email: clientEmail,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  return { json, publicKey: pair.publicKey };
}

export const CLIENT: GatewayClientInfo = {
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  country: 'IT',
  visitorId: 'vis_cookie_12345',
  referer: 'https://www.example.com/landing',
  acceptLanguage: 'it-IT,it;q=0.9',
};

export function collectWaits(): { ctx: ExecutionContext; flush(): Promise<void> } {
  const pending: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    async flush() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

export function gatewayCtx(env: Env, executionCtx: ExecutionContext, tenant: { id: string; slug: string }): GatewayContext {
  return createGatewayContext({
    env,
    executionCtx,
    tenant: { ...tenant, name: `Tenant ${tenant.slug}` },
    client: CLIENT,
  });
}

/** A lead form: names, email, phone, a custom field, a sensitive note and a marketing consent. */
export function leadDefinition(overrides: Partial<FormDefinitionInput> = {}): FormDefinitionInput {
  return {
    fields: [
      { id: 'f1', kind: 'text', key: 'first_name', label: 'First name', required: true, map_to: 'given_name' },
      { id: 'f2', kind: 'text', key: 'last_name', label: 'Last name', map_to: 'family_name' },
      { id: 'f3', kind: 'email', key: 'email', label: 'Email', required: true, map_to: 'email' },
      { id: 'f4', kind: 'phone', key: 'phone', label: 'Phone', map_to: 'phone' },
      { id: 'f5', kind: 'text', key: 'company', label: 'Company', map_to: 'company_name' },
      { id: 'f6', kind: 'number', key: 'budget', label: 'Budget', map_to: 'custom.budget' },
      { id: 'f7', kind: 'textarea', key: 'notes', label: 'Notes', sensitive: true },
      { id: 'f8', kind: 'consent', key: 'news', label: 'Send me news', marketing: true },
    ],
    ...overrides,
  };
}
