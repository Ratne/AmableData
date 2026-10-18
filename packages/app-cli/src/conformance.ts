import { parseAppManifest, type AppManifest } from '@amable/core/apps';
import { signPayload } from '@amable/app-sdk';

/**
 * `amable-app test`: what the catalog CI checks before a maintainer reviews
 * an app. Without `--secret` it checks what anyone can see (manifest, HTTPS,
 * JWKS, endpoints refusing unsigned calls); with the webhook secret of a
 * development install it also calls the endpoints signed and checks answers
 * and timings.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
  /** Warnings do not fail the run. */
  readonly warning?: boolean;
}

export interface ConformanceOptions {
  readonly manifest: unknown;
  /** Allow `http://localhost` URLs (development). */
  readonly local?: boolean;
  /** Webhook secret of a development install, for signed checks. */
  readonly secret?: string;
  readonly installationId?: string;
  readonly fetch?: Fetch;
  readonly hookBudgetMs?: number;
}

const HOOK_BUDGET_MS = 1_500;

function url(manifest: AppManifest, path: string): string {
  return `${manifest.base_url.replace(/\/+$/, '')}${path}`;
}

/** Every POST endpoint the CRM calls, with a sample body. */
type Endpoint = { name: string; path: string; body: Record<string, unknown>; budgetMs?: number; listKey?: 'templates' | 'options' };

function endpoints(manifest: AppManifest): Endpoint[] {
  const ext = manifest.extensions;
  const out: Endpoint[] = [];
  if (manifest.webhooks !== undefined) {
    out.push({ name: 'webhooks', path: manifest.webhooks.endpoint, body: { id: 'evt_test', type: 'app.installed', data: {} } });
  }
  if (manifest.privacy.erasure_endpoint !== undefined) {
    out.push({ name: 'privacy erasure', path: manifest.privacy.erasure_endpoint, body: { type: 'privacy.erasure_requested', data: { contact_id: 'c_test' } } });
  }
  if (manifest.privacy.data_request_endpoint !== undefined) {
    out.push({ name: 'privacy data request', path: manifest.privacy.data_request_endpoint, body: { type: 'privacy.data_requested', data: { contact_id: 'c_test' } } });
  }
  if (ext.contact_validate !== undefined) {
    out.push({
      name: 'contact.validate',
      path: ext.contact_validate.endpoint,
      body: { hook: 'contact.validate', source: 'crm', values: { email: 'conformance@example.com', phone: '+390000000000' } },
      budgetMs: HOOK_BUDGET_MS,
    });
    if (ext.contact_validate.batch_endpoint !== undefined) {
      out.push({
        name: 'contact.validate batch',
        path: ext.contact_validate.batch_endpoint,
        body: { hook: 'contact.validate', source: 'import', items: [{ ref: 'c_test', values: { email: 'conformance@example.com' } }] },
        budgetMs: 10_000,
      });
    }
  }
  for (const action of ext.automation_actions ?? []) {
    out.push({ name: `action ${action.key}`, path: action.endpoint, body: { action: action.key, input: {}, contact_id: 'c_test', test: true }, budgetMs: 15_000 });
  }
  for (const connector of ext.form_connectors ?? []) {
    out.push({ name: `form connector ${connector.key}`, path: connector.endpoint, body: { connector: connector.key, settings: {}, test: true } });
  }
  for (const channel of ext.channels ?? []) {
    out.push({ name: `channel ${channel.key}`, path: channel.send_endpoint, body: { channel: channel.key, test: true } });
    if (channel.templates_endpoint !== undefined) {
      out.push({ name: `channel ${channel.key} templates`, path: channel.templates_endpoint, body: { channel: channel.key }, budgetMs: 8_000, listKey: 'templates' });
    }
  }
  const optionSources = [
    ...(ext.automation_actions ?? []).map((a) => ({ kind: 'action', key: a.key, schema: a.input_schema })),
    ...(ext.form_connectors ?? []).flatMap((f) => (f.settings_schema === undefined ? [] : [{ kind: 'connector', key: f.key, schema: f.settings_schema }])),
  ];
  for (const source of optionSources) {
    for (const [property, schema] of Object.entries(source.schema.properties)) {
      if (schema.options_endpoint === undefined) continue;
      out.push({
        name: `${source.kind} ${source.key}.${property} options`,
        path: schema.options_endpoint,
        body: { kind: source.kind, key: source.key, property },
        budgetMs: 8_000,
        listKey: 'options',
      });
    }
  }
  return out;
}

function httpsOk(value: string, local: boolean): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || (local && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname));
  } catch {
    return false;
  }
}

export async function runConformance(options: ConformanceOptions): Promise<CheckResult[]> {
  const fetcher = options.fetch ?? fetch;
  const local = options.local === true;
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string, warning = false) => results.push({ name, ok, ...(detail === undefined ? {} : { detail }), ...(warning ? { warning } : {}) });

  const parsed = parseAppManifest(options.manifest);
  if (!parsed.ok) {
    check('manifest is valid', false, parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    return results;
  }
  const manifest = parsed.manifest;
  check('manifest is valid', true);

  const urls = [manifest.base_url, manifest.jwks_url, ...(manifest.redirect_uris ?? [])];
  const insecure = urls.filter((u) => !httpsOk(u, local));
  check('URLs use https', insecure.length === 0, insecure.length === 0 ? undefined : insecure.join(', '));
  if (local && urls.some((u) => u.startsWith('http:'))) check('development URLs', true, 'http://localhost is accepted only with --local', true);

  try {
    const response = await fetcher(manifest.jwks_url, { headers: { accept: 'application/json' } });
    const body = (await response.json()) as { keys?: Array<Record<string, unknown>> };
    const keys = (body.keys ?? []).filter(
      (k) => (k['kty'] === 'OKP' && k['crv'] === 'Ed25519') || (k['kty'] === 'EC' && k['crv'] === 'P-256') || k['kty'] === 'RSA',
    );
    const leaked = (body.keys ?? []).some((k) => 'd' in k);
    check('JWKS is published', response.ok && keys.length > 0, response.ok ? `${String(keys.length)} signing key(s)` : `HTTP ${String(response.status)}`);
    check('JWKS has no private parts', !leaked, leaked ? 'a key contains "d": rotate it now' : undefined);
    check('JWKS keys have a kid', keys.every((k) => typeof k['kid'] === 'string'));
  } catch (error) {
    check('JWKS is published', false, error instanceof Error ? error.message : String(error));
  }

  for (const endpoint of endpoints(manifest)) {
    const target = url(manifest, endpoint.path);
    try {
      const response = await fetcher(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installation_id: 'ai_conformance', tenant: 'conformance', api_version: manifest.api_version, ...endpoint.body }),
      });
      check(`${endpoint.name} rejects unsigned calls`, response.status === 401 || response.status === 403, `HTTP ${String(response.status)}`);
    } catch (error) {
      check(`${endpoint.name} rejects unsigned calls`, false, error instanceof Error ? error.message : String(error));
    }
  }

  if (options.secret === undefined) {
    check('signed calls', true, 'skipped: pass --secret and --installation of a development install', true);
    return results;
  }
  const installationId = options.installationId ?? 'ai_conformance';
  for (const endpoint of endpoints(manifest)) {
    const body = JSON.stringify({ installation_id: installationId, tenant: 'conformance', api_version: manifest.api_version, ...endpoint.body });
    const started = Date.now();
    try {
      const response = await fetcher(url(manifest, endpoint.path), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Amable-Signature': await signPayload(options.secret, body),
          'Amable-Installation': installationId,
          'Amable-Api-Version': manifest.api_version,
        },
        body,
      });
      const elapsed = Date.now() - started;
      const text = await response.text();
      check(`${endpoint.name} accepts signed calls`, response.ok, `HTTP ${String(response.status)} in ${String(elapsed)} ms`);
      const budget = endpoint.budgetMs === undefined ? undefined : (options.hookBudgetMs ?? endpoint.budgetMs);
      if (budget !== undefined) check(`${endpoint.name} answers within ${String(budget)} ms`, elapsed <= budget, `${String(elapsed)} ms`);
      if (endpoint.listKey !== undefined && response.ok) {
        let list: unknown;
        try {
          list = (JSON.parse(text) as Record<string, unknown>)[endpoint.listKey];
        } catch {
          list = undefined;
        }
        check(`${endpoint.name} answer { ${endpoint.listKey}: [...] }`, Array.isArray(list));
      }
      if (endpoint.name === 'contact.validate' && response.ok) {
        let valid: unknown;
        try {
          valid = (JSON.parse(text) as { valid?: unknown }).valid;
        } catch {
          valid = undefined;
        }
        check('contact.validate answers { valid: boolean | null }', typeof valid === 'boolean' || valid === null);
      }
    } catch (error) {
      check(`${endpoint.name} accepts signed calls`, false, error instanceof Error ? error.message : String(error));
    }
  }
  return results;
}

export function formatResults(results: readonly CheckResult[]): string {
  return results
    .map((r) => `${r.ok ? (r.warning ? '!' : '✓') : '✗'} ${r.name}${r.detail === undefined ? '' : `  (${r.detail})`}`)
    .join('\n');
}

export function passed(results: readonly CheckResult[]): boolean {
  return results.every((r) => r.ok || r.warning === true);
}
