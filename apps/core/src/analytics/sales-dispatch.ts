import type { WebRefund, WebSale } from './sales-ops';
import { applyBatch, FactBatch, type SyncPorts } from './sync';

/**
 * Applies the workspace sales of the server API on the site they were placed
 * on (idempotent: the site dedupes the payment by transaction id and the
 * refund by its key). The request path dispatches right away; the sync sweeps
 * what a failed request left behind.
 */

const SWEEP_GRACE_MS = 60_000;
const SWEEP_LIMIT = 100;

export async function dispatchSale(
  ports: SyncPorts,
  tenantId: string,
  transactionId: string,
): Promise<void> {
  const sale = await ports.crm<WebSale | null>('analytics.getSale', { transactionId });
  if (sale === null || sale.site_id === null || sale.dispatched_at !== null) return;
  const batch = new FactBatch();
  batch.add(sale.site_id, {
    kind: 'payment',
    id: `v1sale:${sale.transaction_id}`,
    transactionId: sale.transaction_id,
    contactId: sale.contact_id,
    visitorId: sale.visitor_id,
    orderId: sale.order_id,
    amountMinor: sale.amount_minor,
    currency: sale.currency,
    renewal: sale.renewal === 1,
    ts: sale.occurred_at,
  });
  let missing = false;
  await applyBatch(ports, tenantId, batch, () => {
    missing = true;
  });
  await ports.crm(missing ? 'analytics.unplaceSale' : 'analytics.markSaleDispatched', {
    transactionId,
  });
}

export async function dispatchRefund(
  ports: SyncPorts,
  tenantId: string,
  refundId: string,
): Promise<void> {
  const refund = await ports.crm<WebRefund | null>('analytics.getRefund', { refundId });
  if (refund === null || refund.dispatched_at !== null) return;
  const sale = await ports.crm<WebSale | null>('analytics.getSale', {
    transactionId: refund.transaction_id,
  });
  if (sale === null || sale.site_id === null) return;
  // The payment must be on the site before its refund.
  await dispatchSale(ports, tenantId, sale.transaction_id);
  const batch = new FactBatch();
  batch.add(sale.site_id, {
    kind: 'refund',
    id: `v1refund:${refund.refund_id}`,
    transactionId: sale.transaction_id,
    orderId: null,
    amountMinor: refund.amount_minor,
    ts: refund.occurred_at,
  });
  await applyBatch(ports, tenantId, batch);
  await ports.crm('analytics.markRefundDispatched', { refundId });
}

/** Sync step: sales and refunds a failed request recorded but did not apply. */
export async function sweepSales(ports: SyncPorts, tenantId: string): Promise<number> {
  const pending = await ports.crm<{ sales: string[]; refunds: string[] }>(
    'analytics.undispatchedSales',
    { before: ports.now() - SWEEP_GRACE_MS, limit: SWEEP_LIMIT },
  );
  // One failing sale must not hold back the others: it is retried on the next sync.
  const each = async (run: () => Promise<void>, id: string) => {
    try {
      await run();
    } catch (error) {
      console.error('sale dispatch failed', id, error);
    }
  };
  for (const id of pending.sales) await each(() => dispatchSale(ports, tenantId, id), id);
  for (const id of pending.refunds) await each(() => dispatchRefund(ports, tenantId, id), id);
  return pending.sales.length + pending.refunds.length;
}
