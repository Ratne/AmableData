import { createAppHandler, kvInstallStore, type AppContext, type KeyValue, type PrivateJwk } from '@amable/app-sdk';
import manifest from '../manifest.json';
import { checkApiKey, hookAnswer, mapLimited, verifyEmail, type Fetch } from './emailable';
import { settingsPage } from './page';

/**
 * Emailable for AmableData: verifies the email of new contacts (CRM, forms,
 * imports) and records the outcome in the "Email status" field and tags.
 * The workspace's own Emailable API key is stored encrypted in the app data
 * of the installation; this Worker keeps nothing about contacts.
 */

export interface Env {
  APP_KEYS: string;
  INSTALLS: KeyValue;
}

const API_KEY = 'emailable_api_key';
const KEY_TTL_MS = 5 * 60_000;
const BATCH_CONCURRENCY = 10;
/** The CRM waits 10 s for a batch: answer what is done by then. */
const BATCH_BUDGET_MS = 8_500;

/** Per-isolate cache of API keys, so each hook does not read the CRM first. */
const keyCache = new Map<string, { key: string | null; until: number }>();

async function apiKeyOf(ctx: AppContext): Promise<string | null> {
  const cached = keyCache.get(ctx.install.id);
  if (cached !== undefined && cached.until > Date.now()) return cached.key;
  const entry = await ctx.api.data.get(API_KEY).catch(() => null);
  const key = entry !== null && typeof entry['value'] === 'string' ? entry['value'] : null;
  keyCache.set(ctx.install.id, { key, until: Date.now() + KEY_TTL_MS });
  return key;
}

const emailOf = (values: unknown): string | null => {
  const email = (values as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
};

export function createWorker(deps: { fetch?: Fetch } = {}) {
  const outbound = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const app = createAppHandler({
        appId: manifest.id,
        baseUrl: manifest.base_url,
        keys: JSON.parse(env.APP_KEYS) as PrivateJwk[],
        store: kvInstallStore(env.INSTALLS),
        manifest,
        fetch: outbound,
        async onEvent(event, ctx) {
          if (event['type'] === 'app.uninstalled') keyCache.delete(ctx.install.id);
        },
        calls: {
          '/hooks/validate': async (body, ctx) => {
            const email = emailOf(body['values']);
            const apiKey = email === null ? null : await apiKeyOf(ctx);
            if (email === null || apiKey === null) return { valid: null };
            return hookAnswer(await verifyEmail(apiKey, email, { fetch: outbound }));
          },
          '/hooks/validate-batch': async (body, ctx) => {
            const started = Date.now();
            const items = Array.isArray(body['items']) ? (body['items'] as Array<{ ref?: unknown; values?: unknown }>) : [];
            const apiKey = await apiKeyOf(ctx);
            const results = await mapLimited(
              items,
              BATCH_CONCURRENCY,
              started + BATCH_BUDGET_MS,
              async (item) => {
                const email = emailOf(item.values);
                const answer = email === null || apiKey === null ? { valid: null } : hookAnswer(await verifyEmail(apiKey, email, { fetch: outbound }));
                return { ref: item.ref, ...answer };
              },
              (item) => ({ ref: item.ref, valid: null }),
            );
            return { results };
          },
          // Nothing about contacts is stored here: nothing to erase or export.
          '/privacy/erasure': async () => ({ ok: true }),
          '/privacy/data': async () => ({ data: null }),
        },
        screens: {
          '/ui/settings': () => settingsPage(),
        },
        screenApi: {
          '/api/settings': async (req, _session, ctx) => {
            if (req.method === 'POST') {
              const input = (await req.json().catch(() => ({}))) as { api_key?: unknown };
              const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
              if (apiKey === '') {
                await ctx.api.data.delete(API_KEY).catch(() => null);
                keyCache.delete(ctx.install.id);
                return Response.json({ configured: false });
              }
              const check = await checkApiKey(apiKey, outbound);
              if (!check.ok) return Response.json({ error: 'invalid_api_key' }, { status: 422 });
              await ctx.api.data.set(API_KEY, apiKey, { secret: true });
              keyCache.set(ctx.install.id, { key: apiKey, until: Date.now() + KEY_TTL_MS });
              return Response.json({ configured: true, last4: apiKey.slice(-4), credits: check.credits });
            }
            const apiKey = await apiKeyOf(ctx);
            return Response.json(apiKey === null ? { configured: false } : { configured: true, last4: apiKey.slice(-4) });
          },
        },
      });
      return app.fetch(request);
    },
  };
}
