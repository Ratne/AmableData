/**
 * Kapso webhooks: `X-Webhook-Signature` is the hex HMAC-SHA256 of the raw
 * body with the webhook's secret key; `X-Webhook-Event` names the event.
 * With buffering on, one request carries `{ batch: true, data: [...] }`.
 * https://docs.kapso.ai/docs/platform/webhooks/security
 */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function kapsoSignature(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
}

export async function verifyKapsoSignature(
  secret: string,
  rawBody: string,
  header: string | null,
): Promise<boolean> {
  if (header === null || !/^(sha256=)?[0-9a-f]{64}$/i.test(header.trim())) return false;
  const given = header
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, '');
  return safeEqual(given, await kapsoSignature(secret, rawBody));
}

export interface KapsoEvent {
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

/** The events of one delivery (one, or many when batched). */
export function eventsOf(eventHeader: string | null, body: unknown): KapsoEvent[] {
  if (body === null || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const event = eventHeader ?? (typeof record['type'] === 'string' ? record['type'] : '');
  if (record['batch'] === true && Array.isArray(record['data'])) {
    const type = typeof record['type'] === 'string' ? record['type'] : event;
    return (record['data'] as unknown[])
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((payload) => ({ event: type, payload }));
  }
  return [{ event, payload: record }];
}

export interface KapsoMessage {
  readonly id: string;
  readonly type: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly text: string;
  readonly timestamp: string | null;
  readonly direction: string | null;
  readonly origin: string | null;
  readonly status: string | null;
  readonly error: string | null;
}

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);

/** Text shown in the CRM thread for any WhatsApp message type. */
function textOf(message: Record<string, unknown>, kapso: Record<string, unknown>): string {
  const type = str(message['type']) ?? 'unknown';
  const content = str(kapso['content']);
  const body = str((message['text'] as Record<string, unknown> | undefined)?.['body']);
  if (body !== null) return body;
  const caption = str((message[type] as Record<string, unknown> | undefined)?.['caption']);
  const transcript = str((kapso['transcript'] as Record<string, unknown> | undefined)?.['text']);
  if (content !== null) return content;
  if (transcript !== null) return `[${type}] ${transcript}`;
  return caption === null ? `[${type}]` : `[${type}] ${caption}`;
}

export function messageOf(payload: Record<string, unknown>): KapsoMessage | null {
  const message = payload['message'];
  if (message === null || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;
  const kapso = (m['kapso'] ?? {}) as Record<string, unknown>;
  const id = str(m['id']);
  if (id === null) return null;
  const statuses = Array.isArray(kapso['statuses'])
    ? (kapso['statuses'] as Array<Record<string, unknown>>)
    : [];
  const errors = statuses.flatMap((s) =>
    Array.isArray(s['errors']) ? (s['errors'] as Array<Record<string, unknown>>) : [],
  );
  const last = errors.at(-1);
  const error =
    last === undefined
      ? null
      : [
          str(last['title']),
          str(last['message']) ??
            str((last['error_data'] as Record<string, unknown> | undefined)?.['details']),
        ]
          .filter((part, i, all) => part !== null && all.indexOf(part) === i)
          .join(': ') || `WhatsApp error ${String(last['code'] ?? '')}`.trim();
  return {
    id,
    type: str(m['type']) ?? 'unknown',
    from: str(m['from']),
    to: str(m['to']),
    text: textOf(m, kapso).slice(0, 4096),
    timestamp: str(m['timestamp']),
    direction: str(kapso['direction']),
    origin: str(kapso['origin']),
    status: str(kapso['status']),
    error,
  };
}

/** `message.timestamp` is a Unix epoch string. */
export function sentAt(timestamp: string | null): string | undefined {
  if (timestamp === null || !/^\d{9,11}$/.test(timestamp)) return undefined;
  return new Date(Number(timestamp) * 1000).toISOString();
}

export function contactNameOf(payload: Record<string, unknown>): {
  given_name?: string;
  family_name?: string;
} {
  const name = str(
    (payload['conversation'] as Record<string, unknown> | undefined)?.['contact_name'],
  )?.trim();
  if (name === undefined || name === '') return {};
  const [given, ...rest] = name.split(/\s+/);
  return {
    given_name: given!.slice(0, 100),
    ...(rest.length === 0 ? {} : { family_name: rest.join(' ').slice(0, 100) }),
  };
}
