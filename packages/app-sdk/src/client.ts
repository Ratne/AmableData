import type { Fetch } from './discovery';
import { randomId } from './encoding';

/**
 * Small client of the CRM API for one installation (`installation.api_base`
 * from the token response). `accessToken` is called before every request, so
 * plug in your refresh logic there.
 */

export class AmableApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface AmableClientOptions {
  /** e.g. `https://crm.example.com/api/v2/t/acme`. */
  readonly apiBase: string;
  readonly accessToken: () => string | Promise<string>;
  /** Pin the API version the app was written for (`Amable-Api-Version`). */
  readonly apiVersion?: string;
  readonly fetch?: Fetch;
}

export interface TimelineEntry {
  readonly contact_id: string;
  readonly title: string;
  readonly body?: string;
  readonly icon?: 'message' | 'mail' | 'phone' | 'check' | 'warning' | 'info' | 'app';
  /** `https` only. */
  readonly url?: string;
  readonly occurred_at?: string;
}

export function createAmableClient(options: AmableClientOptions) {
  const fetcher = options.fetch ?? fetch;
  const base = options.apiBase.replace(/\/+$/, '');

  async function request<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await options.accessToken()}`,
      accept: 'application/json',
      ...(options.apiVersion === undefined ? {} : { 'Amable-Api-Version': options.apiVersion }),
      ...extra,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetcher(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const parsed: unknown = text === '' ? null : JSON.parse(text);
    if (!response.ok) {
      const error = (parsed ?? {}) as Record<string, unknown>;
      throw new AmableApiError(response.status, String(error['error'] ?? 'http_error'), String(error['message'] ?? `HTTP ${String(response.status)}`), parsed);
    }
    return parsed as T;
  }

  const mutate = <T>(method: string, path: string, body?: unknown, idempotencyKey: string = randomId()) =>
    request<T>(method, path, body, { 'Idempotency-Key': idempotencyKey });
  const origin = new URL(base).origin;
  const oauthGet = async <T>(path: string): Promise<T> => {
    const response = await fetcher(`${origin}/api/apps/v1${path}`, {
      headers: { authorization: `Bearer ${await options.accessToken()}`, accept: 'application/json' },
    });
    if (!response.ok) throw new AmableApiError(response.status, 'http_error', `HTTP ${String(response.status)}`, null);
    return (await response.json()) as T;
  };

  return {
    request,
    contacts: {
      get: (id: string) => request<Record<string, unknown>>('GET', `/contacts/${encodeURIComponent(id)}`),
      list: (query: Record<string, string> = {}) =>
        request<{ data: Record<string, unknown>[]; next_cursor: string | null }>('GET', `/contacts?${new URLSearchParams(query).toString()}`),
      create: (input: Record<string, unknown>, idempotencyKey?: string) => mutate<Record<string, unknown>>('POST', '/contacts', input, idempotencyKey),
      update: (id: string, input: Record<string, unknown>, idempotencyKey?: string) =>
        mutate<Record<string, unknown>>('PATCH', `/contacts/${encodeURIComponent(id)}`, input, idempotencyKey),
    },
    /** Key-value store of the installation; `secret` values are encrypted and readable only by the app. */
    data: {
      list: () => request<Record<string, unknown>>('GET', '/apps/data'),
      get: (key: string) => request<Record<string, unknown>>('GET', `/apps/data/${encodeURIComponent(key)}`),
      set: (key: string, value: unknown, options: { secret?: boolean } = {}) =>
        request<Record<string, unknown>>('PUT', `/apps/data/${encodeURIComponent(key)}`, { value, secret: options.secret ?? false }),
      delete: (key: string) => request<Record<string, unknown>>('DELETE', `/apps/data/${encodeURIComponent(key)}`),
    },
    /** Values attached to a CRM record in the app's namespace (exported and erased with it). */
    entities: {
      get: (entity: 'contact' | 'company' | 'opportunity' | 'order', id: string) =>
        request<{ data: Record<string, unknown> }>('GET', `/apps/entities/${entity}/${encodeURIComponent(id)}`),
      set: (entity: 'contact' | 'company' | 'opportunity' | 'order', id: string, values: Record<string, unknown>) =>
        request<{ data: Record<string, unknown> }>('PATCH', `/apps/entities/${entity}/${encodeURIComponent(id)}`, { values }),
    },
    timeline: {
      add: (entry: TimelineEntry) => request<{ id: string }>('POST', '/apps/timeline', entry),
    },
    /** Fires one of the manifest's `automation_triggers` for a contact. */
    events: {
      fire: (input: { key: string; contact_id: string; event_id?: string; data?: Record<string, unknown> }) =>
        request<{ event_id: string; event: string; matched: number }>('POST', '/apps/events', input),
      /** Deliveries the app missed (replay after downtime). */
      missed: (since = 0, limit = 100) =>
        request<{ data: unknown[]; next_since: number | null }>('GET', `/apps/events?since=${String(since)}&limit=${String(limit)}`),
    },
    /** Conversation channels (`extensions.channels`): messages you receive and delivery updates. */
    messages: {
      inbound: (input: {
        channel: string;
        external_id: string;
        from: string;
        text: string;
        contact?: { given_name?: string; family_name?: string; email?: string };
        sent_at?: string;
      }) => request<{ conversation_id: string; message_id: string; contact_id: string | null; duplicate: boolean }>('POST', '/apps/messages/inbound', input),
      status: (input: { channel: string; external_id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; error?: string }) =>
        request<{ message_id: string; status: string }>('POST', '/apps/messages/status', input),
    },
    /** Install status, granted and pending scopes. */
    installation: () => oauthGet<Record<string, unknown>>('/installation'),
    /** Current signing secret (after an `app.secret_rotated` event). */
    webhookSecret: () => oauthGet<{ secret: string | null }>('/webhook-secret'),
  };
}

export type AmableClient = ReturnType<typeof createAmableClient>;
