import type { CrmContext } from '../crm/context';
import { applyTagsToContact } from '../crm/tags';
import type { OrderRow } from '../commerce/rows';
import { storedCheckoutDefinition, type CheckoutRow } from './checkouts';

/** Tags of the checkout still in the workspace (deleted ones are skipped). */
export function tagBuyer(ctx: CrmContext, contactId: string, tagIds: readonly string[]): void {
  if (tagIds.length === 0) return;
  const live = ctx.db
    .all<{ id: string }>(`SELECT id FROM crm_tags WHERE deleted_at IS NULL AND id IN (${tagIds.map(() => '?').join(', ')})`, ...tagIds)
    .map((r) => r.id);
  if (live.length > 0) applyTagsToContact(ctx, contactId, live);
}

/**
 * The main order of a bank transfer purchase became paid (the transfer was
 * recorded): the buyer gets the checkout tags and the session counts as paid,
 * as a card purchase does at the checkout.
 */
export function onCheckoutOrderPaid(ctx: CrmContext, order: OrderRow): void {
  if (order.payment_method !== 'bank_transfer' || order.checkout_id === null || order.parent_order_id !== null) return;
  const checkout = ctx.db.all<Pick<CheckoutRow, 'definition'>>(`SELECT definition FROM crm_checkouts WHERE id = ?`, order.checkout_id)[0];
  if (checkout !== undefined) tagBuyer(ctx, order.contact_id, storedCheckoutDefinition(checkout).crm.tag_ids);
  if (order.checkout_session_id !== null) {
    ctx.db.run(
      `UPDATE crm_checkout_sessions SET paid_at = COALESCE(paid_at, ?) WHERE id = ?`,
      ctx.now(),
      order.checkout_session_id,
    );
  }
}
