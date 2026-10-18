import type { FunnelEffect } from '../funnel-engine';

export type WebhookEffect = Extract<FunnelEffect, { type: 'webhook' }>;

export const WEBHOOK_TIMEOUT_MS = 5_000;

export interface WebhookOutcome {
  nodeId: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/** Webhooks go to public http(s) hosts only: no loopback, link-local or private literals. */
export function webhookTargetAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (PRIVATE_V4.some((re) => re.test(host))) return false;
  if (host.includes(':')) return !(host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  return true;
}

/** Delivers one webhook effect; never throws. Payloads are not logged, outcomes are. */
export async function deliverWebhook(
  effect: WebhookEffect,
  fetcher: typeof fetch = fetch,
  timeoutMs: number = WEBHOOK_TIMEOUT_MS,
): Promise<WebhookOutcome> {
  let outcome: WebhookOutcome;
  if (!webhookTargetAllowed(effect.url)) {
    outcome = { nodeId: effect.nodeId, ok: false, status: null, error: 'blocked_target' };
  } else {
    try {
      const headers = new Headers(effect.headers);
      if (effect.method === 'POST' && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const response = await fetcher(effect.url, {
        method: effect.method,
        headers,
        ...(effect.method === 'POST' ? { body: effect.body ?? '' } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      outcome = { nodeId: effect.nodeId, ok: response.ok, status: response.status };
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      outcome = { nodeId: effect.nodeId, ok: false, status: null, error: timeout ? 'timeout' : 'network_error' };
    }
  }
  console.log('[links] webhook', JSON.stringify(outcome));
  return outcome;
}
