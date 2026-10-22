import type { RateLimiter, SecretBox } from '@amable/auth';
import { getAuthServices } from '../../auth/services';
import type { Env } from '../../env';
import { stripeAccountAd, type StoredStripeAccount } from './account';
import { StripeClient, type StripeFetch } from './client';

/**
 * Outside-world dependencies of checkouts and automatic charges (encryption,
 * the Stripe API, rate limits, clock). Tests swap them with
 * `overrideCommerceRuntime`: no network, ever.
 */
export interface CommerceRuntime {
  now(): number;
  secretBox: SecretBox;
  fetch: StripeFetch;
  limiter: RateLimiter;
}

type Override = (base: CommerceRuntime, env: Env) => CommerceRuntime;

let override: Override | null = null;

/** Test hook (pass `null` to restore). */
export function overrideCommerceRuntime(next: Override | null): void {
  override = next;
}

export async function commerceRuntime(env: Env): Promise<CommerceRuntime> {
  const services = await getAuthServices(env);
  const base: CommerceRuntime = {
    now: services.now,
    secretBox: services.secretBox,
    fetch: (input, init) => fetch(input, init),
    limiter: services.ipLimiter,
  };
  return override === null ? base : override(base, env);
}

export interface OpenStripe {
  client: StripeClient;
  publishableKey: string;
  webhookSecret: string | null;
}

/** Decrypts the tenant keys (the ciphertexts are bound to `account.tenant_id`). */
export async function openStripe(runtime: CommerceRuntime, account: StoredStripeAccount): Promise<OpenStripe> {
  const secret = await runtime.secretBox.decrypt(account.secret_enc, stripeAccountAd(account.tenant_id, 'secret'));
  const webhookSecret =
    account.webhook_enc === null
      ? null
      : await runtime.secretBox.decrypt(account.webhook_enc, stripeAccountAd(account.tenant_id, 'webhook'));
  return {
    client: new StripeClient(secret, runtime.fetch),
    publishableKey: account.publishable_key,
    webhookSecret,
  };
}

export function secretHint(secret: string): string {
  return `…${secret.slice(-4)}`;
}
