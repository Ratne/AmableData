import type { CatalogOperation } from './catalog';

/** Same Hono app, same worker: a request costs no network hop and runs every guard of the route. */
export type Fetcher = (request: Request) => Promise<Response>;

export interface DispatchTarget {
  readonly fetcher: Fetcher;
  readonly origin: string;
  readonly slug: string;
  readonly authorization: string;
  readonly requestId: string | null;
}

export interface DispatchInput {
  readonly pathParams?: Record<string, unknown> | undefined;
  readonly query?: Record<string, unknown> | undefined;
  readonly body?: unknown;
  /** Raw-body operations (CSV, images, PDF): the bytes, base64-encoded. */
  readonly bodyBase64?: string | undefined;
  readonly contentType?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface DispatchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly data: unknown;
  readonly retryAfter: number | null;
  readonly contentType: string | null;
}

export class DispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Largest binary response returned inline (base64); bigger files only report their size. */
const MAX_BINARY_BYTES = 256 * 1024;

function scalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function buildPath(op: CatalogOperation, pathParams: Record<string, unknown> = {}): string {
  return op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams[name];
    if (value === undefined || value === null || scalar(value) === '') {
      throw new DispatchError(
        'missing_path_param',
        `Path parameter "${name}" is required for ${op.id}.`,
      );
    }
    return encodeURIComponent(scalar(value));
  });
}

export function buildQuery(query: Record<string, unknown> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) search.append(key, scalar(item));
    else search.append(key, scalar(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function requestBody(
  op: CatalogOperation,
  input: DispatchInput,
): { body: BodyInit | null; contentType: string | null } {
  if (op.transport === 'raw_body') {
    const contentType = input.contentType ?? op.bodyContentType ?? 'application/octet-stream';
    if (input.bodyBase64 !== undefined) {
      try {
        return { body: decodeBase64(input.bodyBase64), contentType };
      } catch {
        throw new DispatchError('invalid_base64', 'body_base64 is not valid base64.');
      }
    }
    if (typeof input.body === 'string') return { body: input.body, contentType };
    throw new DispatchError(
      'missing_body',
      `${op.id} takes a raw ${contentType} body: pass body_base64 (or body as text).`,
    );
  }
  if (input.body === undefined || input.body === null) {
    return op.method === 'GET' || op.method === 'DELETE' || op.bodyContentType === null
      ? { body: null, contentType: null }
      : { body: '{}', contentType: 'application/json' };
  }
  return { body: JSON.stringify(input.body), contentType: 'application/json' };
}

/** Builds the REST request of one operation and runs it with the caller's own credentials. */
export async function dispatch(
  target: DispatchTarget,
  op: CatalogOperation,
  input: DispatchInput,
): Promise<DispatchResult> {
  if (op.transport === 'websocket') {
    throw new DispatchError(
      'websocket_only',
      `${op.id} is a WebSocket upgrade (edit lock) and cannot run over MCP; use the matching lock/status operation to see who is editing.`,
    );
  }
  const url = `${target.origin}/api/v2/t/${encodeURIComponent(target.slug)}${buildPath(op, input.pathParams)}${buildQuery(input.query)}`;
  const { body, contentType } = requestBody(op, input);
  const headers = new Headers({ authorization: target.authorization, accept: 'application/json' });
  if (contentType !== null) headers.set('content-type', contentType);
  if (input.idempotencyKey !== undefined) headers.set('idempotency-key', input.idempotencyKey);
  if (target.requestId !== null) headers.set('x-request-id', target.requestId);

  const response = await target.fetcher(new Request(url, { method: op.method, headers, body }));
  const retry = response.headers.get('retry-after');
  const responseType = response.headers.get('content-type');
  let data: unknown = null;
  if (response.status !== 204) {
    if (responseType === null || /json/i.test(responseType)) {
      const text = await response.text();
      try {
        data = text === '' ? null : (JSON.parse(text) as unknown);
      } catch {
        data = text;
      }
    } else if (/^text\/|csv|xml|html/i.test(responseType)) {
      data = await response.text();
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      data =
        bytes.byteLength <= MAX_BINARY_BYTES
          ? { content_type: responseType, size: bytes.byteLength, base64: encodeBase64(bytes) }
          : {
              content_type: responseType,
              size: bytes.byteLength,
              omitted: 'File too large to return inline.',
            };
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    data,
    retryAfter: retry === null || Number.isNaN(Number(retry)) ? null : Number(retry),
    contentType: responseType,
  };
}
