import { toBase64 } from '@amable/auth';
import { signCatalogIndex, type AppManifestInput } from '@amable/core/apps';
import { vi } from 'vitest';
import type { Env } from '../../src/env';
import { overrideWebhookDeps } from '../../src/webhooks/runtime';
import type { WebhookMessage } from '../../src/webhooks/service';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { createHarness, type Harness } from '../helpers/harness';

export interface AppCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

export interface AppsHarness extends Harness {
  /** Every outgoing request (catalog, manifests, JWKS, webhook deliveries, hooks). */
  readonly calls: AppCall[];
  readonly queue: WebhookMessage[];
  /** Route table for outgoing fetches: first matching prefix answers. */
  readonly routes: Map<string, (call: AppCall) => Response | Promise<Response>>;
  /** Runs queued deliveries (repeatable). */
  drain(): Promise<void>;
}

export function manifestInput(overrides: Partial<AppManifestInput> = {}): AppManifestInput {
  return {
    schema_version: 1,
    id: 'emailable',
    name: 'Emailable',
    tagline: { en: 'Verify emails as they arrive' },
    description: { en: 'Flags invalid and disposable email addresses on contacts and forms.' },
    developer: { name: 'Amable', url: 'https://amabledata.com', email: 'apps@amabledata.com' },
    categories: ['data_quality'],
    icon_url: 'https://apps.example.com/icon.png',
    homepage: 'https://apps.example.com',
    support_url: 'https://apps.example.com/support',
    privacy_url: 'https://apps.example.com/privacy',
    base_url: 'https://apps.example.com',
    jwks_url: 'https://apps.example.com/.well-known/jwks.json',
    redirect_uris: ['https://apps.example.com/install'],
    api_version: '2026-10',
    scopes: ['contacts:read', 'contacts:write'],
    webhooks: { endpoint: '/webhooks', events: ['contact.created'] },
    privacy: { handles_personal_data: true, erasure_endpoint: '/privacy/erasure', data_request_endpoint: '/privacy/data' },
    custom_fields: [{ key: 'email_status', label: { en: 'Email status' }, type: 'TEXT', entity: 'contact' }],
    extensions: { contact_validate: { fields: ['email'], endpoint: '/hooks/validate', cache_ttl_seconds: 3600 } },
    ...overrides,
  };
}

export const CATALOG_URL = 'https://catalog.example.com/index.signed.json';

/** Test catalog signing key, trusted through APP_CATALOG_PUBLIC_KEY. */
export async function catalogKeys(): Promise<{ privateKey: string; env: Partial<Env> }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  return {
    privateKey: toBase64(pkcs8),
    env: { APP_CATALOG_URL: CATALOG_URL, APP_CATALOG_PUBLIC_KEY: `test:${toBase64(raw)}` },
  };
}

export async function signedCatalog(
  privateKey: string,
  apps: Array<{ manifest: AppManifestInput; revoked?: boolean; revoked_reason?: string }>,
): Promise<string> {
  return JSON.stringify(
    await signCatalogIndex({ format: 1, generated_at: new Date().toISOString(), apps }, privateKey, 'test'),
  );
}

export async function createAppsHarness(): Promise<AppsHarness> {
  const h = await createHarness();
  const calls: AppCall[] = [];
  const queue: WebhookMessage[] = [];
  const routes = new Map<string, (call: AppCall) => Response | Promise<Response>>();
  const respond = async (input: string, init?: RequestInit): Promise<Response> => {
    const call: AppCall = {
      url: input,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    for (const [prefix, handler] of routes) {
      if (input.startsWith(prefix)) return handler(call);
    }
    return new Response('ok', { status: 200 });
  };
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
    respond(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init),
  );
  let seq = 0;
  overrideWebhookDeps((base) => ({
    ...base,
    enqueue: (message) => {
      queue.push(message);
      return Promise.resolve();
    },
    fetch: respond,
    now: () => h.clock.now,
    newId: () => `wh_${String(++seq).padStart(6, '0')}`,
  }));
  Object.assign(h.env, {
    TENANT_DB: fakeTenantDbNamespace(() => h.clock.now),
    WEBHOOKS_OUT: { send: (message: WebhookMessage) => (queue.push(message), Promise.resolve()) },
    APP_ORIGIN: 'https://crm.example.com',
  });
  const { webhookService } = await import('../../src/webhooks/runtime');
  return {
    ...h,
    calls,
    queue,
    routes,
    async drain() {
      const service = webhookService(h.env);
      while (queue.length > 0) {
        const message = queue.shift();
        if (message?.kind === 'webhooks.deliver') await service.attempt(message.deliveryId);
        else if (message?.kind === 'webhooks.fanout') await service.fanout(message.tenantId, message.events);
      }
    },
  };
}

export function resetAppsHarness(): void {
  overrideWebhookDeps(null);
  vi.unstubAllGlobals();
}
