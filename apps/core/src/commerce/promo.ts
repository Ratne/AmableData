import type {
  CreatePromoCodeInput,
  Page,
  PromoCode,
  UpdatePromoCodeInput,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid, notFound } from '../crm/errors';
import { decodeCursor, encodeCursor, parseIsoMs, parseJson, toIso } from '../crm/util';
import type { DiscountRule } from './money';

interface PromoRow {
  id: string;
  code: string;
  description: string | null;
  kind: PromoCode['kind'];
  percent_bps: number | null;
  amount_minor: number | null;
  currency: string | null;
  min_subtotal_minor: number | null;
  product_ids: string | null;
  max_redemptions: number | null;
  max_per_contact: number | null;
  redemptions: number;
  starts_at: number | null;
  ends_at: number | null;
  active: number;
  created_at: number;
  updated_at: number;
}

function toApi(row: PromoRow): PromoCode {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    kind: row.kind,
    percent_bps: row.percent_bps,
    amount_minor: row.amount_minor,
    currency: row.currency,
    min_subtotal_minor: row.min_subtotal_minor,
    product_ids: row.product_ids === null ? null : parseJson<string[]>(row.product_ids, []),
    max_redemptions: row.max_redemptions,
    max_per_contact: row.max_per_contact,
    redemptions: row.redemptions,
    starts_at: toIso(row.starts_at),
    ends_at: toIso(row.ends_at),
    active: row.active === 1,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getRow(ctx: CrmContext, id: string): PromoRow {
  const row = ctx.db.all<PromoRow>(
    `SELECT * FROM crm_promo_codes WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('promo code', id);
  return row;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

const optMs = (value: string | null | undefined, path: string): number | null =>
  value === null || value === undefined ? null : parseIsoMs(value, path);

/** Shape rules the Zod schema cannot express (kind-dependent fields, window order). */
function validateShape(
  row: Omit<PromoRow, 'id' | 'redemptions' | 'created_at' | 'updated_at'>,
): void {
  if (row.kind === 'percent' && row.percent_bps === null) {
    throw invalid('percent_bps', 'percent promo codes need percent_bps');
  }
  if (row.kind === 'fixed' && (row.amount_minor === null || row.currency === null)) {
    throw invalid('amount_minor', 'fixed promo codes need amount_minor and currency');
  }
  if (row.starts_at !== null && row.ends_at !== null && row.ends_at <= row.starts_at) {
    throw invalid('ends_at', 'ends_at must be after starts_at');
  }
}

export function getPromoCode(ctx: CrmContext, input: { id: string }): PromoCode {
  return toApi(getRow(ctx, input.id));
}

export function listPromoCodes(
  ctx: CrmContext,
  input: { limit: number; cursor?: string | undefined; active?: 'true' | 'false' | undefined },
): Page<PromoCode> {
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const active = input.active === undefined ? null : input.active === 'true' ? 1 : 0;
  const rows = ctx.db.all<PromoRow>(
    `SELECT * FROM crm_promo_codes WHERE deleted_at IS NULL AND (? IS NULL OR active = ?)
       AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    active,
    active,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}

export function createPromoCode(ctx: CrmContext, input: CreatePromoCodeInput): PromoCode {
  const code = normalizeCode(input.code);
  if (
    ctx.db.all(`SELECT 1 FROM crm_promo_codes WHERE code = ? AND deleted_at IS NULL`, code).length >
    0
  ) {
    throw new CrmError('conflict', `promo code ${code} already exists`);
  }
  const values = {
    code,
    description: input.description ?? null,
    kind: input.kind,
    percent_bps: input.kind === 'percent' ? (input.percent_bps ?? null) : null,
    amount_minor: input.kind === 'fixed' ? (input.amount_minor ?? null) : null,
    currency: input.kind === 'fixed' ? (input.currency ?? null) : null,
    min_subtotal_minor: input.min_subtotal_minor ?? null,
    product_ids:
      input.product_ids === null || input.product_ids === undefined
        ? null
        : JSON.stringify([...new Set(input.product_ids)]),
    max_redemptions: input.max_redemptions ?? null,
    max_per_contact: input.max_per_contact ?? null,
    starts_at: optMs(input.starts_at, 'starts_at'),
    ends_at: optMs(input.ends_at, 'ends_at'),
    active: input.active === false ? 0 : 1,
  };
  validateShape(values);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_promo_codes (id, code, description, kind, percent_bps, amount_minor, currency,
       min_subtotal_minor, product_ids, max_redemptions, max_per_contact, starts_at, ends_at, active,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    values.code,
    values.description,
    values.kind,
    values.percent_bps,
    values.amount_minor,
    values.currency,
    values.min_subtotal_minor,
    values.product_ids,
    values.max_redemptions,
    values.max_per_contact,
    values.starts_at,
    values.ends_at,
    values.active,
    now,
    now,
  );
  return getPromoCode(ctx, { id });
}

export function updatePromoCode(
  ctx: CrmContext,
  input: { id: string; data: UpdatePromoCodeInput },
): PromoCode {
  const row = getRow(ctx, input.id);
  const d = input.data;
  const keep = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);
  const values = {
    code: row.code,
    description: keep(d.description, row.description),
    kind: row.kind,
    percent_bps: row.kind === 'percent' ? keep(d.percent_bps, row.percent_bps) : null,
    amount_minor: row.kind === 'fixed' ? keep(d.amount_minor, row.amount_minor) : null,
    currency: row.kind === 'fixed' ? keep(d.currency, row.currency) : null,
    min_subtotal_minor: keep(d.min_subtotal_minor, row.min_subtotal_minor),
    product_ids:
      d.product_ids === undefined
        ? row.product_ids
        : d.product_ids === null
          ? null
          : JSON.stringify([...new Set(d.product_ids)]),
    max_redemptions: keep(d.max_redemptions, row.max_redemptions),
    max_per_contact: keep(d.max_per_contact, row.max_per_contact),
    starts_at: d.starts_at === undefined ? row.starts_at : optMs(d.starts_at, 'starts_at'),
    ends_at: d.ends_at === undefined ? row.ends_at : optMs(d.ends_at, 'ends_at'),
    active: d.active === undefined ? row.active : d.active ? 1 : 0,
  };
  validateShape(values);
  ctx.db.run(
    `UPDATE crm_promo_codes SET description = ?, percent_bps = ?, amount_minor = ?, currency = ?,
       min_subtotal_minor = ?, product_ids = ?, max_redemptions = ?, max_per_contact = ?, starts_at = ?,
       ends_at = ?, active = ?, updated_at = ? WHERE id = ?`,
    values.description,
    values.percent_bps,
    values.amount_minor,
    values.currency,
    values.min_subtotal_minor,
    values.product_ids,
    values.max_redemptions,
    values.max_per_contact,
    values.starts_at,
    values.ends_at,
    values.active,
    ctx.now(),
    row.id,
  );
  return getPromoCode(ctx, { id: row.id });
}

export function deletePromoCode(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_promo_codes SET deleted_at = ? WHERE id = ?`, ctx.now(), row.id);
  return { id: row.id, deleted: true };
}

// ------------------------------------------------------------- evaluation

export interface AppliedPromo {
  id: string;
  code: string;
  rule: DiscountRule;
  /** Which lines the discount applies to (null product = custom line). */
  appliesTo: (productId: string | null) => boolean;
}

/**
 * Resolves a code for an order and checks every limit: active flag, validity
 * window, total and per-contact redemption limits (the order being edited does
 * not count against itself), currency of fixed codes, minimum eligible subtotal.
 * Throws a 422 on `promo_code` with the reason.
 */
export function evaluatePromo(
  ctx: CrmContext,
  input: {
    code: string;
    contactId: string;
    currency: string;
    orderId: string | null;
    lines: Array<{ productId: string | null; subtotalMinor: number }>;
    at: number;
  },
): AppliedPromo {
  const code = normalizeCode(input.code);
  const row = ctx.db.all<PromoRow>(
    `SELECT * FROM crm_promo_codes WHERE code = ? AND deleted_at IS NULL`,
    code,
  )[0];
  const fail = (message: string): CrmError => invalid('promo_code', message);
  if (row === undefined) throw fail(`unknown promo code ${code}`);
  if (row.active !== 1) throw fail(`promo code ${code} is not active`);
  if (row.starts_at !== null && input.at < row.starts_at)
    throw fail(`promo code ${code} is not valid yet`);
  if (row.ends_at !== null && input.at >= row.ends_at) throw fail(`promo code ${code} has expired`);
  const own =
    input.orderId === null
      ? 0
      : ctx.db.all(
          `SELECT 1 FROM crm_promo_redemptions WHERE promo_code_id = ? AND order_id = ?`,
          row.id,
          input.orderId,
        ).length;
  if (row.max_redemptions !== null && row.redemptions - own >= row.max_redemptions) {
    throw fail(`promo code ${code} has reached its redemption limit`);
  }
  if (row.max_per_contact !== null) {
    const used =
      ctx.db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM crm_promo_redemptions WHERE promo_code_id = ? AND contact_id = ?
           AND order_id IS NOT ?`,
        row.id,
        input.contactId,
        input.orderId,
      )[0]?.n ?? 0;
    if (used >= row.max_per_contact) {
      throw fail(`promo code ${code} was already used the maximum number of times by this contact`);
    }
  }
  if (row.kind === 'fixed' && row.currency !== input.currency) {
    throw fail(`promo code ${code} only applies to ${row.currency ?? '?'} orders`);
  }
  const productIds =
    row.product_ids === null ? null : new Set(parseJson<string[]>(row.product_ids, []));
  const appliesTo = (productId: string | null): boolean =>
    productIds === null || (productId !== null && productIds.has(productId));
  const eligible = input.lines
    .filter((l) => appliesTo(l.productId))
    .reduce((sum, l) => sum + l.subtotalMinor, 0);
  if (eligible === 0) throw fail(`promo code ${code} does not apply to any item of this order`);
  if (row.min_subtotal_minor !== null && eligible < row.min_subtotal_minor) {
    throw fail(`promo code ${code} needs a subtotal of at least ${row.min_subtotal_minor}`);
  }
  return {
    id: row.id,
    code: row.code,
    rule: { kind: row.kind, percentBps: row.percent_bps, amountMinor: row.amount_minor },
    appliesTo,
  };
}

/** Records a redemption (on finalization) — counts against the limits. */
export function redeemPromo(
  ctx: CrmContext,
  promoId: string,
  orderId: string,
  contactId: string,
): void {
  ctx.db.run(
    `INSERT OR IGNORE INTO crm_promo_redemptions (id, promo_code_id, order_id, contact_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    ctx.newId(),
    promoId,
    orderId,
    contactId,
    ctx.now(),
  );
  syncRedemptions(ctx, promoId);
}

/** Releases the redemption of a cancelled order. */
export function releasePromo(ctx: CrmContext, promoId: string, orderId: string): void {
  ctx.db.run(
    `DELETE FROM crm_promo_redemptions WHERE promo_code_id = ? AND order_id = ?`,
    promoId,
    orderId,
  );
  syncRedemptions(ctx, promoId);
}

function syncRedemptions(ctx: CrmContext, promoId: string): void {
  ctx.db.run(
    `UPDATE crm_promo_codes SET redemptions =
       (SELECT COUNT(*) FROM crm_promo_redemptions WHERE promo_code_id = ?) WHERE id = ?`,
    promoId,
    promoId,
  );
}
