import { leadPayloadSchema, type LeadPayloadInput } from '@amable/checkout';
import { validateSubmission } from '@amable/forms';
import type { CrmContext } from '../crm/context';
import { emit } from '../crm/events';
import { parseJson } from '../crm/util';
import { rememberTenant, tenantFacts, type TenantFacts } from '../esign/model';
import { getSettings } from '../commerce/settings';
import { activeCheckoutRow, storedCheckoutDefinition, type CheckoutRow } from './checkouts';
import { priceCart } from './pricing';
import { buyerFields, cartOf, localeOf, trackingFrom, upsertBuyer } from './sessions';

/**
 * Abandoned carts. The widget sends the email (with name, phone and cart) as
 * soon as the buyer types it, when the checkout has `abandoned_cart` on.
 * Paying (or placing a bank transfer order) converts the row; otherwise,
 * `delay_minutes` after the last change, the TenantDb alarm upserts the
 * contact with the checkout CRM settings and emits `checkout.abandoned`.
 */

export type LeadStatus = 'open' | 'abandoned' | 'converted';

interface LeadRow {
  id: string;
  checkout_id: string;
  email: string;
  status: LeadStatus;
  field_values: string;
  selection: string;
  promo_code: string;
  currency: string | null;
  amount_minor: number;
  product_ids: string;
  tracking: string;
  visitor_id: string | null;
  page_url: string | null;
  locale: string | null;
  session_id: string | null;
  contact_id: string | null;
  due_at: number | null;
  abandoned_at: number | null;
  created_at: number;
  updated_at: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** An abandoned or converted cart of the same buyer starts over only after this pause. */
const REOPEN_AFTER_MS = 86_400_000;
/** Rows are deleted this long after their last change (open ones included). */
export const LEAD_RETENTION_MS = 30 * 86_400_000;
/** Purchase statuses meaning the buyer did not abandon. */
const PURCHASED = ['processing', 'paid', 'completed'];

const normalize = (email: string): string => email.trim().toLowerCase();

/** Saves (or refreshes) the cart of a buyer who typed the email; nothing when the checkout does not collect them. */
export function captureCheckoutLead(
  ctx: CrmContext,
  input: { checkoutId: string; payload: LeadPayloadInput; tenant?: TenantFacts },
): { captured: boolean } {
  const row = activeCheckoutRow(ctx, input.checkoutId);
  const d = storedCheckoutDefinition(row);
  const payload = leadPayloadSchema.parse(input.payload);
  const email = normalize(payload.buyer.email);
  if (
    !d.settings.abandoned_cart.enabled ||
    payload.hp !== '' ||
    email.length > 254 ||
    !EMAIL_RE.test(email)
  ) {
    return { captured: false };
  }
  rememberTenant(ctx, input.tenant);
  const now = ctx.now();
  const locale = localeOf(d, payload.meta.locale);
  let currency: string | null = null;
  let amount = 0;
  let productIds: string[] = [];
  try {
    const { catalog, cart } = cartOf(ctx, row, payload.selection, locale);
    const priced = priceCart(ctx, {
      cart,
      currency: catalog.currency,
      contactId: '',
      promoCode: d.settings.promo_codes ? payload.promo_code : '',
      at: now,
      strictPromo: false,
      discounts: d.discounts,
      stackPromo: d.settings.discounts_stack_promo,
    });
    currency = catalog.currency;
    amount = priced.quote.total_minor;
    productIds = [
      ...new Set(cart.lines.map((l) => l.productId).filter((id): id is string => id !== null)),
    ];
  } catch {
    // A cart that cannot be priced right now (selection being edited): the email still counts.
    currency = getSettings(ctx).default_currency;
  }
  const b = payload.buyer;
  const columns = {
    field_values: JSON.stringify({
      given_name: b.given_name,
      family_name: b.family_name,
      phone: b.phone,
    }),
    selection: JSON.stringify(payload.selection),
    promo_code: payload.promo_code,
    currency,
    amount_minor: amount,
    product_ids: JSON.stringify(productIds),
    tracking: JSON.stringify(trackingFrom(payload.tracking)),
    visitor_id: payload.meta.visitor_id === '' ? null : payload.meta.visitor_id,
    page_url: payload.meta.page_url === '' ? null : payload.meta.page_url,
    locale,
  };
  const due = now + d.settings.abandoned_cart.delay_minutes * 60_000;
  const existing = ctx.db.all<LeadRow>(
    `SELECT * FROM crm_checkout_leads WHERE checkout_id = ? AND email = ?`,
    row.id,
    email,
  )[0];
  if (existing === undefined) {
    ctx.db.run(
      `INSERT INTO crm_checkout_leads (id, checkout_id, email, status, field_values, selection, promo_code, currency,
         amount_minor, product_ids, tracking, visitor_id, page_url, locale, due_at, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      row.id,
      email,
      columns.field_values,
      columns.selection,
      columns.promo_code,
      columns.currency,
      columns.amount_minor,
      columns.product_ids,
      columns.tracking,
      columns.visitor_id,
      columns.page_url,
      columns.locale,
      due,
      now,
      now,
    );
    return { captured: true };
  }
  const reopen = existing.status !== 'open' && now - existing.updated_at > REOPEN_AFTER_MS;
  if (existing.status === 'converted' && !reopen) return { captured: true };
  const open = existing.status === 'open' || reopen;
  ctx.db.run(
    `UPDATE crm_checkout_leads SET field_values = ?, selection = ?, promo_code = ?, currency = ?, amount_minor = ?,
       product_ids = ?, tracking = ?, visitor_id = COALESCE(?, visitor_id), page_url = COALESCE(?, page_url), locale = ?,
       status = ?, due_at = ?, session_id = ?, abandoned_at = ?, created_at = ?, updated_at = ? WHERE id = ?`,
    columns.field_values,
    columns.selection,
    columns.promo_code,
    columns.currency,
    columns.amount_minor,
    columns.product_ids,
    columns.tracking,
    columns.visitor_id,
    columns.page_url,
    columns.locale,
    open ? 'open' : existing.status,
    open ? due : null,
    reopen ? null : existing.session_id,
    reopen ? null : existing.abandoned_at,
    reopen ? now : existing.created_at,
    now,
    existing.id,
  );
  return { captured: true };
}

/** The buyer opened a purchase: the cart follows it (paid later, it is converted). */
export function linkLeadSession(
  ctx: CrmContext,
  checkoutId: string,
  email: string,
  sessionId: string,
): void {
  ctx.db.run(
    `UPDATE crm_checkout_leads SET session_id = ? WHERE checkout_id = ? AND email = ? AND status = 'open'`,
    sessionId,
    checkoutId,
    normalize(email),
  );
}

/** The purchase of the cart went through (paid, or placed by bank transfer). */
export function convertLead(ctx: CrmContext, sessionId: string): void {
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_checkout_leads SET status = 'converted', due_at = NULL, updated_at = ? WHERE session_id = ? AND status != 'converted'`,
    now,
    sessionId,
  );
}

function purchased(ctx: CrmContext, lead: LeadRow): boolean {
  if (lead.session_id === null) return false;
  const marks = PURCHASED.map(() => '?').join(', ');
  return (
    ctx.db.all(
      `SELECT 1 FROM crm_checkout_sessions WHERE id = ? AND status IN (${marks})`,
      lead.session_id,
      ...PURCHASED,
    ).length > 0
  );
}

/** Contact of an abandoned cart, with the checkout CRM settings (tags wait for a purchase, as at the checkout). */
function upsertLeadContact(ctx: CrmContext, row: CheckoutRow, lead: LeadRow): string | null {
  const d = storedCheckoutDefinition(row);
  const locale = localeOf(d, lead.locale);
  const fields = buyerFields(d.contact, locale)
    .filter((f) => ['email', 'given_name', 'family_name', 'phone'].includes(f.key))
    .map((f) => ({ ...f, required: f.key === 'email' }));
  const stored = parseJson<Record<string, string>>(lead.field_values, {});
  const raw = {
    email: lead.email,
    given_name: stored['given_name'] ?? '',
    family_name: stored['family_name'] ?? '',
    phone: stored['phone'] ?? '',
  };
  let checked = validateSubmission({ fields }, raw);
  // A phone the field rejects must not lose the contact: keep the email and the name.
  if (!checked.ok)
    checked = validateSubmission(
      { fields: fields.filter((f) => f.key !== 'phone') },
      { ...raw, phone: '' },
    );
  if (!checked.ok) return null;
  return upsertBuyer(
    ctx,
    d,
    fields,
    checked.values,
    parseJson<Record<string, string>>(lead.tracking, {}),
  );
}

/**
 * Run by the TenantDb alarm: open carts past their delay become abandoned
 * (contact upserted, `checkout.abandoned` emitted) unless the buyer paid;
 * old rows are deleted. `tenantId` lets the alarm wake the automation engine.
 */
export function abandonCheckoutLeads(
  ctx: CrmContext,
  input: { limit?: number } = {},
): { abandoned: number; deleted: number; tenantId: string | null } {
  const now = ctx.now();
  const limit = input.limit ?? 100;
  const due = ctx.db.all<LeadRow>(
    `SELECT * FROM crm_checkout_leads WHERE status = 'open' AND due_at <= ? ORDER BY due_at LIMIT ?`,
    now,
    limit,
  );
  let abandoned = 0;
  for (const lead of due) {
    const row = ctx.db.all<CheckoutRow>(
      `SELECT * FROM crm_checkouts WHERE id = ? AND deleted_at IS NULL`,
      lead.checkout_id,
    )[0];
    if (row === undefined || !storedCheckoutDefinition(row).settings.abandoned_cart.enabled) {
      // Collection turned off (or checkout removed): the email is not kept.
      ctx.db.run(`DELETE FROM crm_checkout_leads WHERE id = ?`, lead.id);
      continue;
    }
    if (purchased(ctx, lead)) {
      ctx.db.run(
        `UPDATE crm_checkout_leads SET status = 'converted', due_at = NULL, updated_at = ? WHERE id = ?`,
        now,
        lead.id,
      );
      continue;
    }
    const contactId = upsertLeadContact(ctx, row, lead);
    ctx.db.run(
      `UPDATE crm_checkout_leads SET status = 'abandoned', due_at = NULL, contact_id = ?, abandoned_at = ? WHERE id = ?`,
      contactId,
      now,
      lead.id,
    );
    if (contactId === null) continue;
    emit(
      ctx,
      'checkout.abandoned',
      {
        contactId,
        checkoutId: row.id,
        leadId: lead.id,
        amountMinor: lead.amount_minor,
        currency: lead.currency ?? getSettings(ctx).default_currency,
        visitorId: lead.visitor_id,
        productIds: parseJson<string[]>(lead.product_ids, []),
        pageUrl: lead.page_url,
      },
      { checkout: row.name },
    );
    abandoned += 1;
  }
  const old = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_checkout_leads WHERE updated_at <= ? LIMIT ?`,
    now - LEAD_RETENTION_MS,
    limit,
  );
  for (const lead of old) ctx.db.run(`DELETE FROM crm_checkout_leads WHERE id = ?`, lead.id);
  return {
    abandoned,
    deleted: old.length,
    tenantId: abandoned > 0 ? (tenantFacts(ctx)?.id ?? null) : null,
  };
}

/** When the alarm must next run `abandonCheckoutLeads`. */
export function nextLeadDue(db: CrmContext['db']): number | null {
  const row = db.all<{ due: number | null; oldest: number | null }>(
    `SELECT (SELECT MIN(due_at) FROM crm_checkout_leads WHERE status = 'open') AS due,
       (SELECT MIN(updated_at) FROM crm_checkout_leads) AS oldest`,
  )[0];
  const candidates = [
    row?.due ?? null,
    row?.oldest == null ? null : row.oldest + LEAD_RETENTION_MS,
  ].filter((t): t is number => t !== null);
  return candidates.length === 0 ? null : Math.min(...candidates);
}
