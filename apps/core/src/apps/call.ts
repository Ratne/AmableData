import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@amable/auth';
import { appEndpointUrl } from '@amable/core/apps';
import type { Env } from '../env';
import { currentWebhookSecret } from './events';
import { appFetch } from './http';
import { recordAppMetric, type AppMetricKind } from './metrics';
import type { AppInstall } from './store';

/**
 * Synchronous, signed request from the CRM to an app (hooks, actions, privacy
 * data requests, channel sends). Signed like webhooks: `Amable-Signature`
 * with the install's webhook secret, plus who is calling and in which version.
 */

export interface AppCallResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly error: string | null;
  readonly durationMs: number;
}

export async function callApp(
  env: Env,
  install: AppInstall,
  path: string,
  payload: Record<string, unknown>,
  options: { kind: AppMetricKind; timeoutMs?: number; maxBytes?: number; idempotencyKey?: string; nowMs?: () => number },
): Promise<AppCallResult> {
  const now = options.nowMs ?? (() => Date.now());
  const started = now();
  const tenant = await env.DB.prepare(`SELECT slug FROM tenants WHERE id = ?`).bind(install.tenantId).first<{ slug: string }>();
  const body = JSON.stringify({
    installation_id: install.id,
    tenant: tenant?.slug ?? null,
    api_version: install.apiVersion,
    ...payload,
  });
  let result: AppCallResult;
  try {
    const secret = await currentWebhookSecret(env, install.id);
    if (secret === null) throw new Error('install has no secret');
    const response = await appFetch(
      env,
      appEndpointUrl(install.manifest, path),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'AmableData-Apps/1',
          [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(secret, body, now()),
          'Amable-Installation': install.id,
          'Amable-Api-Version': install.apiVersion,
          ...(options.idempotencyKey === undefined ? {} : { 'Idempotency-Key': options.idempotencyKey }),
        },
        body,
      },
      { timeoutMs: options.timeoutMs ?? 10_000, maxBytes: options.maxBytes ?? 256 * 1024 },
    );
    let parsed: unknown = null;
    try {
      parsed = response.text === '' ? null : (JSON.parse(response.text) as unknown);
    } catch {
      parsed = response.text.slice(0, 500);
    }
    const ok = response.status >= 200 && response.status < 300;
    result = {
      ok,
      status: response.status,
      body: parsed,
      error: ok ? null : `HTTP ${String(response.status)}`,
      durationMs: now() - started,
    };
  } catch (error) {
    result = {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message.slice(0, 200) : 'network error',
      durationMs: now() - started,
    };
  }
  await recordAppMetric(env.DB, {
    installId: install.id,
    kind: options.kind,
    ok: result.ok,
    durationMs: result.durationMs,
    nowMs: now(),
  }).catch(() => undefined);
  return result;
}
