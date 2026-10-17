import { sha256Hex } from '@amable/auth';
import type { Env } from '../env';
import { callApp } from './call';
import { activeInstalls, type AppInstall } from './store';
import { tenantOp, appActor } from './tenant';

/**
 * `contact.validate`: apps that declare it check email/phone values when a
 * contact is created by hand, through a public form or an import. Fail-open:
 * a slow or broken app never blocks a save. Each app has a circuit breaker
 * (after BREAKER_THRESHOLD failures in a row the hook is skipped for
 * BREAKER_OPEN_MS) and results are cached per value for the app's TTL.
 */

export const HOOK_TIMEOUT_MS = 1_500;
export const BATCH_TIMEOUT_MS = 10_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 5 * 60_000;
export const BATCH_MAX_ITEMS = 100;

export type ValidateSource = 'crm' | 'form' | 'import';

export interface ValidateValues {
  readonly email?: string | null;
  readonly phone?: string | null;
}

export interface AppValidation {
  readonly app_id: string;
  readonly app_name: string;
  /** `null`: the app could not answer (timeout, error, breaker open); treated as valid. */
  readonly valid: boolean | null;
  readonly reason: string | null;
  /** Fields the answer is about (`email`, `phone`). */
  readonly fields: string[];
  readonly set_fields: Record<string, string | number | boolean | null>;
  readonly tags: string[];
  readonly entity_data: Record<string, unknown>;
  readonly cached: boolean;
}

function hookOf(install: AppInstall) {
  return install.manifest.extensions.contact_validate ?? null;
}

/** Values the app looks at (its declared fields), normalized; null when it has nothing to check. */
function relevant(install: AppInstall, values: ValidateValues): Record<string, string> | null {
  const hook = hookOf(install);
  if (hook === null) return null;
  const out: Record<string, string> = {};
  for (const field of hook.fields) {
    const raw = values[field];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    out[field] = field === 'email' ? raw.trim().toLowerCase() : raw.replace(/[\s().-]/g, '');
  }
  return Object.keys(out).length === 0 ? null : out;
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Parses an app answer `{valid, reason?, fields?, tags?, entity_data?}`; anything else is "no answer". */
function parseAnswer(install: AppInstall, checked: string[], body: unknown, cached: boolean): AppValidation | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const answer = body as Record<string, unknown>;
  if (typeof answer['valid'] !== 'boolean') return null;
  const setFields: Record<string, string | number | boolean | null> = {};
  if (typeof answer['fields'] === 'object' && answer['fields'] !== null) {
    for (const [key, value] of Object.entries(answer['fields'] as Record<string, unknown>)) {
      if (scalar(value) && Object.keys(setFields).length < 20) setFields[key] = typeof value === 'string' ? value.slice(0, 1000) : value;
    }
  }
  const tags = Array.isArray(answer['tags'])
    ? answer['tags'].filter((t): t is string => typeof t === 'string').slice(0, 10)
    : [];
  const entityData =
    typeof answer['entity_data'] === 'object' && answer['entity_data'] !== null && !Array.isArray(answer['entity_data'])
      ? (answer['entity_data'] as Record<string, unknown>)
      : {};
  return {
    app_id: install.appId,
    app_name: install.manifest.name,
    valid: answer['valid'],
    reason: typeof answer['reason'] === 'string' ? answer['reason'].slice(0, 200) : null,
    fields: checked,
    set_fields: setFields,
    tags,
    entity_data: entityData,
    cached,
  };
}

function unknownResult(install: AppInstall, checked: string[]): AppValidation {
  return {
    app_id: install.appId,
    app_name: install.manifest.name,
    valid: null,
    reason: null,
    fields: checked,
    set_fields: {},
    tags: [],
    entity_data: {},
    cached: false,
  };
}

async function cacheKey(install: AppInstall, values: Record<string, string>): Promise<string> {
  const ordered = Object.keys(values)
    .sort()
    .map((k) => `${k}=${values[k] ?? ''}`)
    .join('\n');
  return sha256Hex(`${install.manifestHash}\n${ordered}`);
}

async function readCache(env: Env, install: AppInstall, key: string, nowMs: number): Promise<unknown> {
  const row = await env.DB.prepare(`SELECT result FROM app_hook_cache WHERE install_id = ? AND value_hash = ? AND expires_at > ?`)
    .bind(install.id, key, nowMs)
    .first<{ result: string }>();
  if (row === null) return undefined;
  try {
    return JSON.parse(row.result) as unknown;
  } catch {
    return undefined;
  }
}

async function writeCache(env: Env, install: AppInstall, key: string, body: unknown, nowMs: number): Promise<void> {
  const ttl = hookOf(install)?.cache_ttl_seconds ?? 0;
  if (ttl <= 0) return;
  await env.DB.prepare(
    `INSERT INTO app_hook_cache (install_id, value_hash, result, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(install_id, value_hash) DO UPDATE SET result = excluded.result, expires_at = excluded.expires_at`,
  )
    .bind(install.id, key, JSON.stringify(body), nowMs + ttl * 1000)
    .run();
}

function breakerOpen(install: AppInstall, nowMs: number): boolean {
  return install.hookOpenUntil !== null && install.hookOpenUntil > nowMs;
}

async function recordHookOutcome(env: Env, install: AppInstall, ok: boolean, nowMs: number): Promise<void> {
  if (ok) {
    if (install.hookFailures === 0 && install.hookOpenUntil === null) return;
    await env.DB.prepare(`UPDATE app_installs SET hook_failures = 0, hook_open_until = NULL WHERE id = ?`).bind(install.id).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE app_installs SET
       hook_open_until = CASE WHEN hook_failures + 1 >= ? THEN ? ELSE hook_open_until END,
       hook_failures = CASE WHEN hook_failures + 1 >= ? THEN 0 ELSE hook_failures + 1 END
     WHERE id = ?`,
  )
    .bind(BREAKER_THRESHOLD, nowMs + BREAKER_OPEN_MS, BREAKER_THRESHOLD, install.id)
    .run();
}

/** Active installs that declare `contact.validate`. */
export async function validateHooks(env: Env, tenantId: string): Promise<AppInstall[]> {
  return (await activeInstalls(env.DB, tenantId)).filter((install) => hookOf(install) !== null);
}

async function validateWith(
  env: Env,
  install: AppInstall,
  values: Record<string, string>,
  source: ValidateSource,
  nowMs: number,
): Promise<AppValidation> {
  const checked = Object.keys(values);
  const key = await cacheKey(install, values);
  const hit = await readCache(env, install, key, nowMs);
  if (hit !== undefined) return parseAnswer(install, checked, hit, true) ?? unknownResult(install, checked);
  if (breakerOpen(install, nowMs)) return unknownResult(install, checked);
  const result = await callApp(
    env,
    install,
    hookOf(install)!.endpoint,
    { hook: 'contact.validate', source, values },
    { kind: 'hook', timeoutMs: HOOK_TIMEOUT_MS, maxBytes: 32 * 1024 },
  );
  const parsed = result.ok ? parseAnswer(install, checked, result.body, false) : null;
  await recordHookOutcome(env, install, parsed !== null, nowMs);
  if (parsed === null) return unknownResult(install, checked);
  await writeCache(env, install, key, result.body, nowMs);
  return parsed;
}

/** Asks every app that validates these values, in parallel. */
export async function validateContactValues(
  env: Env,
  tenantId: string,
  values: ValidateValues,
  source: ValidateSource,
  options: { installs?: AppInstall[]; nowMs?: number } = {},
): Promise<AppValidation[]> {
  const nowMs = options.nowMs ?? Date.now();
  const installs = options.installs ?? (await validateHooks(env, tenantId));
  const tasks = installs.flatMap((install) => {
    const own = relevant(install, values);
    return own === null ? [] : [validateWith(env, install, own, source, nowMs)];
  });
  return Promise.all(tasks);
}

/** Writes what the apps asked for on the contact (fields they own, tags, metadata); best effort. */
export async function applyValidationResults(
  env: Env,
  tenantId: string,
  contactId: string,
  results: readonly AppValidation[],
  installs: readonly AppInstall[],
): Promise<void> {
  for (const result of results) {
    const install = installs.find((i) => i.appId === result.app_id);
    if (install === undefined || !install.scopes.includes('contacts:write')) continue;
    if (Object.keys(result.set_fields).length === 0 && result.tags.length === 0 && Object.keys(result.entity_data).length === 0) continue;
    try {
      await tenantOp(
        env,
        tenantId,
        'apps.validation.apply',
        { appId: result.app_id, contactId, fields: result.set_fields, tags: result.tags, entityData: result.entity_data },
        appActor(result.app_id),
      );
    } catch (error) {
      console.warn('[apps] validation effects failed', result.app_id, error instanceof Error ? error.message : error);
    }
  }
}

/** Validation + effects for one contact (CRM saves and form submissions, advisory). */
export async function validateAndApply(
  env: Env,
  tenantId: string,
  contactId: string,
  values: ValidateValues,
  source: ValidateSource,
): Promise<AppValidation[]> {
  const installs = await validateHooks(env, tenantId);
  if (installs.length === 0) return [];
  const results = await validateContactValues(env, tenantId, values, source, { installs });
  await applyValidationResults(env, tenantId, contactId, results, installs);
  return results;
}

export interface BatchContact {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * Imports: one `batch_endpoint` call per app and chunk (`{items: [{ref, values}]}`
 * → `{results: [{ref, valid, …}]}`); apps without it are skipped, a per-row hook
 * would make large imports crawl.
 */
export async function validateImportBatch(
  env: Env,
  tenantId: string,
  contacts: readonly BatchContact[],
  options: { installs?: AppInstall[]; nowMs?: number } = {},
): Promise<number> {
  const nowMs = options.nowMs ?? Date.now();
  const installs = (options.installs ?? (await validateHooks(env, tenantId))).filter(
    (i) => hookOf(i)?.batch_endpoint !== undefined && !breakerOpen(i, nowMs),
  );
  let applied = 0;
  for (const install of installs) {
    for (let start = 0; start < contacts.length; start += BATCH_MAX_ITEMS) {
      const chunk = contacts.slice(start, start + BATCH_MAX_ITEMS).flatMap((contact) => {
        const values = relevant(install, contact);
        return values === null ? [] : [{ ref: contact.id, values }];
      });
      if (chunk.length === 0) continue;
      const result = await callApp(
        env,
        install,
        hookOf(install)!.batch_endpoint!,
        { hook: 'contact.validate', source: 'import', items: chunk },
        { kind: 'hook', timeoutMs: BATCH_TIMEOUT_MS, maxBytes: 512 * 1024 },
      );
      const answers =
        result.ok && typeof result.body === 'object' && result.body !== null && Array.isArray((result.body as Record<string, unknown>)['results'])
          ? ((result.body as Record<string, unknown>)['results'] as unknown[])
          : null;
      await recordHookOutcome(env, install, answers !== null, nowMs);
      if (answers === null) break;
      for (const raw of answers) {
        if (typeof raw !== 'object' || raw === null) continue;
        const ref = (raw as Record<string, unknown>)['ref'];
        const item = chunk.find((c) => c.ref === ref);
        if (item === undefined) continue;
        const parsed = parseAnswer(install, Object.keys(item.values), raw, false);
        if (parsed === null) continue;
        await writeCache(env, install, await cacheKey(install, item.values), raw, nowMs);
        await applyValidationResults(env, tenantId, item.ref, [parsed], [install]);
        applied += 1;
      }
    }
  }
  return applied;
}
