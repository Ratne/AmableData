import type { OutboundConversionJob, OutboundPayload } from '@amable/api-types';
import type { ProviderConfig } from '../src';

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  /** Parsed `body` (JSON or form-urlencoded). */
  readonly json: unknown;
}

export type MockReply = { status?: number; body: unknown } | Error;

/** fetch replaying `replies` in order and recording every request. */
export function queueFetch(replies: MockReply[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...replies];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = typeof init?.body === 'string' ? init.body : undefined;
    let json: unknown;
    if (body !== undefined) {
      json =
        headers['content-type'] === 'application/x-www-form-urlencoded'
          ? Object.fromEntries(new URLSearchParams(body))
          : JSON.parse(body);
    }
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body, json });
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`unexpected request ${String(input)}`);
    if (reply instanceof Error) throw reply;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as typeof fetch, calls };
}

export const NOW = Date.UTC(2026, 9, 15, 10);

export function config(fetchFn: typeof fetch, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    clientId: 'client-1',
    clientSecret: 'secret-1',
    fetch: fetchFn,
    now: () => NOW,
    ...extra,
  };
}

export function query(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

export function path(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export function job(
  payload: Partial<OutboundPayload> = {},
  extra: Partial<OutboundConversionJob> = {},
): OutboundConversionJob {
  return {
    id: 'job-1',
    platform: 'meta',
    connection_id: 'conn-1',
    kind: 'purchase',
    status: 'pending',
    attempts: 0,
    event_id: 'evt-abc',
    created_at: NOW,
    payload: {
      event_name: 'Purchase',
      event_time: Date.UTC(2026, 9, 15, 9, 30, 15),
      value_minor: 4999,
      currency: 'EUR',
      order_id: 'ord-7',
      click_ids: {},
      ...payload,
    },
    ...extra,
  };
}

export const HASH = {
  johnsmithGmail: '3586de92bb3636d0885a12eff961429a32e4ebd764b96f50d85d016f9338d586',
  johnDotSmithExample: '8e621e3d0368631d263d07a351fa8d34fba0d17c15fbcdec11a5f58008d022a0',
  testExample: '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b',
  phoneIt: '0efc79e9473975b30516d1873027513a35fb5ed450f0e6c13e368c4e38eceeeb',
  phoneItPlus: '78f00e1ca317fb2af02c89b17b8b07382ff70336aba0997ad1f3ef3645b4e682',
  phoneUs: 'd6736136ea896c1bfdc553e0e86e702c70d060d805696ca3e4e9e0961353860a',
  phoneUsPlus: '8a59780bb8cd2ba022bfa5ba2ea3b6e07af17a7d8b30c1f9b3390e36f69019e4',
  user42: '6d894aa3ee802549d7f340e7c1cf0d1c1cb14cd84f768d92ffaa6785337c4997',
} as const;
