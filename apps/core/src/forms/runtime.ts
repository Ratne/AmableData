import type { RateLimiter, SecretBox, TurnstileVerifier } from '@amable/auth';
import type { OAuthTokenProvider, SystemEmailProvider } from '@amable/core';
import { getAuthServices } from '../auth/services';
import type { CrmActor } from '../crm/context';
import { CrmError } from '../crm/errors';
import type { CrmOpInput, CrmOpName, CrmOpOutput, CrmResult } from '../crm/ops';
import type { Env } from '../env';
import { oauthTokenProvider } from '../providers/select';

/**
 * Outside-world dependencies of the forms pipeline (encryption, outgoing
 * HTTP, staff email, OAuth tokens, Turnstile). Built from the auth services;
 * tests swap single pieces with `overrideFormsRuntime` — no network, ever.
 */
export interface FormsRuntime {
  now(): number;
  secretBox: SecretBox;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  email: SystemEmailProvider;
  oauth: OAuthTokenProvider;
  turnstile: TurnstileVerifier;
  turnstileSiteKey: string | null;
  /** Per-IP limit of public submissions. */
  limiter: RateLimiter;
}

type Override = (base: FormsRuntime, env: Env) => FormsRuntime;

let override: Override | null = null;

/** Test hook (pass `null` to restore). */
export function overrideFormsRuntime(next: Override | null): void {
  override = next;
}

export async function formsRuntime(env: Env): Promise<FormsRuntime> {
  const services = await getAuthServices(env);
  const base: FormsRuntime = {
    now: services.now,
    secretBox: services.secretBox,
    fetch: (input, init) => fetch(input, init),
    email: services.email,
    oauth: oauthTokenProvider(env, services.secretBox),
    turnstile: services.turnstile,
    turnstileSiteKey: services.turnstileSiteKey,
    limiter: services.ipLimiter,
  };
  return override === null ? base : override(base, env);
}

/** Calls a TenantDb op of `tenantId` from a worker context without a request (queue, background). */
export async function tenantOp<K extends CrmOpName>(
  env: Env,
  tenantId: string,
  actor: CrmActor,
  op: K,
  input: CrmOpInput<K>,
): Promise<CrmOpOutput<K>> {
  const stub = env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId));
  const result = (await stub.crm(op, actor, input)) as CrmResult<CrmOpOutput<K>>;
  if (!result.ok) throw new CrmError(result.error.code, result.error.message, result.error.details);
  return result.value;
}
