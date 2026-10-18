import { ProviderError } from './errors';
import type { ProviderConfig, SpendQuery } from './types';

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export type ErrorParser = (status: number, body: unknown) => ProviderError;

/**
 * One HTTP call with JSON response. Transport failures and unreadable 2xx
 * bodies are retryable; non-2xx responses are classified by `parseError`.
 */
export async function requestJson(
  config: ProviderConfig,
  req: HttpRequest,
  parseError: ErrorParser,
): Promise<unknown> {
  let res: Response;
  try {
    res = await config.fetch(req.url, {
      method: req.method,
      headers: req.headers ?? {},
      ...(req.body === undefined ? {} : { body: req.body }),
    });
  } catch (error) {
    throw new ProviderError(
      'retryable',
      `network error: ${error instanceof Error ? error.message : String(error)}`,
      {
        platformCode: 'network',
      },
    );
  }
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw parseError(res.status, body);
  if (body === null) {
    throw new ProviderError('retryable', `unreadable response (${String(res.status)})`, {
      status: res.status,
      platformCode: 'invalid_json',
    });
  }
  return body;
}

export function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function withQuery(base: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return qs === '' ? base : `${base}?${qs}`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function asInt(value: unknown): number | null {
  const text = asString(value);
  if (text === undefined || text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

export function asNumber(value: unknown): number | null {
  const text = asString(value);
  if (text === undefined || text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects malformed ranges before they reach a query string or GAQL. */
export function assertSpendQuery(query: SpendQuery): void {
  if (!DAY_RE.test(query.from) || !DAY_RE.test(query.to) || query.from > query.to) {
    throw new ProviderError('permanent', `invalid spend range ${query.from}..${query.to}`, {
      platformCode: 'invalid_range',
    });
  }
}

/** Platform statuses folded to `active | paused | archived | deleted` (others lower-cased as is). */
export function normalizeStatus(raw: unknown): string {
  const status = (asString(raw) ?? 'unknown').toUpperCase();
  if (status === 'ACTIVE' || status === 'ENABLED' || status === 'ENABLE') return 'active';
  if (status === 'PAUSED' || status === 'DISABLE' || status.endsWith('_PAUSED')) return 'paused';
  if (status === 'ARCHIVED') return 'archived';
  if (status === 'DELETED' || status === 'REMOVED' || status === 'DELETE') return 'deleted';
  return status.toLowerCase().slice(0, 64);
}

export function entityName(raw: unknown, fallback: string): string {
  const name = asString(raw)?.trim();
  return (name === undefined || name === '' ? fallback : name).slice(0, 500);
}

export function upperCurrency(raw: unknown, fallback = 'USD'): string {
  const code = asString(raw)?.trim().toUpperCase();
  return code !== undefined && /^[A-Z]{3}$/.test(code) ? code : fallback;
}
