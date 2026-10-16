import {
  EDGE_ERROR_REPORT_OP,
  EDGE_GATEWAY_DEV_SECRET,
  EDGE_GATEWAY_PATH,
  EDGE_GATEWAY_SIGNATURE_HEADER,
  EDGE_INSTALLATION_TENANT,
  type EdgeErrorReport,
  type GatewayRequest,
} from '@amable/api-types';
import { signWebhook } from '@amable/auth/security';
import type { Env } from './env';

/**
 * Error reporter of the edge worker. The edge has no D1 and no license: it
 * logs locally and forwards a minimal report to the core over the signed
 * gateway, where the installation reporter applies the provider selection
 * (`ERROR_REPORTING`: local logs in self-hosted, control plane in managed)
 * and scrubs. Never throws; at most `MAX_FORWARDS_PER_MINUTE` per isolate.
 */

export const MAX_FORWARDS_PER_MINUTE = 30;
const MAX_MESSAGE = 1_000;
const MAX_STACK = 8_000;

let windowStart = 0;
let forwarded = 0;

export interface EdgeErrorMeta {
  readonly source: EdgeErrorReport['source'];
  readonly module: string | null;
  readonly route?: string | null;
}

function describe(error: unknown): Pick<EdgeErrorReport, 'errorType' | 'message' | 'stack'> {
  if (error instanceof Error) {
    const name = error.name !== '' && error.name !== 'Error' ? error.name : error.constructor.name;
    return {
      errorType: (name === '' ? 'Error' : name).slice(0, 100),
      message: error.message.slice(0, MAX_MESSAGE),
      stack: error.stack?.slice(0, MAX_STACK) ?? null,
    };
  }
  return { errorType: error === null ? 'null' : typeof error, message: typeof error === 'string' ? error.slice(0, MAX_MESSAGE) : '', stack: null };
}

function gatewaySecret(env: Env): string | null {
  if (env.EDGE_GATEWAY_SECRET !== undefined && env.EDGE_GATEWAY_SECRET !== '') return env.EDGE_GATEWAY_SECRET;
  return env.ENVIRONMENT === 'dev' ? EDGE_GATEWAY_DEV_SECRET : null;
}

function nonce(): string {
  let binary = '';
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function reportEdgeError(env: Env, error: unknown, meta: EdgeErrorMeta, nowMs = Date.now()): Promise<void> {
  try {
    const report: EdgeErrorReport = { source: meta.source, module: meta.module, route: meta.route ?? null, ...describe(error) };
    console.error(`[edge-error] ${report.source}${report.route === null ? '' : ` ${report.route}`} ${report.errorType}: ${report.message}`);
    const secret = gatewaySecret(env);
    if (env.CORE === undefined || secret === null) return;
    if (nowMs - windowStart >= 60_000) {
      windowStart = nowMs;
      forwarded = 0;
    }
    if (forwarded >= MAX_FORWARDS_PER_MINUTE) return;
    forwarded += 1;
    const envelope: GatewayRequest = {
      nonce: nonce(),
      op: EDGE_ERROR_REPORT_OP,
      tenant: EDGE_INSTALLATION_TENANT,
      client: { ip: null, userAgent: null, country: null, visitorId: null, referer: null, acceptLanguage: null },
      input: report,
    };
    const body = JSON.stringify(envelope);
    const res = await env.CORE.fetch(`https://core.internal${EDGE_GATEWAY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [EDGE_GATEWAY_SIGNATURE_HEADER]: await signWebhook(secret, body) },
      body,
    });
    await res.body?.cancel();
  } catch (failure) {
    console.error('[edge-error] reporter failed', failure instanceof Error ? failure.name : typeof failure);
  }
}

/** Runs `fn`, reports what it throws and rethrows (queue / alarm retry semantics unchanged). */
export async function withEdgeErrorReporting<R>(env: Env, meta: EdgeErrorMeta, fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (error) {
    await reportEdgeError(env, error, meta);
    throw error;
  }
}

/** Test hook. */
export function resetEdgeErrorBudget(): void {
  windowStart = 0;
  forwarded = 0;
}
