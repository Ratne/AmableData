import type { AppAutomationAction, AppInputSchema, AppManifest } from '@amable/core/apps';
import type { AppActionCatalog } from '../automation/validate';
import type { Env } from '../env';
import { callApp } from './call';
import { installFor, isRunning, toInstall, type InstallRow } from './store';

/**
 * Automation actions declared by apps (`extensions.automation_actions`), run by
 * the `app_action` step through a signed call to the app. A step whose app is
 * not running is skipped, so uninstalling an app never breaks an automation.
 */

export interface AppActionContact {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

export interface AppActionRequest {
  readonly appId: string;
  readonly actionKey: string;
  /** Input with merge tags already resolved. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly contactId: string;
  readonly contact: AppActionContact | null;
  readonly idempotencyKey: string;
  readonly automation: { readonly id: string; readonly versionId: string; readonly nodeId: string; readonly stepId: string };
}

export type AppActionOutcome =
  | { readonly kind: 'skipped'; readonly reason: 'not_installed' | 'paused' | 'unknown_action' }
  | { readonly kind: 'ok'; readonly status: number; readonly output: Record<string, unknown> }
  | { readonly kind: 'failed'; readonly status: number; readonly error: string; readonly transient: boolean };

export interface AppActionPort {
  run(request: AppActionRequest): Promise<AppActionOutcome>;
}

export function findAction(manifest: AppManifest, key: string): AppAutomationAction | null {
  return manifest.extensions.automation_actions?.find((action) => action.key === key) ?? null;
}

function pickOutput(action: AppAutomationAction, body: unknown): Record<string, unknown> {
  const raw =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? ((body as Record<string, unknown>)['output'] ?? body)
      : {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const keys = action.output_keys ?? [];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
  }
  return out;
}

export async function runAppAction(env: Env, tenantId: string, request: AppActionRequest): Promise<AppActionOutcome> {
  const install = await installFor(env.DB, tenantId, request.appId);
  if (install === null || !['active', 'paused'].includes(install.status)) return { kind: 'skipped', reason: 'not_installed' };
  if (!isRunning(install)) return { kind: 'skipped', reason: 'paused' };
  const action = findAction(install.manifest, request.actionKey);
  if (action === null) return { kind: 'skipped', reason: 'unknown_action' };
  const result = await callApp(
    env,
    install,
    action.endpoint,
    {
      action: action.key,
      input: request.input,
      contact_id: request.contactId,
      contact: install.scopes.includes('contacts:read') ? request.contact : null,
      automation: {
        id: request.automation.id,
        version_id: request.automation.versionId,
        node_id: request.automation.nodeId,
        step_id: request.automation.stepId,
      },
      idempotency_key: request.idempotencyKey,
    },
    { kind: 'action', timeoutMs: 15_000, idempotencyKey: request.idempotencyKey },
  );
  if (result.ok) return { kind: 'ok', status: result.status, output: pickOutput(action, result.body) };
  const transient = result.status === 0 || result.status >= 500 || [408, 425, 429].includes(result.status);
  const detail =
    typeof result.body === 'object' && result.body !== null && typeof (result.body as Record<string, unknown>)['error'] === 'string'
      ? `: ${String((result.body as Record<string, unknown>)['error']).slice(0, 200)}`
      : '';
  return { kind: 'failed', status: result.status, error: `${result.error ?? 'failed'}${detail}`, transient };
}

export function appActionPort(env: Env, tenantId: string): AppActionPort {
  return { run: (request) => runAppAction(env, tenantId, request) };
}

/** Actions of the installed apps (active or paused), for publish validation of `app_action` steps. */
export async function appActionCatalog(env: Env, tenantId: string): Promise<AppActionCatalog> {
  const rows = await env.DB.prepare(
    `SELECT * FROM app_installs WHERE tenant_id = ? AND status IN ('active', 'paused')`,
  )
    .bind(tenantId)
    .all<InstallRow>();
  const catalog: Record<string, Record<string, AppInputSchema>> = {};
  for (const install of rows.results.map(toInstall)) {
    const actions: Record<string, AppInputSchema> = {};
    for (const action of install.manifest.extensions.automation_actions ?? []) actions[action.key] = action.input_schema;
    catalog[install.appId] = actions;
  }
  return catalog;
}
