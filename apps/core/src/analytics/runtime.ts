import { safeFetch } from '@amable/auth/security';
import { siteStub, tenantSitesStub, type AnalyticsNamespace } from '@amable/app-edge/analytics';
import { SYSTEM_ACTOR } from '../crm/context';
import type { CrmResult } from '../crm/ops';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { deliverAlert, type AlertTransport } from './alerts';
import { devIntegrations, syncDueIntegrations, unavailableIntegrations, type Integrations } from './integrations';
import { syncTenant, type SyncPorts, type SyncReport } from './sync';

/** Secrets of other modules analytics relies on (declared here, set by their owners). */
interface SharedSecretsEnv {
  /** Signs `_amb_c` contact tokens (email module); comma separated rotation list in `_PREVIOUS`. */
  EMAIL_TOKEN_SECRET?: string;
  EMAIL_TOKEN_SECRET_PREVIOUS?: string;
  /** Delivers alert webhooks for real in dev (default: logged only, no network). */
  ANALYTICS_WEBHOOKS_LIVE?: string;
}

/** Same public dev fallback as the email module (tokens must verify locally). */
const DEV_EMAIL_TOKEN_SECRET = 'amable-dev-email-token-secret-not-for-production';
const DEV_SHARE_SECRET = 'amable-dev-analytics-share-secret-not-for-production';

export function contactTokenSecrets(env: Env): string[] {
  const e = env as Env & SharedSecretsEnv;
  const secrets = [e.EMAIL_TOKEN_SECRET, e.EMAIL_TOKEN_SECRET_PREVIOUS]
    .flatMap((v) => (v ?? '').split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (secrets.length > 0) return secrets;
  return env.ENVIRONMENT === 'dev' || env.ENVIRONMENT === 'test' ? [DEV_EMAIL_TOKEN_SECRET] : [];
}

/** Share-link signing secret: derived from the installation encryption key. */
export function shareSecret(env: Env): string {
  if (env.AUTH_ENCRYPTION_KEY !== undefined && env.AUTH_ENCRYPTION_KEY !== '') return env.AUTH_ENCRYPTION_KEY;
  if (env.ENVIRONMENT === 'dev' || env.ENVIRONMENT === 'test') return DEV_SHARE_SECRET;
  throw new Error('AUTH_ENCRYPTION_KEY is not configured');
}

export function integrationsFor(env: Env): Integrations {
  return env.ENVIRONMENT === 'dev' || env.ENVIRONMENT === 'test' ? devIntegrations() : unavailableIntegrations();
}

export function appOrigin(env: Env): string {
  return (env.APP_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
}

function alertTransport(env: Env): AlertTransport {
  const live = env.ENVIRONMENT !== 'dev' || (env as Env & SharedSecretsEnv).ANALYTICS_WEBHOOKS_LIVE === 'true';
  return {
    email: {
      async send(email) {
        await (await getAuthServices(env)).email.send(email);
      },
    },
    async memberEmails(tenantId) {
      const rows = await env.DB.prepare(
        `SELECT lower(u.email) AS email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = ?`,
      )
        .bind(tenantId)
        .all<{ email: string }>();
      return new Set(rows.results.map((r) => r.email));
    },
    async post(url, body, headers) {
      if (!live) {
        console.log(`[analytics] alert webhook (dev, not sent) → ${url} ${body.slice(0, 200)}`);
        return 204;
      }
      const res = await safeFetch(url, { method: 'POST', body, headers }, {
        fetchFn: (input, init) => fetch(input, init),
        timeoutMs: 5000,
        maxBytes: 16_384,
      });
      return res.status;
    },
    now: () => Date.now(),
    appOrigin: appOrigin(env),
  };
}

export function syncPorts(env: Env, ns: AnalyticsNamespace, tenantId: string): SyncPorts {
  const transport = alertTransport(env);
  return {
    ns,
    async crm<T>(op: string, input: unknown): Promise<T> {
      const result = (await env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId)).crm(
        op,
        SYSTEM_ACTOR,
        input,
      )) as CrmResult<unknown>;
      if (!result.ok) throw new Error(`crm ${op}: ${result.error.code} ${result.error.message}`);
      return result.value as T;
    },
    engine: async (events) => {
      await env.ENGINE.get(env.ENGINE.idFromName(tenantId)).ingest(tenantId, events);
    },
    contactTokenSecrets: contactTokenSecrets(env),
    deliverAlert: (d) => deliverAlert(transport, d),
    now: () => Date.now(),
  };
}

/** Sync of one tenant from the request path (kick) — never throws. */
export async function runTenantSync(env: Env, tenantId: string): Promise<SyncReport | null> {
  const ns = env.ANALYTICS;
  if (ns === undefined) return null;
  try {
    return await syncTenant(syncPorts(env, ns, tenantId), tenantId);
  } catch (error) {
    console.error(`[analytics] sync of ${tenantId} failed: ${String(error)}`);
    return null;
  }
}

/** Wall-clock share of a cron tick for the analytics sync (the tick also runs backups, archive, apps). */
export const ANALYTICS_TICK_BUDGET_MS = 10_000;
export const ANALYTICS_CURSOR_KEY = 'analytics/_cron.json';

async function readCursor(env: Env): Promise<string | null> {
  try {
    const object = await env.FILES?.get(ANALYTICS_CURSOR_KEY);
    if (object === null || object === undefined) return null;
    const value = ((await object.json()) as { after?: unknown }).after;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function writeCursor(env: Env, after: string | null): Promise<void> {
  await env.FILES?.put(ANALYTICS_CURSOR_KEY, JSON.stringify({ after }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Cron entry point: CRM sync of every tenant having sites, then the daily pull
 * of connected ad / search integrations. Tenants are visited round-robin from
 * where the previous tick stopped, under a wall-clock budget, so a large
 * installation is covered over several ticks instead of running out of time
 * on the same first tenants.
 */
export async function runScheduledAnalytics(
  env: Env,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<{ visited: string[]; complete: boolean }> {
  const ns = env.ANALYTICS;
  if (ns === undefined) return { visited: [], complete: true };
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? ANALYTICS_TICK_BUDGET_MS);
  const { results } = await env.DB.prepare(`SELECT id FROM tenants ORDER BY id`).all<{ id: string }>();
  const after = await readCursor(env);
  const start = after === null ? 0 : results.findIndex((t) => t.id > after);
  const ordered = start <= 0 ? results : [...results.slice(start), ...results.slice(0, start)];
  const integrations = integrationsFor(env);
  const visited: string[] = [];
  for (const { id } of ordered) {
    if (visited.length > 0 && now() >= deadline) break;
    visited.push(id);
    try {
      const sites = await tenantSitesStub(ns, id).indexList();
      if (sites.length === 0) continue;
      await runTenantSync(env, id);
      const active: string[] = [];
      for (const siteId of sites) {
        const record = await siteStub(ns, siteId).getSite();
        if (record !== null && !record.deleted) active.push(siteId);
      }
      await syncDueIntegrations(ns, active, integrations, Date.now());
    } catch (error) {
      console.error(`[analytics] scheduled sync of ${id} failed: ${String(error)}`);
    }
  }
  const complete = visited.length === ordered.length;
  const next = complete ? null : (visited.at(-1) ?? null);
  if (next !== after) await writeCursor(env, next);
  return { visited, complete };
}
