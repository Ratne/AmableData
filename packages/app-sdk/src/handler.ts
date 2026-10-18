import { createAmableClient, type AmableClient } from './client';
import { normalizeOrigin, type Fetch } from './discovery';
import { jwksOf, parsePrivateJwk, type PrivateJwk } from './keys';
import { exchangeCode, refreshTokens, type AppCredentials, type TokenSet } from './oauth';
import { verifySessionToken, type SessionClaims } from './session';
import { readSignedCall, type SignedCall } from './signature';

/**
 * A complete app backend as one `fetch` handler (Cloudflare Worker, Deno,
 * Bun, Node with a Request adapter):
 *
 *   export default { fetch: (req, env) => handler(env).fetch(req) };
 *
 * It serves the JWKS and the manifest, completes installs (code exchange,
 * token storage and refresh), checks the signature of every CRM call and the
 * session token of every screen API call. You write only the app logic.
 */

export interface InstallRecord {
  readonly id: string;
  /** Installation origin (`iss`). */
  readonly origin: string;
  readonly tenant: { readonly id: string; readonly slug: string };
  readonly apiBase: string;
  readonly scopes: string[];
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ms epoch. */
  readonly expiresAt: number;
  /** Current first; the CRM may sign with the previous one during a rotation. */
  readonly webhookSecrets: string[];
}

export interface InstallStore {
  get(id: string): Promise<InstallRecord | null>;
  put(record: InstallRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** True when at least one install comes from this origin (trusted session token issuers). */
  hasOrigin(origin: string): Promise<boolean>;
}

/** Minimal KV interface (Workers KV or anything alike). */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function kvInstallStore(kv: KeyValue): InstallStore {
  return {
    async get(id) {
      const raw = await kv.get(`install:${id}`);
      return raw === null ? null : (JSON.parse(raw) as InstallRecord);
    },
    async put(record) {
      await kv.put(`install:${record.id}`, JSON.stringify(record));
      await kv.put(`origin:${record.origin}`, '1');
    },
    delete: (id) => kv.delete(`install:${id}`),
    hasOrigin: async (origin) => (await kv.get(`origin:${origin}`)) !== null,
  };
}

export interface AppContext {
  readonly install: InstallRecord;
  /** CRM API of this install; tokens are refreshed (and stored) automatically. */
  readonly api: AmableClient;
}

export interface AppHandlerOptions {
  readonly appId: string;
  /** Manifest `base_url`. */
  readonly baseUrl: string;
  /** Private JWKs (or their JSON); the first one signs, all are published. */
  readonly keys: ReadonlyArray<PrivateJwk | string>;
  readonly store: InstallStore;
  /** Served at `/manifest.json` (install by URL during development). */
  readonly manifest?: Record<string, unknown>;
  readonly jwksPath?: string;
  /** Manifest `redirect_uris[0]` path. */
  readonly installPath?: string;
  /** Where the admin lands after installing (default: the installed apps page). */
  readonly afterInstall?: (install: InstallRecord) => string | Promise<string>;
  /** `webhooks.endpoint`: every event, after the signature check. */
  readonly webhookPath?: string;
  readonly onEvent?: (event: SignedCall & { type?: string; event?: string }, ctx: AppContext) => Promise<void>;
  /** Signed POST endpoints (hooks, actions, form connectors, channels): return the JSON answer, or a Response for errors. */
  readonly calls?: Readonly<Record<string, (body: SignedCall, ctx: AppContext) => Promise<unknown>>>;
  /** GET pages shown in iframes (they get `session_token`, `host`, `locale`, `theme` in the query). */
  readonly screens?: Readonly<Record<string, (request: Request) => Response | Promise<Response>>>;
  /** Screen backend: POST/GET with `Authorization: Bearer <session token>`. */
  readonly screenApi?: Readonly<Record<string, (request: Request, session: SessionClaims, ctx: AppContext) => Promise<Response>>>;
  readonly fetch?: Fetch;
  /** Clock override (tests). */
  readonly now?: () => number;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/**
 * The request path relative to `base_url`: an app hosted under a path
 * (`https://apps.example.com/my-app`) sees the same routes as one at the root.
 * `null` when the request is outside `base_url`.
 */
export function appPath(url: URL, baseUrl: string): string | null {
  const prefix = URL.canParse(baseUrl) ? new URL(baseUrl).pathname.replace(/\/+$/, '') : '';
  if (prefix === '') return url.pathname;
  if (url.pathname === prefix) return '/';
  return url.pathname.startsWith(`${prefix}/`) ? url.pathname.slice(prefix.length) : null;
}

export function createAppHandler(options: AppHandlerOptions) {
  const fetcher = options.fetch ?? fetch;
  const keys = options.keys.map(parsePrivateJwk);
  if (keys.length === 0) throw new Error('createAppHandler: at least one key is required');
  const now = options.now ?? Date.now;
  const credentials: AppCredentials = { appId: options.appId, key: keys[0]!, now };
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const installPath = options.installPath ?? '/install';
  const webhookPath = options.webhookPath ?? '/webhooks';

  function record(tokens: TokenSet, previous: InstallRecord | null): InstallRecord {
    const secret = tokens.webhook_secret ?? null;
    return {
      id: tokens.installation.id,
      origin: normalizeOrigin(tokens.installation.origin),
      tenant: { id: tokens.installation.tenant.id, slug: tokens.installation.tenant.slug },
      apiBase: tokens.installation.api_base,
      scopes: tokens.scope.split(' ').filter(Boolean),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: now() + tokens.expires_in * 1000,
      webhookSecrets: secret === null ? (previous?.webhookSecrets ?? []) : [secret, ...(previous?.webhookSecrets ?? []).filter((s) => s !== secret)].slice(0, 2),
    };
  }

  function context(install: InstallRecord): AppContext {
    let current = install;
    const accessToken = async () => {
      if (current.expiresAt - 60_000 > now()) return current.accessToken;
      const tokens = await refreshTokens({ origin: current.origin, refreshToken: current.refreshToken }, credentials, fetcher);
      current = record(tokens, current);
      await options.store.put(current);
      return current.accessToken;
    };
    return { install, api: createAmableClient({ apiBase: install.apiBase, accessToken, fetch: fetcher }) };
  }

  async function install(url: URL): Promise<Response> {
    const code = url.searchParams.get('code');
    const iss = url.searchParams.get('iss');
    if (code === null || iss === null) return new Response('missing code or iss', { status: 400 });
    const origin = normalizeOrigin(iss);
    const tokens = await exchangeCode({ origin, code, redirectUri: `${baseUrl}${installPath}` }, credentials, fetcher);
    const saved = record(tokens, await options.store.get(tokens.installation.id));
    await options.store.put(saved);
    const target = options.afterInstall ? await options.afterInstall(saved) : `${origin}/t/${saved.tenant.slug}/settings/apps/installed`;
    return Response.redirect(target, 302);
  }

  async function signed(request: Request, handle: (body: SignedCall, ctx: AppContext) => Promise<unknown>): Promise<Response> {
    let install: InstallRecord | null = null;
    const read = await readSignedCall(request, async (id) => {
      install = await options.store.get(id);
      return install?.webhookSecrets ?? [];
    }, now());
    if (!read.ok || install === null) return json({ error: 'unauthorized' }, 401);
    const answer = await handle(read.body, context(install));
    if (answer instanceof Response) return answer;
    return json(answer ?? { ok: true });
  }

  async function screenCall(request: Request, handle: NonNullable<AppHandlerOptions['screenApi']>[string]): Promise<Response> {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    let session: SessionClaims;
    try {
      session = await verifySessionToken(token, {
        audience: baseUrl,
        appId: options.appId,
        isTrustedIssuer: (issuer) => options.store.hasOrigin(issuer),
        nowMs: now(),
        fetch: fetcher,
      });
    } catch {
      return json({ error: 'unauthorized' }, 401);
    }
    const install = await options.store.get(session.install_id);
    if (install === null || install.origin !== normalizeOrigin(session.iss)) return json({ error: 'unknown_installation' }, 401);
    return handle(request, session, context(install));
  }

  return {
    credentials,
    /** API context of an install outside a CRM call (e.g. a webhook from your provider); null when unknown. */
    async contextFor(installId: string): Promise<AppContext | null> {
      const install = await options.store.get(installId);
      return install === null ? null : context(install);
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const path = appPath(url, baseUrl);
      if (path === null) return json({ error: 'not_found' }, 404);
      try {
        if (request.method === 'GET' && path === (options.jwksPath ?? '/.well-known/jwks.json')) {
          return new Response(JSON.stringify(jwksOf(keys)), {
            headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
          });
        }
        if (request.method === 'GET' && path === '/manifest.json' && options.manifest !== undefined) return json(options.manifest);
        if (request.method === 'GET' && path === installPath) return await install(url);
        if (request.method === 'POST' && path === webhookPath) {
          return await signed(request, async (body, ctx) => {
            const type = String(body['type'] ?? body['event'] ?? '');
            if (type === 'app.uninstalled') await options.store.delete(ctx.install.id);
            if (type === 'app.secret_rotated') {
              const { secret } = await ctx.api.webhookSecret();
              const latest = (await options.store.get(ctx.install.id)) ?? ctx.install;
              if (secret !== null) await options.store.put({ ...latest, webhookSecrets: [secret, ...latest.webhookSecrets.filter((s) => s !== secret)].slice(0, 2) });
            }
            await options.onEvent?.(body, ctx);
            return { ok: true };
          });
        }
        const call = request.method === 'POST' ? options.calls?.[path] : undefined;
        if (call !== undefined) return await signed(request, call);
        const api = options.screenApi?.[path];
        if (api !== undefined) return await screenCall(request, api);
        const screen = request.method === 'GET' ? options.screens?.[path] : undefined;
        if (screen !== undefined) return await screen(request);
        return json({ error: 'not_found' }, 404);
      } catch (error) {
        console.error('[app]', error);
        return json({ error: 'internal_error' }, 500);
      }
    },
  };
}
