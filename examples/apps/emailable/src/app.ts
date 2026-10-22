import {
  appBaseUrl,
  appKeysLoader,
  createAppHandler,
  d1InstallStore,
  type AppContext,
  type SqlDatabase,
} from '@amable/app-sdk';
import manifest from '../manifest.json';
import { assets } from './assets';
import {
  checkApiKey,
  hookAnswer,
  mapLimited,
  requestVerification,
  verifyEmail,
  type Fetch,
} from './emailable';
import { settingsPage } from './page';

/**
 * Emailable for AmableData: verifies the email of new contacts (CRM, forms,
 * imports) and records the outcome in the "Email status" field and tags;
 * the "Verify email" automation block returns the outcome to the flow.
 * The workspace's own Emailable API key is stored encrypted in the app data
 * of the installation; this Worker keeps nothing about contacts.
 *
 * It runs in the workspace's own Cloudflare account, deployed by the CRM: its
 * D1 database keeps the installs and the signing keys created on first use.
 */

export interface Env {
  DB: SqlDatabase;
  /** URL of this Worker, set by the CRM when it deploys the app. */
  APP_BASE_URL?: string;
  /** Signing keys, only for a copy hosted elsewhere; normally created in DB. */
  APP_KEYS?: string;
}

const keysOf = appKeysLoader({ kid: 'emailable-1' });

const API_KEY = 'emailable_api_key';
const KEY_TTL_MS = 5 * 60_000;
const BATCH_CONCURRENCY = 10;
/** The CRM waits 10 s for a batch: answer what is done by then. */
const BATCH_BUDGET_MS = 8_500;
/** Automation actions get 15 s: Emailable may work 10 s before answering 249. */
const ACTION_WAIT_S = 10;
const ACTION_TIMEOUT_MS = 13_000;

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

const failure = (status: number, error: string) => Response.json({ error }, { status });

const emailOf = (values: unknown): string | null => {
  const email = (values as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
};

export function createWorker(deps: { fetch?: Fetch } = {}) {
  const outbound = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const baseUrl = appBaseUrl(manifest.base_url, env.APP_BASE_URL, request);
      const app = createAppHandler({
        appId: manifest.id,
        baseUrl,
        keys: await keysOf(env),
        store: d1InstallStore(env.DB),
        manifest,
        assets,
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
            const items = Array.isArray(body['items'])
              ? (body['items'] as Array<{ ref?: unknown; values?: unknown }>)
              : [];
            const apiKey = await apiKeyOf(ctx);
            const results = await mapLimited(
              items,
              BATCH_CONCURRENCY,
              started + BATCH_BUDGET_MS,
              async (item) => {
                const email = emailOf(item.values);
                const answer =
                  email === null || apiKey === null
                    ? { valid: null }
                    : hookAnswer(await verifyEmail(apiKey, email, { fetch: outbound }));
                return { ref: item.ref, ...answer };
              },
              (item) => ({ ref: item.ref, valid: null }),
            );
            return { results };
          },
          '/actions/verify-email': async (body, ctx) => {
            if (body['test'] === true) return { ok: true, test: true };
            const input = (body['input'] ?? {}) as { email?: unknown };
            const typed = typeof input.email === 'string' ? input.email.trim() : '';
            const email = typed === '' ? emailOf(body['contact']) : emailOf({ email: typed });
            if (email === null)
              return failure(
                422,
                typed === '' ? 'the contact has no email' : 'not an email address',
              );
            const apiKey = await apiKeyOf(ctx);
            if (apiKey === null)
              return failure(422, 'add your Emailable API key in the app settings');
            const result = await requestVerification(apiKey, email, {
              fetch: outbound,
              waitSeconds: ACTION_WAIT_S,
              timeoutMs: ACTION_TIMEOUT_MS,
            });
            // Pending, rate-limited or down: a 5xx/429 makes the CRM retry the step later.
            if (result.kind === 'pending')
              return failure(503, 'Emailable is still verifying this address');
            if (result.kind === 'failed') {
              const retry = result.status === 0 || result.status === 429 || result.status >= 500;
              return failure(retry ? (result.status === 429 ? 429 : 503) : 422, result.message);
            }
            const v = result.verification;
            const contactId = typeof body['contact_id'] === 'string' ? body['contact_id'] : null;
            if (contactId !== null && email === emailOf(body['contact'])) {
              await ctx.api.entities
                .set('contact', contactId, {
                  score: v.score,
                  reason: v.reason,
                  disposable: v.disposable,
                  did_you_mean: v.didYouMean,
                })
                .catch(() => null);
            }
            return {
              output: {
                state: v.state,
                score: v.score,
                reason: v.reason,
                did_you_mean: v.didYouMean,
                disposable: v.disposable,
              },
            };
          },
          // Nothing about contacts is stored here: nothing to erase or export.
          '/privacy/erasure': async () => ({ ok: true }),
          '/privacy/data': async () => ({ data: null }),
        },
        screens: {
          '/ui/settings': () => settingsPage(baseUrl),
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
              return Response.json({
                configured: true,
                last4: apiKey.slice(-4),
                credits: check.credits,
              });
            }
            const apiKey = await apiKeyOf(ctx);
            if (apiKey === null) return Response.json({ configured: false });
            const { credits } = await checkApiKey(apiKey, outbound);
            return Response.json({ configured: true, last4: apiKey.slice(-4), credits });
          },
        },
      });
      return app.fetch(request);
    },
  };
}
