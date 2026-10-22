import type { CrmOpInput, CrmOpName, CrmOpOutput } from '../crm/ops';
import type { Env } from '../env';
import { StripeApiError, type StripePaymentIntent } from '../commerce/stripe/client';
import { commerceRuntime, openStripe } from '../commerce/stripe/runtime';

/** Synchronous TenantDb op as the system actor (throws on domain errors). */
export type TenantCall = <K extends CrmOpName>(op: K, input: CrmOpInput<K>) => CrmOpOutput<K>;

export interface RenewalRunResult {
  charged: number;
  failed: number;
}

export function intentOutcome(intent: StripePaymentIntent): 'succeeded' | 'processing' | 'failed' {
  if (intent.status === 'succeeded') return 'succeeded';
  if (intent.status === 'processing') return 'processing';
  return 'failed';
}

/**
 * Charges the renewal orders due now on the saved payment methods, off
 * session (run by the TenantDb alarm after billing). One idempotency key per
 * order and attempt: a run interrupted mid-way never charges twice.
 */
export async function runRenewalCharges(env: Env, call: TenantCall): Promise<RenewalRunResult> {
  const result: RenewalRunResult = { charged: 0, failed: 0 };
  const due = call('commerce.chargesDue', {});
  if (due.length === 0) return result;
  const account = call('stripe.account', {});
  if (account === null) {
    for (const charge of due) {
      call('commerce.chargeResult', {
        orderId: charge.orderId,
        attempt: charge.attempt,
        intentId: null,
        status: 'processing',
        amountReceived: 0,
        failureMessage: null,
      });
    }
    return result;
  }
  const stripe = await openStripe(await commerceRuntime(env), account);
  for (const charge of due) {
    let outcome: 'succeeded' | 'processing' | 'failed';
    let intentId: string | null = null;
    let received = 0;
    let message: string | null = null;
    try {
      const intent = await stripe.client.chargeSavedMethod(
        {
          amount: charge.amountMinor,
          currency: charge.currency,
          customer: charge.customerId,
          paymentMethod: charge.paymentMethodId,
          offSession: true,
          description: `Renewal ${charge.number}`,
          metadata: { amable_kind: 'renewal', amable_order: charge.orderId, amable_attempt: String(charge.attempt) },
        },
        `renewal:${charge.orderId}:${String(charge.attempt)}`,
      );
      outcome = intentOutcome(intent);
      intentId = intent.id;
      received = intent.amount_received;
      message = intent.last_payment_error?.message ?? null;
    } catch (error) {
      if (!(error instanceof StripeApiError)) throw error;
      outcome = 'failed';
      intentId = error.error.payment_intent?.id ?? null;
      message = error.error.decline_code ?? error.error.message;
    }
    call('commerce.chargeResult', {
      orderId: charge.orderId,
      attempt: charge.attempt,
      intentId,
      status: outcome,
      amountReceived: received,
      failureMessage: message,
    });
    if (outcome === 'succeeded') result.charged += 1;
    else if (outcome === 'failed') result.failed += 1;
  }
  return result;
}
