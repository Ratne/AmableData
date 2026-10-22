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
import { checkToken, isRejected, lookup, type Fetch } from './mapbox';
import { settingsPage } from './page';

/**
 * Mapbox for AmableData: address autocomplete on the contact editor through the
 * workspace's own Mapbox access token, instead of the CRM's built-in
 * OpenStreetMap search. The token is stored encrypted in the app data of the
 * installation; this Worker keeps nothing about contacts nor addresses.
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

const keysOf = appKeysLoader({ kid: 'mapbox-1' });

const TOKEN = 'mapbox_token';
const PERMANENT = 'mapbox_permanent';
const SETTINGS_TTL_MS = 5 * 60_000;
const TOKEN_RE = /^[ps]k\.[A-Za-z0-9._-]{20,500}$/;

interface Settings {
  token: string | null;
  permanent: boolean;
}

/** Per-isolate cache of the settings, so each keystroke does not read the CRM first. */
const settingsCache = new Map<string, { settings: Settings; until: number }>();

async function settingsOf(ctx: AppContext): Promise<Settings> {
  const cached = settingsCache.get(ctx.install.id);
  if (cached !== undefined && cached.until > Date.now()) return cached.settings;
  const [token, permanent] = await Promise.all([
    ctx.api.data.get(TOKEN).catch(() => null),
    ctx.api.data.get(PERMANENT).catch(() => null),
  ]);
  const settings = {
    token: token !== null && typeof token['value'] === 'string' ? token['value'] : null,
    permanent: permanent?.['value'] === true,
  };
  settingsCache.set(ctx.install.id, { settings, until: Date.now() + SETTINGS_TTL_MS });
  return settings;
}

const failure = (status: number, error: string) => Response.json({ error }, { status });
const hint = (token: string) => `…${token.slice(-4)}`;
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

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
          if (event['type'] === 'app.uninstalled') settingsCache.delete(ctx.install.id);
        },
        calls: {
          '/address/suggest': async (body, ctx) => {
            if (body['test'] === true) return { suggestions: [] };
            const q = str(body['q']);
            if (q === null || q.length < 3) return { suggestions: [] };
            const settings = await settingsOf(ctx);
            // Any error makes the CRM use its own geocoder for this search.
            if (settings.token === null)
              return failure(422, 'add your Mapbox access token in the app settings');
            const result = await lookup(
              settings.token,
              { q, lang: str(body['lang']), country: str(body['country']) },
              { fetch: outbound, permanent: settings.permanent },
            );
            if (result.kind === 'ok') return { suggestions: result.suggestions };
            if (isRejected(result)) settingsCache.delete(ctx.install.id);
            return failure(result.status === 429 ? 429 : 502, result.message);
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
              const input = (await req.json().catch(() => ({}))) as {
                token?: unknown;
                permanent?: unknown;
              };
              settingsCache.delete(ctx.install.id);
              if (typeof input.permanent === 'boolean') {
                await ctx.api.data.set(PERMANENT, input.permanent);
              }
              if (typeof input.token === 'string') {
                const token = input.token.trim();
                if (token === '') {
                  await ctx.api.data.delete(TOKEN).catch(() => null);
                } else {
                  if (!TOKEN_RE.test(token)) return failure(422, 'invalid_token');
                  const check = await checkToken(token, outbound);
                  if (isRejected(check)) return failure(422, 'invalid_token');
                  if (check.kind === 'failed') return failure(502, 'mapbox_unavailable');
                  await ctx.api.data.set(TOKEN, token, { secret: true });
                }
              }
            }
            const settings = await settingsOf(ctx);
            return Response.json({
              configured: settings.token !== null,
              hint: settings.token === null ? null : hint(settings.token),
              permanent: settings.permanent,
            });
          },
        },
      });
      return app.fetch(request);
    },
  };
}
