import { randomToken } from '@amable/auth';
import {
  APP_LIFECYCLE_EVENTS,
  APP_PRIVACY_EVENTS,
  appEndpointUrl,
  eventsBeyondScopes,
  type AppManifest,
} from '@amable/core/apps';
import { monotonicFactory } from 'ulid';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { webhookService } from '../webhooks/runtime';
import { appSecretAd, type WebhookEvent } from '../webhooks/service';
import type { AppInstall } from './store';

/**
 * Event delivery to apps. Each install owns one row in `webhook_endpoints`
 * (`app_install_id` set), so apps get the same signed delivery, retries,
 * backoff and auto-disable as tenant webhooks, plus a replay log (`app_events`).
 */

const nextId = monotonicFactory();
/** How long the previous secret keeps signing deliveries after a rotation. */
export const SECRET_OVERLAP_MS = 24 * 3600 * 1000;

/** Events the endpoint receives: subscriptions the granted scopes cover, lifecycle, privacy. */
export function appEventTypes(manifest: AppManifest, scopes: readonly string[]): string[] {
  const beyond = new Set(eventsBeyondScopes(manifest.webhooks.events, scopes));
  const subscribed = manifest.webhooks.events.filter((event) => !beyond.has(event));
  const privacy = manifest.privacy.handles_personal_data ? [...APP_PRIVACY_EVENTS] : [];
  return [...new Set([...subscribed, ...APP_LIFECYCLE_EVENTS, ...privacy])];
}

export function newWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}

const endpointAd = (tenantId: string, endpointId: string) => `webhook:${tenantId}:${endpointId}`;

/**
 * Creates or updates the install's endpoint. `secret` (plaintext) is required
 * the first time and on rotation; otherwise the stored one is kept.
 */
export async function upsertAppEndpoint(
  env: Env,
  install: AppInstall,
  options: { secret?: string; eventTypes?: string[]; nowMs: number },
): Promise<string> {
  const box = (await getAuthServices(env)).secretBox;
  const url = appEndpointUrl(install.manifest, install.manifest.webhooks.endpoint);
  const types = JSON.stringify(options.eventTypes ?? appEventTypes(install.manifest, install.scopes));
  const existing = await env.DB.prepare(`SELECT id FROM webhook_endpoints WHERE app_install_id = ?`)
    .bind(install.id)
    .first<{ id: string }>();
  if (existing === null) {
    if (options.secret === undefined) throw new Error('upsertAppEndpoint: a secret is required to create the endpoint');
    const id = nextId(options.nowMs);
    await env.DB.prepare(
      `INSERT INTO webhook_endpoints (id, tenant_id, app_install_id, url, description, event_types, secret, secret_hint,
         status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    )
      .bind(
        id,
        install.tenantId,
        install.id,
        url,
        `app:${install.appId}`,
        types,
        await box.encrypt(options.secret, endpointAd(install.tenantId, id)),
        options.secret.slice(-4),
        options.nowMs,
        options.nowMs,
      )
      .run();
    await env.DB.prepare(`UPDATE app_installs SET webhook_endpoint_id = ? WHERE id = ?`).bind(id, install.id).run();
    return id;
  }
  if (options.secret !== undefined) {
    await env.DB.prepare(`UPDATE webhook_endpoints SET secret = ?, secret_hint = ? WHERE id = ?`)
      .bind(await box.encrypt(options.secret, endpointAd(install.tenantId, existing.id)), options.secret.slice(-4), existing.id)
      .run();
  }
  await env.DB.prepare(
    `UPDATE webhook_endpoints SET url = ?, event_types = ?, status = 'active', disabled_reason = NULL,
       consecutive_failures = 0, updated_at = ? WHERE id = ?`,
  )
    .bind(url, types, options.nowMs, existing.id)
    .run();
  return existing.id;
}

/** Sends a lifecycle or privacy event to one app (bypasses subscriptions). */
export async function sendAppEvent(
  env: Env,
  install: Pick<AppInstall, 'id'>,
  type: string,
  payload: Record<string, unknown>,
  nowMs: number,
): Promise<number | null> {
  const event: WebhookEvent = {
    id: `evt_${nextId(nowMs)}`,
    type,
    occurredAt: new Date(nowMs).toISOString(),
    payload,
  };
  return webhookService(env).deliverToApp(install.id, event);
}

/** Current webhook secret of an install (returned to the app at code exchange). */
export async function currentWebhookSecret(env: Env, installId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT webhook_secret FROM app_installs WHERE id = ?`)
    .bind(installId)
    .first<{ webhook_secret: string | null }>();
  if (row?.webhook_secret == null) return null;
  return (await getAuthServices(env)).secretBox.decrypt(row.webhook_secret, appSecretAd(installId, 'current'));
}

export async function storeWebhookSecret(env: Env, installId: string, secret: string): Promise<void> {
  const sealed = await (await getAuthServices(env)).secretBox.encrypt(secret, appSecretAd(installId, 'current'));
  await env.DB.prepare(`UPDATE app_installs SET webhook_secret = ? WHERE id = ?`).bind(sealed, installId).run();
}

/**
 * New webhook secret; the previous one keeps signing (as a second `v1`) for
 * SECRET_OVERLAP_MS so the app can switch without losing deliveries.
 */
export async function rotateWebhookSecret(env: Env, install: AppInstall, nowMs: number): Promise<string> {
  const box = (await getAuthServices(env)).secretBox;
  const previous = await currentWebhookSecret(env, install.id);
  const secret = newWebhookSecret();
  await env.DB.prepare(
    `UPDATE app_installs SET webhook_secret = ?, webhook_secret_prev = ?, webhook_secret_prev_until = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      await box.encrypt(secret, appSecretAd(install.id, 'current')),
      previous === null ? null : await box.encrypt(previous, appSecretAd(install.id, 'previous')),
      previous === null ? null : nowMs + SECRET_OVERLAP_MS,
      nowMs,
      install.id,
    )
    .run();
  await upsertAppEndpoint(env, install, { secret, nowMs });
  return secret;
}

/** Current and, during a rotation, previous secret (to verify requests signed by the app). */
export async function verificationSecrets(env: Env, installId: string, nowMs: number): Promise<string[]> {
  const row = await env.DB.prepare(
    `SELECT webhook_secret, webhook_secret_prev, webhook_secret_prev_until FROM app_installs WHERE id = ?`,
  )
    .bind(installId)
    .first<{ webhook_secret: string | null; webhook_secret_prev: string | null; webhook_secret_prev_until: number | null }>();
  if (row === null) return [];
  const box = (await getAuthServices(env)).secretBox;
  const out: string[] = [];
  if (row.webhook_secret !== null) out.push(await box.decrypt(row.webhook_secret, appSecretAd(installId, 'current')));
  if (row.webhook_secret_prev !== null && (row.webhook_secret_prev_until ?? 0) > nowMs) {
    out.push(await box.decrypt(row.webhook_secret_prev, appSecretAd(installId, 'previous')));
  }
  return out;
}

export interface AppEventRecord {
  readonly sequence: number;
  readonly id: string;
  readonly type: string;
  readonly created_at: string;
  readonly body: unknown;
}

/** Replay log of one install: events after `since`, oldest first. */
export async function replayAppEvents(
  env: Env,
  installId: string,
  options: { since: number; limit: number },
): Promise<{ data: AppEventRecord[]; next_since: number | null }> {
  const rows = (
    await env.DB.prepare(
      `SELECT seq, event_id, event_type, body, created_at FROM app_events
       WHERE install_id = ? AND seq > ? AND body <> '' ORDER BY seq LIMIT ?`,
    )
      .bind(installId, options.since, options.limit + 1)
      .all<{ seq: number; event_id: string; event_type: string; body: string; created_at: number }>()
  ).results;
  const page = rows.slice(0, options.limit);
  return {
    data: page.map((row) => ({
      sequence: row.seq,
      id: row.event_id,
      type: row.event_type,
      created_at: new Date(row.created_at).toISOString(),
      body: JSON.parse(row.body) as unknown,
    })),
    next_since: rows.length > options.limit ? (page[page.length - 1]?.seq ?? null) : null,
  };
}
