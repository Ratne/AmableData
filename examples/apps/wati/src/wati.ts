/**
 * WATI (WhatsApp Business API) for one workspace: its API endpoint
 * (`https://<server>.wati.io/<account id>`) and access token, from the WATI
 * dashboard under API Docs. https://docs.wati.io/reference
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface WatiConfig {
  readonly endpoint: string;
  readonly token: string;
}

export const WATI_TIMEOUT_MS = 8_000;

/** Only WATI hosts: the endpoint comes from the user and the app calls it with a secret. */
export function normalizeEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !(url.hostname === 'wati.io' || url.hostname.endsWith('.wati.io'))) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '')}`;
  } catch {
    return null;
  }
}

/** WATI wants the number without `+` (country code first). */
export const waNumber = (phone: string): string => phone.replace(/\D/g, '').replace(/^00/, '');

export class WatiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(config: WatiConfig, path: string, init: RequestInit, fetcher: Fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`${config.endpoint}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.token.replace(/^Bearer\s+/i, '')}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(WATI_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new WatiError(typeof body['info'] === 'string' ? body['info'] : `WATI answered HTTP ${String(response.status)}`, response.status);
  // WATI reports refusals in a 200 with `result: false` (e.g. outside the 24 h session window).
  if (body['result'] === false || body['result'] === 'false') {
    throw new WatiError(typeof body['info'] === 'string' && body['info'] !== '' ? body['info'] : 'WATI refused the message', 422);
  }
  return body;
}

function messageIdOf(body: Record<string, unknown>): string | null {
  const message = (body['message'] ?? {}) as Record<string, unknown>;
  for (const value of [message['whatsappMessageId'], message['id'], body['whatsappMessageId'], body['id'], body['localMessageId']]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** A free-text reply; WhatsApp accepts it only within 24 h of the contact's last message. */
export async function sendSessionMessage(config: WatiConfig, to: string, text: string, fetcher: Fetch = fetch): Promise<string | null> {
  const query = new URLSearchParams({ messageText: text });
  const body = await call(config, `/api/v1/sendSessionMessage/${waNumber(to)}?${query.toString()}`, { method: 'POST' }, fetcher);
  return messageIdOf(body);
}

/** An approved template: the only way to write first, or after 24 h. */
export async function sendTemplateMessage(
  config: WatiConfig,
  to: string,
  input: { template: string; broadcast: string; parameters: Array<{ name: string; value: string }> },
  fetcher: Fetch = fetch,
): Promise<string | null> {
  const body = await call(
    config,
    `/api/v1/sendTemplateMessage?${new URLSearchParams({ whatsappNumber: waNumber(to) }).toString()}`,
    { method: 'POST', body: JSON.stringify({ template_name: input.template, broadcast_name: input.broadcast, parameters: input.parameters }) },
    fetcher,
  );
  return messageIdOf(body);
}

export async function checkConfig(config: WatiConfig, fetcher: Fetch = fetch): Promise<boolean> {
  try {
    await call(config, `/api/v1/getContacts?${new URLSearchParams({ pageSize: '1', pageNumber: '1' }).toString()}`, { method: 'GET' }, fetcher);
    return true;
  } catch {
    return false;
  }
}

/** `name=value` lines (template parameters typed in the automation editor). */
export function parseParameters(text: string): Array<{ name: string; value: string }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
    })
    .filter((p) => p.name !== '');
}

export type WatiEvent =
  | { kind: 'message'; externalId: string; from: string; text: string; senderName: string | null; sentAt: string | null }
  | { kind: 'status'; externalId: string; status: 'delivered' | 'read' | 'failed'; error: string | null }
  | { kind: 'ignored' };

const TYPE_LABELS: Record<string, string> = {
  image: '[image]',
  video: '[video]',
  audio: '[audio]',
  voice: '[voice message]',
  document: '[document]',
  sticker: '[sticker]',
  location: '[location]',
  contacts: '[contact card]',
};

/** A WATI webhook body: an incoming message, a delivery update, or something the inbox does not need. */
export function parseWebhook(body: Record<string, unknown>): WatiEvent {
  const eventType = String(body['eventType'] ?? '');
  const externalId = [body['whatsappMessageId'], body['id'], body['localMessageId']].find((v): v is string => typeof v === 'string' && v !== '');
  if (externalId === undefined) return { kind: 'ignored' };
  if (eventType === 'message') {
    // `owner: true` is a message an operator sent from the WATI dashboard.
    if (body['owner'] === true) return { kind: 'ignored' };
    const waId = String(body['waId'] ?? '');
    if (waId.replace(/\D/g, '').length < 6) return { kind: 'ignored' };
    const type = String(body['type'] ?? 'text');
    const text = typeof body['text'] === 'string' && body['text'] !== '' ? body['text'] : (TYPE_LABELS[type] ?? `[${type}]`);
    const seconds = Number(body['timestamp']);
    return {
      kind: 'message',
      externalId,
      from: `+${waId.replace(/\D/g, '')}`,
      text: text.slice(0, 4096),
      senderName: typeof body['senderName'] === 'string' && body['senderName'] !== '' ? body['senderName'].slice(0, 100) : null,
      sentAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    };
  }
  const status = /READ/i.test(eventType) ? 'read' : /DELIVERED/i.test(eventType) ? 'delivered' : /FAILED/i.test(eventType) ? 'failed' : null;
  if (status === null) return { kind: 'ignored' };
  const error = status === 'failed' && typeof body['failedDetail'] === 'string' ? body['failedDetail'].slice(0, 500) : null;
  return { kind: 'status', externalId, status, error };
}
