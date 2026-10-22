import type { StripeSettings } from '@amable/api-types';
import type { CrmContext } from '../../crm/context';
import { invalid } from '../../crm/errors';
import { parseJson, toIso } from '../../crm/util';

/**
 * Stripe account of the tenant (its own API keys), one `tenant_meta` row.
 * Secrets arrive already encrypted by the worker (SecretBox, bound to the
 * tenant id): the Durable Object never sees them in clear.
 */
export interface StoredStripeAccount {
  tenant_id: string;
  publishable_key: string;
  secret_enc: string;
  secret_hint: string;
  webhook_enc: string | null;
  webhook_hint: string | null;
  updated_at: number;
}

const META_KEY = 'commerce_stripe';

export function stripeAccountAd(tenantId: string, kind: 'secret' | 'webhook'): string {
  return `stripe-${kind}:${tenantId}`;
}

export function readStripeAccount(ctx: CrmContext): StoredStripeAccount | null {
  const row = ctx.db.all<{ value: string }>(`SELECT value FROM tenant_meta WHERE key = ?`, META_KEY)[0];
  if (row === undefined) return null;
  const parsed = parseJson<Partial<StoredStripeAccount>>(row.value, {});
  if (
    typeof parsed.tenant_id !== 'string' ||
    typeof parsed.publishable_key !== 'string' ||
    typeof parsed.secret_enc !== 'string'
  ) {
    return null;
  }
  return {
    tenant_id: parsed.tenant_id,
    publishable_key: parsed.publishable_key,
    secret_enc: parsed.secret_enc,
    secret_hint: parsed.secret_hint ?? '',
    webhook_enc: parsed.webhook_enc ?? null,
    webhook_hint: parsed.webhook_hint ?? null,
    updated_at: parsed.updated_at ?? 0,
  };
}

export function stripeAccount(ctx: CrmContext, _input: Record<string, never> = {}): StoredStripeAccount | null {
  return readStripeAccount(ctx);
}

export function stripeSettings(ctx: CrmContext, _input: Record<string, never> = {}): Omit<StripeSettings, 'webhook_url'> {
  const account = readStripeAccount(ctx);
  if (account === null) {
    return {
      configured: false,
      mode: null,
      publishable_key: null,
      secret_key_hint: null,
      webhook_secret_hint: null,
      updated_at: null,
    };
  }
  return {
    configured: true,
    mode: account.publishable_key.startsWith('pk_live_') ? 'live' : 'test',
    publishable_key: account.publishable_key,
    secret_key_hint: account.secret_hint,
    webhook_secret_hint: account.webhook_hint,
    updated_at: toIso(account.updated_at),
  };
}

export function saveStripeAccount(
  ctx: CrmContext,
  input: {
    tenantId: string;
    publishableKey: string;
    secret: { enc: string; hint: string } | null;
    webhook: { enc: string; hint: string } | null;
  },
): Omit<StripeSettings, 'webhook_url'> {
  const current = readStripeAccount(ctx);
  const secret = input.secret ?? (current === null ? null : { enc: current.secret_enc, hint: current.secret_hint });
  if (secret === null) throw invalid('secret_key', 'secret_key is required');
  const webhook =
    input.webhook ??
    (current?.webhook_enc === null || current === null
      ? null
      : { enc: current.webhook_enc, hint: current.webhook_hint ?? '' });
  const value: StoredStripeAccount = {
    tenant_id: input.tenantId,
    publishable_key: input.publishableKey,
    secret_enc: secret.enc,
    secret_hint: secret.hint,
    webhook_enc: webhook?.enc ?? null,
    webhook_hint: webhook?.hint ?? null,
    updated_at: ctx.now(),
  };
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    META_KEY,
    JSON.stringify(value),
  );
  return stripeSettings(ctx);
}

export function clearStripeAccount(ctx: CrmContext, _input: Record<string, never> = {}): { deleted: true } {
  ctx.db.run(`DELETE FROM tenant_meta WHERE key = ?`, META_KEY);
  return { deleted: true };
}
