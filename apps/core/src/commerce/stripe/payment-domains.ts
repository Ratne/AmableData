import type { OpenStripe } from './runtime';

/**
 * Apple Pay and Google Pay show up in the Payment Element only on domains
 * registered in the Stripe account (payment method domains). The checkout
 * registers the page it is loaded on; saving the keys registers the site
 * domains and the hosted page origin.
 */

/** A public hostname Stripe can verify (no localhost, IPs or local names). */
export function walletHost(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  let host: string;
  try {
    host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[')
  ) {
    return null;
  }
  return host;
}

/** Registers each host, reporting the outcome; one failure does not stop the others. */
export async function registerPaymentDomains(
  stripe: OpenStripe,
  hosts: readonly string[],
  record: (host: string, ok: boolean) => Promise<unknown>,
): Promise<void> {
  for (const host of hosts) {
    let ok = true;
    try {
      await stripe.client.registerPaymentMethodDomain(host);
    } catch (error) {
      ok = false;
      console.error('[checkout] payment method domain not registered', host, error);
    }
    await record(host, ok);
  }
}
