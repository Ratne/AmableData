import type { CreateRefundInput, Refund } from '@amable/api-types';
import type { Context } from 'hono';
import { callCrm } from '../../crm/api/core';
import { CrmError } from '../../crm/errors';
import type { AppEnv } from '../../middleware';
import { StripeApiError } from './client';
import { commerceRuntime, openStripe } from './runtime';

/**
 * A CRM refund sent back through Stripe: the TenantDb splits it across the
 * order's Stripe payments, the worker refunds each one on Stripe, then the
 * payment is synced to the charge's cumulative refunded amount (the same
 * sync the `charge.refunded` webhook runs, so neither records it twice).
 */
export async function refundOnStripe(c: Context<AppEnv>, orderId: string, data: CreateRefundInput): Promise<Refund> {
  const account = await callCrm(c, 'stripe.account', {});
  if (account === null) throw new CrmError('conflict', 'Stripe is not connected');
  const plan = await callCrm(c, 'stripe.refundPlan', {
    orderId,
    paymentId: data.payment_id ?? null,
    amountMinor: data.amount_minor ?? null,
  });
  const stripe = await openStripe(await commerceRuntime(c.env), account);
  const reason = data.reason ?? null;
  const recorded: Refund[] = [];
  for (const part of plan.parts) {
    try {
      const refund = await stripe.client.createRefund(
        {
          paymentIntent: part.paymentIntentId,
          amount: part.amountMinor,
          metadata: { amable_order: orderId, amable_payment: part.paymentId, ...(reason === null ? {} : { amable_reason: reason.slice(0, 500) }) },
        },
        // Same click or retry → same Stripe refund; a later refund starts from a new refunded amount.
        `refund:${part.paymentId}:${String(part.refundedMinor)}:${String(part.amountMinor)}`,
      );
      if (refund.status === 'failed' || refund.status === 'canceled' || refund.charge === null) {
        throw new CrmError('conflict', `Stripe refused the refund${refund.failure_reason ? `: ${refund.failure_reason}` : ''}`);
      }
      const charge = await stripe.client.retrieveCharge(refund.charge);
      const { refund: synced } = await callCrm(c, 'stripe.refundSync', {
        chargeId: charge.id,
        paymentIntentId: part.paymentIntentId,
        amountRefunded: charge.amount_refunded,
        reason,
      });
      if (synced !== null) recorded.push(synced);
    } catch (error) {
      const done = recorded.length > 0 ? ` (${String(recorded.length)} of ${String(plan.parts.length)} payments already refunded)` : '';
      if (error instanceof CrmError) throw new CrmError(error.code, `${error.message}${done}`, error.details);
      if (error instanceof StripeApiError) throw new CrmError('conflict', `Stripe: ${error.message}${done}`);
      throw new CrmError(
        'conflict',
        `Stripe did not answer${done}: check the payment in Stripe, the webhook records a refund made there`,
      );
    }
  }
  const last = recorded.at(-1);
  if (last !== undefined) return last;
  // Already recorded by a webhook that saw a later cumulative amount.
  const latest = (await callCrm(c, 'refunds.list', { order_id: orderId, limit: 1 })).data[0];
  if (latest === undefined) throw new CrmError('conflict', `order ${plan.orderNumber} has nothing to refund on Stripe`);
  return latest;
}
