import { randomToken } from '@amable/auth';
import {
  assertSafeUrl,
  ResponseTooLargeError,
  safeFetch,
  signWebhook,
  SsrfBlockedError,
  WEBHOOK_SIGNATURE_HEADER,
  type SecretBox,
} from '@amable/auth/security';
import { AUTOMATION_EVENT_TYPES, EVENT_TYPES } from '@amable/core';

/** Every event type an endpoint can subscribe to (`*` = all). */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  ...new Set<string>([...EVENT_TYPES, ...AUTOMATION_EVENT_TYPES, 'webhook.test']),
].sort();

/** Seconds before retry n (after the first failed attempt). */
export const RETRY_DELAYS_S = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
/** Failed attempts in a row (across deliveries) that disable an endpoint. */
export const AUTO_DISABLE_AFTER = 20;
export const MAX_ENDPOINTS_PER_TENANT = 20;
export const DELIVERY_RETENTION_MS = 30 * 24 * 3600 * 1000;
const RESPONSE_SNIPPET_BYTES = 1024;
const FANOUT_CHUNK = 20;

export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type WebhookMessage =
  | { kind: 'webhooks.fanout'; version: 1; tenantId: string; events: WebhookEvent[] }
  | { kind: 'webhooks.deliver'; version: 1; deliveryId: string };

export interface WebhookDeps {
  readonly db: D1Database;
  readonly box: () => Promise<SecretBox>;
  readonly enqueue: (message: WebhookMessage, delaySeconds?: number) => Promise<void>;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly newId: () => string;
  /** Dev only: lets `http://127.0.0.1:<port>` receivers through (local testing). */
  readonly allowLoopback?: boolean;
}

export type EndpointStatus = 'active' | 'disabled';
export type DeliveryStatus = 'pending' | 'retrying' | 'succeeded' | 'failed';

interface EndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  description: string;
  event_types: string;
  secret: string;
  secret_hint: string;
  status: EndpointStatus;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  last_success_at: number | null;
  last_failure_at: number | null;
}

interface DeliveryRow {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number | null;
  last_status: number | null;
  last_error: string | null;
  last_response: string | null;
  duration_ms: number | null;
  replay_of: string | null;
  created_at: number;
  completed_at: number | null;
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly description: string;
  readonly event_types: string[];
  readonly status: EndpointStatus;
  readonly disabled_reason: string | null;
  readonly consecutive_failures: number;
  readonly secret_hint: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly next_attempt_at: string | null;
  readonly last_status: number | null;
  readonly last_error: string | null;
  readonly duration_ms: number | null;
  readonly replay_of: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  readonly payload: unknown;
  readonly last_response: string | null;
}

export class WebhookError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function parseTypes(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
}

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    event_types: parseTypes(row.event_types),
    status: row.status,
    disabled_reason: row.disabled_reason,
    consecutive_failures: row.consecutive_failures,
    secret_hint: row.secret_hint,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    last_success_at: iso(row.last_success_at),
    last_failure_at: iso(row.last_failure_at),
  };
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    event_id: row.event_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: iso(row.next_attempt_at),
    last_status: row.last_status,
    last_error: row.last_error,
    duration_ms: row.duration_ms,
    replay_of: row.replay_of,
    created_at: new Date(row.created_at).toISOString(),
    completed_at: iso(row.completed_at),
  };
}

const secretAd = (tenantId: string, endpointId: string) => `webhook:${tenantId}:${endpointId}`;

function newSecret(): string {
  return `whsec_${randomToken(32)}`;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  } catch {
    return false;
  }
}

/** Validates a receiver URL: https (or http) on a public host, standard ports. */
export function validateEndpointUrl(url: string, allowLoopback = false): string | null {
  if (allowLoopback && isLoopback(url)) return null;
  try {
    assertSafeUrl(url);
    return null;
  } catch (error) {
    return error instanceof SsrfBlockedError ? error.message : 'invalid URL';
  }
}

function validateTypes(types: readonly string[]): void {
  const unknown = types.filter((t) => t !== '*' && !WEBHOOK_EVENT_TYPES.includes(t));
  if (unknown.length > 0) {
    throw new WebhookError(422, 'validation_failed', `unknown event types: ${unknown.join(', ')}`);
  }
}

export function subscribes(eventTypes: readonly string[], type: string): boolean {
  return eventTypes.includes('*') || eventTypes.includes(type);
}

/** Exact body sent to receivers (also what the signature covers). */
export function deliveryBody(tenantSlug: string, event: WebhookEvent): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: event.occurredAt,
    tenant: tenantSlug,
    data: event.payload,
  });
}

export class WebhookService {
  constructor(private readonly deps: WebhookDeps) {}

  private async endpointRow(tenantId: string, id: string): Promise<EndpointRow> {
    const row = await this.deps.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<EndpointRow>();
    if (row === null) throw new WebhookError(404, 'not_found', 'webhook endpoint not found');
    return row;
  }

  async list(tenantId: string): Promise<WebhookEndpoint[]> {
    const rows = await this.deps.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE tenant_id = ? ORDER BY created_at DESC`)
      .bind(tenantId)
      .all<EndpointRow>();
    return rows.results.map(toEndpoint);
  }

  async get(tenantId: string, id: string): Promise<WebhookEndpoint> {
    return toEndpoint(await this.endpointRow(tenantId, id));
  }

  /** Creates an endpoint; the signing secret is returned once and stored encrypted. */
  async create(
    tenantId: string,
    input: { url: string; description?: string; event_types: string[]; createdBy: string | null },
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const urlError = validateEndpointUrl(input.url, this.deps.allowLoopback === true);
    if (urlError !== null) throw new WebhookError(422, 'invalid_url', urlError);
    validateTypes(input.event_types);
    const count = await this.deps.db
      .prepare(`SELECT COUNT(*) AS n FROM webhook_endpoints WHERE tenant_id = ?`)
      .bind(tenantId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_ENDPOINTS_PER_TENANT) {
      throw new WebhookError(409, 'limit_reached', 'too many webhook endpoints');
    }
    const id = this.deps.newId();
    const secret = newSecret();
    const sealed = await (await this.deps.box()).encrypt(secret, secretAd(tenantId, id));
    const now = this.deps.now();
    await this.deps.db
      .prepare(
        `INSERT INTO webhook_endpoints (id, tenant_id, url, description, event_types, secret, secret_hint,
           status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .bind(
        id,
        tenantId,
        input.url,
        input.description ?? '',
        JSON.stringify([...new Set(input.event_types)]),
        sealed,
        secret.slice(-4),
        input.createdBy,
        now,
        now,
      )
      .run();
    return { endpoint: await this.get(tenantId, id), secret };
  }

  async update(
    tenantId: string,
    id: string,
    input: { url?: string; description?: string; event_types?: string[]; status?: EndpointStatus },
  ): Promise<WebhookEndpoint> {
    const row = await this.endpointRow(tenantId, id);
    if (input.url !== undefined) {
      const urlError = validateEndpointUrl(input.url, this.deps.allowLoopback === true);
      if (urlError !== null) throw new WebhookError(422, 'invalid_url', urlError);
    }
    if (input.event_types !== undefined) validateTypes(input.event_types);
    const status = input.status ?? row.status;
    const reenabled = row.status === 'disabled' && status === 'active';
    await this.deps.db
      .prepare(
        `UPDATE webhook_endpoints SET url = ?, description = ?, event_types = ?, status = ?,
           disabled_reason = ?, consecutive_failures = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .bind(
        input.url ?? row.url,
        input.description ?? row.description,
        input.event_types === undefined
          ? row.event_types
          : JSON.stringify([...new Set(input.event_types)]),
        status,
        status === 'disabled' ? (row.status === 'disabled' ? row.disabled_reason : 'manual') : null,
        reenabled ? 0 : row.consecutive_failures,
        this.deps.now(),
        id,
        tenantId,
      )
      .run();
    return this.get(tenantId, id);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.endpointRow(tenantId, id);
    await this.deps.db
      .prepare(`DELETE FROM webhook_deliveries WHERE endpoint_id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .run();
    await this.deps.db
      .prepare(`DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .run();
  }

  async rotateSecret(tenantId: string, id: string): Promise<{ secret: string }> {
    await this.endpointRow(tenantId, id);
    const secret = newSecret();
    const sealed = await (await this.deps.box()).encrypt(secret, secretAd(tenantId, id));
    await this.deps.db
      .prepare(
        `UPDATE webhook_endpoints SET secret = ?, secret_hint = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      )
      .bind(sealed, secret.slice(-4), this.deps.now(), id, tenantId)
      .run();
    return { secret };
  }

  async deliveries(
    tenantId: string,
    endpointId: string,
    options: { limit: number; before: number | null; status?: DeliveryStatus },
  ): Promise<WebhookDelivery[]> {
    await this.endpointRow(tenantId, endpointId);
    const rows = await this.deps.db
      .prepare(
        `SELECT * FROM webhook_deliveries
         WHERE endpoint_id = ? AND tenant_id = ? AND (? IS NULL OR created_at < ?) AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(
        endpointId,
        tenantId,
        options.before,
        options.before,
        options.status ?? null,
        options.status ?? null,
        options.limit,
      )
      .all<DeliveryRow>();
    return rows.results.map(toDelivery);
  }

  private async deliveryRow(tenantId: string, id: string): Promise<DeliveryRow> {
    const row = await this.deps.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<DeliveryRow>();
    if (row === null) throw new WebhookError(404, 'not_found', 'delivery not found');
    return row;
  }

  async delivery(tenantId: string, id: string): Promise<WebhookDeliveryDetail> {
    const row = await this.deliveryRow(tenantId, id);
    return { ...toDelivery(row), payload: JSON.parse(row.payload) as unknown, last_response: row.last_response };
  }

  /** Sends the same body again as a new delivery (one attempt now, retries if it fails). */
  async replay(tenantId: string, id: string): Promise<WebhookDelivery> {
    const original = await this.deliveryRow(tenantId, id);
    const endpoint = await this.endpointRow(tenantId, original.endpoint_id);
    if (endpoint.status !== 'active') {
      throw new WebhookError(409, 'endpoint_disabled', 'enable the endpoint before replaying');
    }
    const replayId = this.deps.newId();
    await this.insertDelivery({
      id: replayId,
      tenantId,
      endpointId: endpoint.id,
      eventId: original.event_id,
      eventType: original.event_type,
      payload: original.payload,
      replayOf: original.replay_of ?? original.id,
    });
    await this.attempt(replayId);
    return toDelivery(await this.deliveryRow(tenantId, replayId));
  }

  /** A `webhook.test` delivery to one endpoint, attempted immediately. */
  async sendTest(tenantId: string, tenantSlug: string, endpointId: string): Promise<WebhookDelivery> {
    const endpoint = await this.endpointRow(tenantId, endpointId);
    const id = this.deps.newId();
    const event: WebhookEvent = {
      id: `test_${id}`,
      type: 'webhook.test',
      occurredAt: new Date(this.deps.now()).toISOString(),
      payload: { message: 'Test delivery from amabledata', endpointId: endpoint.id },
    };
    await this.insertDelivery({
      id,
      tenantId,
      endpointId: endpoint.id,
      eventId: event.id,
      eventType: event.type,
      payload: deliveryBody(tenantSlug, event),
      replayOf: null,
    });
    await this.attempt(id, { force: true });
    return toDelivery(await this.deliveryRow(tenantId, id));
  }

  private async insertDelivery(input: {
    id: string;
    tenantId: string;
    endpointId: string;
    eventId: string;
    eventType: string;
    payload: string;
    replayOf: string | null;
  }): Promise<boolean> {
    const result = await this.deps.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, payload,
           status, attempts, replay_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.endpointId,
        input.eventId,
        input.eventType,
        input.payload,
        input.replayOf,
        this.deps.now(),
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** True when at least one active endpoint exists (cheap guard before queueing events). */
  async hasActiveEndpoints(tenantId: string): Promise<boolean> {
    const row = await this.deps.db
      .prepare(`SELECT 1 AS x FROM webhook_endpoints WHERE tenant_id = ? AND status = 'active' LIMIT 1`)
      .bind(tenantId)
      .first<{ x: number }>();
    return row !== null;
  }

  /** Queues the events of a tenant for fan-out (no-op without active endpoints). */
  async publish(tenantId: string, events: readonly WebhookEvent[]): Promise<void> {
    if (events.length === 0 || !(await this.hasActiveEndpoints(tenantId))) return;
    for (let i = 0; i < events.length; i += FANOUT_CHUNK) {
      await this.deps.enqueue({
        kind: 'webhooks.fanout',
        version: 1,
        tenantId,
        events: events.slice(i, i + FANOUT_CHUNK).map((e) => ({ ...e })),
      });
    }
  }

  /** One delivery per subscribed active endpoint and event (idempotent per endpoint + event). */
  async fanout(tenantId: string, events: readonly WebhookEvent[]): Promise<number> {
    const tenant = await this.deps.db
      .prepare(`SELECT slug FROM tenants WHERE id = ?`)
      .bind(tenantId)
      .first<{ slug: string }>();
    if (tenant === null) return 0;
    const endpoints = (
      await this.deps.db
        .prepare(`SELECT * FROM webhook_endpoints WHERE tenant_id = ? AND status = 'active'`)
        .bind(tenantId)
        .all<EndpointRow>()
    ).results;
    let created = 0;
    for (const endpoint of endpoints) {
      const types = parseTypes(endpoint.event_types);
      for (const event of events) {
        if (!subscribes(types, event.type)) continue;
        const id = this.deps.newId();
        const inserted = await this.insertDelivery({
          id,
          tenantId,
          endpointId: endpoint.id,
          eventId: event.id,
          eventType: event.type,
          payload: deliveryBody(tenant.slug, event),
          replayOf: null,
        });
        if (!inserted) continue;
        created += 1;
        await this.deps.enqueue({ kind: 'webhooks.deliver', version: 1, deliveryId: id });
      }
    }
    return created;
  }

  /**
   * One HTTP attempt of a delivery: signed POST through the SSRF-safe fetch.
   * Failures schedule the next retry (queue delay) until MAX_ATTEMPTS; a run
   * of AUTO_DISABLE_AFTER failed attempts (or a 410) disables the endpoint.
   */
  async attempt(deliveryId: string, options: { force?: boolean } = {}): Promise<DeliveryStatus | null> {
    const delivery = await this.deps.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`)
      .bind(deliveryId)
      .first<DeliveryRow>();
    if (delivery === null || delivery.status === 'succeeded' || delivery.status === 'failed') {
      return delivery?.status ?? null;
    }
    const endpoint = await this.deps.db
      .prepare(`SELECT * FROM webhook_endpoints WHERE id = ?`)
      .bind(delivery.endpoint_id)
      .first<EndpointRow>();
    if (endpoint === null) return null;
    const now = this.deps.now();
    if (endpoint.status !== 'active' && options.force !== true) {
      await this.deps.db
        .prepare(
          `UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint disabled',
             next_attempt_at = NULL, completed_at = ? WHERE id = ?`,
        )
        .bind(now, deliveryId)
        .run();
      return 'failed';
    }

    const secret = await (await this.deps.box()).decrypt(
      endpoint.secret,
      secretAd(endpoint.tenant_id, endpoint.id),
    );
    const attempts = delivery.attempts + 1;
    const started = this.deps.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    let snippet: string | null = null;
    let permanent = false;
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'amabledata-webhooks/1',
        [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(secret, delivery.payload, started),
        'amable-event': delivery.event_type,
        'amable-event-id': delivery.event_id,
        'amable-delivery': delivery.id,
        'amable-attempt': String(attempts),
      };
      const init = { method: 'POST', headers, body: delivery.payload };
      if (this.deps.allowLoopback === true && isLoopback(endpoint.url)) {
        const response = await this.deps.fetch(endpoint.url, {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        statusCode = response.status;
        snippet = (await response.text()).slice(0, RESPONSE_SNIPPET_BYTES);
      } else {
        const response = await safeFetch(endpoint.url, init, {
          fetchFn: this.deps.fetch,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          maxRedirects: 0,
        });
        statusCode = response.status;
        snippet = new TextDecoder().decode(response.body.slice(0, RESPONSE_SNIPPET_BYTES));
      }
      if (statusCode < 200 || statusCode >= 300) {
        error = `HTTP ${String(statusCode)}`;
        permanent = statusCode === 410;
      }
    } catch (caught) {
      if (caught instanceof SsrfBlockedError) {
        error = `blocked URL: ${caught.message}`;
        permanent = true;
      } else if (caught instanceof ResponseTooLargeError) {
        error = 'response too large';
      } else {
        error = caught instanceof Error ? caught.message.slice(0, 200) : 'network error';
      }
    }
    const finished = this.deps.now();
    const duration = Math.max(0, finished - started);

    if (error === null) {
      await this.deps.db.batch([
        this.deps.db
          .prepare(
            `UPDATE webhook_deliveries SET status = 'succeeded', attempts = ?, last_status = ?, last_error = NULL,
               last_response = ?, duration_ms = ?, next_attempt_at = NULL, completed_at = ? WHERE id = ?`,
          )
          .bind(attempts, statusCode, snippet, duration, finished, deliveryId),
        this.deps.db
          .prepare(
            `UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = ? WHERE id = ?`,
          )
          .bind(finished, endpoint.id),
      ]);
      return 'succeeded';
    }

    const failures = endpoint.consecutive_failures + 1;
    const disable = endpoint.status === 'active' && (permanent || failures >= AUTO_DISABLE_AFTER);
    const delay = RETRY_DELAYS_S[attempts - 1];
    const retry = !permanent && !disable && delay !== undefined && attempts < MAX_ATTEMPTS;
    const status: DeliveryStatus = retry ? 'retrying' : 'failed';
    await this.deps.db.batch([
      this.deps.db
        .prepare(
          `UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?,
             last_response = ?, duration_ms = ?, next_attempt_at = ?, completed_at = ? WHERE id = ?`,
        )
        .bind(
          status,
          attempts,
          statusCode,
          error,
          snippet,
          duration,
          retry ? finished + delay * 1000 : null,
          retry ? null : finished,
          deliveryId,
        ),
      this.deps.db
        .prepare(
          `UPDATE webhook_endpoints SET consecutive_failures = ?, last_failure_at = ?,
             status = CASE WHEN ? THEN 'disabled' ELSE status END,
             disabled_reason = CASE WHEN ? THEN 'failures' ELSE disabled_reason END
           WHERE id = ?`,
        )
        .bind(failures, finished, disable ? 1 : 0, disable ? 1 : 0, endpoint.id),
    ]);
    if (retry) {
      await this.deps.enqueue({ kind: 'webhooks.deliver', version: 1, deliveryId }, delay);
    }
    return status;
  }

  /** Drops delivery rows older than the retention window. */
  async prune(): Promise<number> {
    const result = await this.deps.db
      .prepare(`DELETE FROM webhook_deliveries WHERE created_at < ?`)
      .bind(this.deps.now() - DELIVERY_RETENTION_MS)
      .run();
    return result.meta.changes ?? 0;
  }
}
