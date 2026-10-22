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
  /** Endpoint the CRM created in the Stripe account (null: secret entered by hand). */
  webhook_endpoint_id: string | null;
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
    webhook_endpoint_id: parsed.webhook_endpoint_id ?? null,
    updated_at: parsed.updated_at ?? 0,
  };
}

export function stripeAccount(ctx: CrmContext, _input: Record<string, never> = {}): StoredStripeAccount | null {
  return readStripeAccount(ctx);
}

function modeOf(publishableKey: string): 'live' | 'test' {
  return publishableKey.startsWith('pk_live_') ? 'live' : 'test';
}

function savedPaymentMethods(ctx: CrmContext): number {
  return (
    ctx.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crm_subscriptions WHERE stripe_payment_method_id IS NOT NULL AND status != 'cancelled'`,
    )[0]?.n ?? 0
  );
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
      webhook_managed: false,
      updated_at: null,
      saved_payment_methods: savedPaymentMethods(ctx),
    };
  }
  return {
    configured: true,
    mode: modeOf(account.publishable_key),
    publishable_key: account.publishable_key,
    secret_key_hint: account.secret_hint,
    webhook_secret_hint: account.webhook_hint,
    webhook_managed: account.webhook_endpoint_id !== null,
    updated_at: toIso(account.updated_at),
    saved_payment_methods: savedPaymentMethods(ctx),
  };
}

/**
 * Account and mode the saved Stripe references (customers, cards, intents)
 * belong to. Kept apart from the keys so it survives a disconnect.
 */
interface StripeIdentity {
  mode: 'live' | 'test';
  account_id: string | null;
}

const IDENTITY_KEY = 'commerce_stripe_identity';

function readIdentity(ctx: CrmContext): StripeIdentity | null {
  const row = ctx.db.all<{ value: string }>(`SELECT value FROM tenant_meta WHERE key = ?`, IDENTITY_KEY)[0];
  return row === undefined ? null : parseJson<StripeIdentity | null>(row.value, null);
}

/**
 * Customers and cards of another Stripe account or mode do not exist on the
 * new one ("No such customer"): drop them, stop the automatic charges that
 * relied on them and end the purchases still waiting on the old intents.
 */
function forgetStripeReferences(ctx: CrmContext): void {
  const now = ctx.now();
  ctx.db.run(`DELETE FROM crm_stripe_customers`);
  ctx.db.run(
    `UPDATE crm_orders SET next_charge_at = NULL
     WHERE next_charge_at IS NOT NULL AND subscription_id IN
       (SELECT id FROM crm_subscriptions WHERE stripe_payment_method_id IS NOT NULL)`,
  );
  ctx.db.run(
    `UPDATE crm_subscriptions SET stripe_customer_id = NULL, stripe_payment_method_id = NULL, updated_at = ?
     WHERE stripe_customer_id IS NOT NULL OR stripe_payment_method_id IS NOT NULL`,
    now,
  );
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET status = 'completed', current_offer = NULL, pending_offer = NULL,
       pending_intent_id = NULL, completed_at = ?, updated_at = ? WHERE status = 'paid'`,
    now,
    now,
  );
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET stripe_customer_id = NULL, intent_kind = NULL, intent_id = NULL,
       expires_at = MIN(expires_at, ?), updated_at = ? WHERE status = 'open'`,
    now,
    now,
  );
}

export function saveStripeAccount(
  ctx: CrmContext,
  input: {
    tenantId: string;
    publishableKey: string;
    /** From the secret key just verified; null when the secret is kept or the key may not read it. */
    accountId?: string | null;
    secret: { enc: string; hint: string } | null;
    /** `endpointId`: the endpoint the worker created in Stripe for this secret (absent: entered by hand). */
    webhook: { enc: string; hint: string; endpointId?: string | null } | null;
  },
): Omit<StripeSettings, 'webhook_url'> {
  const stored = readStripeAccount(ctx);
  const previous =
    readIdentity(ctx) ?? (stored === null ? null : { mode: modeOf(stored.publishable_key), account_id: null });
  const accountId = input.accountId ?? null;
  const identity: StripeIdentity = {
    mode: modeOf(input.publishableKey),
    account_id: accountId ?? previous?.account_id ?? null,
  };
  const changed =
    previous !== null &&
    (previous.mode !== identity.mode ||
      (previous.account_id !== null && accountId !== null && previous.account_id !== accountId));
  if (changed && input.secret === null) throw invalid('secret_key', 'enter the secret key of the new mode');
  if (changed) forgetStripeReferences(ctx);
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    IDENTITY_KEY,
    JSON.stringify(identity),
  );
  const current = stored;
  const secret = input.secret ?? (current === null ? null : { enc: current.secret_enc, hint: current.secret_hint });
  if (secret === null) throw invalid('secret_key', 'secret_key is required');
  // The signing secret of another account or mode would reject every event: it is not kept.
  const webhook =
    input.webhook ??
    (changed || current === null || current.webhook_enc === null
      ? null
      : { enc: current.webhook_enc, hint: current.webhook_hint ?? '', endpointId: current.webhook_endpoint_id });
  const value: StoredStripeAccount = {
    tenant_id: input.tenantId,
    publishable_key: input.publishableKey,
    secret_enc: secret.enc,
    secret_hint: secret.hint,
    webhook_enc: webhook?.enc ?? null,
    webhook_hint: webhook?.hint ?? null,
    webhook_endpoint_id: webhook?.endpointId ?? null,
    updated_at: ctx.now(),
  };
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    META_KEY,
    JSON.stringify(value),
  );
  return { ...stripeSettings(ctx), account_changed: changed };
}

export function clearStripeAccount(ctx: CrmContext, _input: Record<string, never> = {}): { deleted: true } {
  ctx.db.run(`DELETE FROM tenant_meta WHERE key = ?`, META_KEY);
  return { deleted: true };
}
