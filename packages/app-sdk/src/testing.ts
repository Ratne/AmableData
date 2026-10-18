import { DISCOVERY_PATH, type Fetch } from './discovery';
import type { InstallRecord, KeyValue } from './handler';
import { generateAppKey, jwksOf, signJwt, type PrivateJwk } from './keys';
import { INSTALLATION_HEADER, SIGNATURE_HEADER, signPayload } from './signature';

/**
 * Test kit for apps, framework agnostic (vitest, node:test, bun test):
 *
 * - `fixture` / `fixtureFetch`: the provider API answered from recorded,
 *   redacted responses (`test/fixtures/<provider>/*.json`), so tests run offline
 *   and break when the integration drifts from what the provider really sends;
 * - `fakeCrm`: the CRM App API in memory (app data, messages, events, timeline),
 *   and the session tokens of app screens (`crm.sessionToken(...)`);
 * - `testInstall`, `memoryKv`, `signedCaller`: an installed app receiving
 *   signed CRM calls without OAuth.
 *
 *   const crm = fakeCrm();
 *   const provider = fixtureFetch([listNumbers, sendOk]);
 *   const worker = createWorker({ fetch: routeFetch(crm.fetch, provider.fetch) });
 *   const call = signedCaller({ fetch: (r) => worker.fetch(r, env), baseUrl, install });
 */

export interface Fixture {
  /** Lowercase provider id, e.g. `kapso`. */
  readonly provider: string;
  /** What this response shows, in one sentence. */
  readonly description: string;
  /** `live`: recorded from the real API (redacted). `docs`: copied from the provider's API reference. */
  readonly source: 'live' | 'docs';
  /** ISO date of the recording, or the docs page for `docs`. */
  readonly recorded_at?: string;
  readonly docs_url?: string;
  readonly request: {
    readonly method: string;
    /** Full URL; `{param}` segments match any value, the query string is ignored unless `match_query`. */
    readonly url: string;
    readonly match_query?: boolean;
    readonly body?: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    /** JSON body; omit for empty answers (204). */
    readonly body?: unknown;
  };
}

/** Typed identity: `export default fixture({...})` or a JSON import cast to `Fixture`. */
export function fixture(value: Fixture): Fixture {
  return value;
}

export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON when possible, raw text otherwise, null without body. */
  readonly body: unknown;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

function urlMatches(pattern: string, actual: string, matchQuery: boolean): boolean {
  const [patternPath = '', patternQuery] = pattern.split('?', 2);
  const [actualPath = '', actualQuery] = actual.split('?', 2);
  const escaped = patternPath
    .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
    .replace(/\\?\{[^}/]+\\?\}/g, '[^/]+');
  if (!new RegExp(`^${escaped}$`).test(actualPath)) return false;
  if (!matchQuery) return true;
  const want = new URLSearchParams(patternQuery ?? '');
  const got = new URLSearchParams(actualQuery ?? '');
  return [...want.entries()].every(([key, value]) => got.get(key) === value);
}

function responseOf(f: Fixture): Response {
  const status = f.response.status;
  const body =
    f.response.body === undefined || status === 204 ? null : JSON.stringify(f.response.body);
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...f.response.headers },
  });
}

/**
 * Answers requests with the first matching fixture (later `use` calls win).
 * Unmatched requests fail loudly with 599 and are listed in `unmatched`.
 */
export function fixtureFetch(initial: readonly Fixture[] = []) {
  let fixtures = [...initial];
  const calls: RecordedCall[] = [];
  const unmatched: string[] = [];
  const fetchFn: Fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    calls.push({ method, url, headers: headersOf(init), body: bodyOf(init) });
    const found = fixtures.find(
      (f) =>
        f.request.method.toUpperCase() === method &&
        urlMatches(f.request.url, url, f.request.match_query === true),
    );
    if (found === undefined) {
      unmatched.push(`${method} ${url}`);
      return new Response(JSON.stringify({ error: 'no fixture for this request' }), {
        status: 599,
      });
    }
    return responseOf(found);
  };
  return {
    fetch: fetchFn,
    calls,
    unmatched,
    /** Puts fixtures in front of the others (e.g. an error case for one test). */
    use(...more: Fixture[]) {
      fixtures = [...more, ...fixtures];
    },
    /** Calls to URLs starting with `prefix`. */
    callsTo: (prefix: string) => calls.filter((c) => c.url.startsWith(prefix)),
  };
}

/** Workers-KV-like map in memory. */
export function memoryKv(): KeyValue & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
  };
}

export const TEST_WEBHOOK_SECRET = 'whsec_test_amable_app';
export const TEST_CRM_ORIGIN = 'https://crm.test';

/** An installed app as `kvInstallStore` keeps it; store it with `kvInstallStore(kv).put(...)`. */
export function testInstall(overrides: Partial<InstallRecord> = {}): InstallRecord {
  const id = overrides.id ?? `ai_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    origin: TEST_CRM_ORIGIN,
    tenant: { id: 't_test', slug: 'acme' },
    apiBase: `${TEST_CRM_ORIGIN}/api/v2/t/acme`,
    scopes: [],
    accessToken: 'at_test',
    refreshToken: 'rt_test',
    expiresAt: Date.now() + 3_600_000,
    webhookSecrets: [TEST_WEBHOOK_SECRET],
    ...overrides,
  };
}

/** Sends signed CRM calls (hooks, actions, channel sends, webhooks) to the app like the CRM does. */
export function signedCaller(options: {
  fetch: (request: Request) => Promise<Response>;
  baseUrl: string;
  install: Pick<InstallRecord, 'id' | 'tenant' | 'webhookSecrets'>;
  apiVersion?: string;
}) {
  return async (
    path: string,
    payload: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const raw = JSON.stringify({
      installation_id: options.install.id,
      tenant: options.install.tenant.slug,
      api_version: options.apiVersion ?? '2026-10',
      ...payload,
    });
    const response = await options.fetch(
      new Request(`${options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: await signPayload(options.install.webhookSecrets[0] ?? '', raw),
          [INSTALLATION_HEADER]: options.install.id,
        },
        body: raw,
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };
}

/** A fetch that may decline a request (null) so the next one handles it. */
export type PartialFetch = (input: string, init?: RequestInit) => Promise<Response | null>;

/** Tries each fetch in order; the CRM fake declines non-CRM URLs, fixtures take the rest. */
export function routeFetch(...handlers: ReadonlyArray<PartialFetch | Fetch>): Fetch {
  return async (input, init) => {
    for (const handler of handlers) {
      const answer = await handler(String(input), init);
      if (answer !== null) return answer;
    }
    return new Response(JSON.stringify({ error: 'unrouted request' }), { status: 599 });
  };
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The App API of one installation in memory, enough for most app tests.
 * Unknown routes answer 501 and are listed in `unhandled`; add your own with `on`.
 */
export function fakeCrm(options: { origin?: string; slug?: string } = {}) {
  const origin = options.origin ?? TEST_CRM_ORIGIN;
  const base = `${origin}/api/v2/t/${options.slug ?? 'acme'}`;
  const data = new Map<string, { value: unknown; secret: boolean }>();
  const contacts = new Map<string, Record<string, unknown>>();
  const inbound: Record<string, unknown>[] = [];
  const outbound: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const timeline: Record<string, unknown>[] = [];
  const entities = new Map<string, Record<string, unknown>>();
  const calls: RecordedCall[] = [];
  const unhandled: string[] = [];
  const custom: Array<{
    method: string;
    path: RegExp;
    handle: (call: RecordedCall, match: RegExpMatchArray) => Response | Promise<Response>;
  }> = [];
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${String((seq += 1))}`;
  let signingKey: Promise<PrivateJwk> | null = null;
  const key = () => (signingKey ??= generateAppKey('crm-test'));

  const handle = async (method: string, path: string, call: RecordedCall): Promise<Response> => {
    for (const route of custom) {
      const match = route.method === method ? path.match(route.path) : null;
      if (match !== null) return route.handle(call, match);
    }
    const body = (call.body ?? {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/apps\/data\/([^/?]+)$/)) !== null) {
      const key = decodeURIComponent(m[1]!);
      if (method === 'GET') {
        const entry = data.get(key);
        return entry === undefined
          ? ok({ error: 'not_found', message: 'no such key' }, 404)
          : ok({ key, value: entry.value, secret: entry.secret });
      }
      if (method === 'PUT') {
        data.set(key, { value: body['value'], secret: body['secret'] === true });
        return ok({ key, value: body['value'], secret: body['secret'] === true });
      }
      if (method === 'DELETE') {
        data.delete(key);
        return ok({ ok: true });
      }
    }
    if (method === 'GET' && path === '/apps/data')
      return ok({
        data: [...data.entries()].map(([key, e]) => ({
          key,
          value: e.secret ? null : e.value,
          secret: e.secret,
        })),
      });
    if (method === 'POST' && path === '/apps/messages/inbound') {
      inbound.push(body);
      return ok(
        { conversation_id: 'cv_1', message_id: id('msg'), contact_id: 'ct_1', duplicate: false },
        201,
      );
    }
    if (method === 'POST' && path === '/apps/messages/outbound') {
      outbound.push(body);
      return ok(
        { conversation_id: 'cv_1', message_id: id('msg'), contact_id: 'ct_1', duplicate: false },
        201,
      );
    }
    if (method === 'POST' && path === '/apps/messages/status') {
      statuses.push(body);
      return ok({ message_id: 'msg_1', status: body['status'] });
    }
    if (method === 'POST' && path === '/apps/events') {
      events.push(body);
      return ok({ event_id: id('ev'), event: `app.test.${String(body['key'])}`, matched: 0 }, 201);
    }
    if (method === 'POST' && path === '/apps/timeline') {
      timeline.push(body);
      return ok({ id: id('tl') }, 201);
    }
    if ((m = path.match(/^\/apps\/entities\/(\w+)\/([^/?]+)$/)) !== null) {
      const key = `${m[1]!}:${decodeURIComponent(m[2]!)}`;
      if (method === 'PATCH')
        entities.set(key, { ...entities.get(key), ...(body['values'] as Record<string, unknown>) });
      return ok({ data: entities.get(key) ?? {} });
    }
    if ((m = path.match(/^\/contacts\/([^/?]+)$/)) !== null && method === 'GET') {
      const contact = contacts.get(decodeURIComponent(m[1]!));
      return contact === undefined
        ? ok({ error: 'not_found', message: 'no such contact' }, 404)
        : ok(contact);
    }
    unhandled.push(`${method} ${path}`);
    return ok({ error: 'not_implemented', message: `fakeCrm has no ${method} ${path}` }, 501);
  };

  return {
    origin,
    apiBase: base,
    data,
    contacts,
    inbound,
    outbound,
    statuses,
    events,
    timeline,
    entities,
    calls,
    unhandled,
    /** Adds (or overrides) a route, `path` relative to the API base. */
    on(
      method: string,
      path: RegExp,
      answer: (call: RecordedCall, match: RegExpMatchArray) => Response | Promise<Response>,
    ) {
      custom.unshift({ method: method.toUpperCase(), path, handle: answer });
    },
    /** A screen session token, as the CRM puts in the iframe URL (5 minutes). */
    async sessionToken(options: {
      appId: string;
      /** Manifest `base_url`. */
      audience: string;
      install: Pick<InstallRecord, 'id' | 'tenant'>;
      slot?: string;
      key?: string;
      contactId?: string;
      role?: string;
      user?: { id: string; name: string | null; locale: string };
    }): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const user = options.user ?? { id: 'u_test', name: 'Test User', locale: 'en' };
      return signJwt(
        {
          iss: origin,
          aud: options.audience.replace(/\/+$/, ''),
          sub: user.id,
          iat: now,
          exp: now + 300,
          app_id: options.appId,
          install_id: options.install.id,
          tenant: options.install.tenant,
          user,
          role: options.role ?? 'owner',
          slot: options.slot ?? 'app.settings',
          key: options.key ?? 'settings',
          ...(options.contactId === undefined ? {} : { contact_id: options.contactId }),
        },
        await key(),
      );
    },
    /** Handles URLs under the CRM origin, declines (null) the others. */
    fetch: (async (input: string, init?: RequestInit): Promise<Response | null> => {
      const url = String(input);
      if (!url.startsWith(origin)) return null;
      const method = (init?.method ?? 'GET').toUpperCase();
      const call: RecordedCall = { method, url, headers: headersOf(init), body: bodyOf(init) };
      calls.push(call);
      if (url === `${origin}${DISCOVERY_PATH}`) {
        return ok({
          issuer: origin,
          jwks_uri: `${origin}/.well-known/jwks.json`,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/api/apps/v1/token`,
          revocation_endpoint: `${origin}/api/apps/v1/revoke`,
          api_base: `${origin}/api/v2/t/{slug}`,
          version: null,
          api_versions: ['2026-10'],
          current_api_version: '2026-10',
          extension_points: [],
        });
      }
      if (url === `${origin}/.well-known/jwks.json`) return ok(jwksOf([await key()]));
      if (!url.startsWith(base)) {
        unhandled.push(`${method} ${url}`);
        return ok({ error: 'not_implemented' }, 501);
      }
      const path = url.slice(base.length);
      return handle(method, path.split('?')[0]!, call);
    }) as PartialFetch,
  };
}

const SECRET_KEYS =
  /^(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|secret[_-]?key|password|client[_-]?secret)$/i;

/**
 * Prepares a recorded response for the repository: values of secret-looking
 * keys, the given secrets and the given personal values are replaced.
 * Review every fixture before committing it anyway.
 */
export function redact(
  value: unknown,
  options: { secrets?: readonly string[]; replace?: Readonly<Record<string, string>> } = {},
): unknown {
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 6);
  const replace = Object.entries(options.replace ?? {}).filter(([from]) => from !== '');
  const scrub = (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    for (const [from, to] of replace) out = out.split(from).join(to);
    return out;
  };
  const walk = (node: unknown, key: string | null): unknown => {
    if (typeof node === 'string')
      return key !== null && SECRET_KEYS.test(key) && node !== '' ? '[redacted]' : scrub(node);
    if (Array.isArray(node)) return node.map((item) => walk(item, null));
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    return node;
  };
  return walk(value, null);
}
