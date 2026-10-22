import type {
  Checkout,
  CheckoutSummary,
  CreateCheckoutInput,
  ListCheckoutsQuery,
  Page,
  UpdateCheckoutInput,
} from '@amable/api-types';
import {
  checkoutDefinitionSchema,
  defaultCheckoutDefinition,
  type CheckoutDefinition,
  type CheckoutStatus,
} from '@amable/checkout';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, invalid, invalidMany, notFound } from '../crm/errors';
import { assertRef } from '../crm/refs';
import { assertTags } from '../crm/tags';
import { decodeCursor, paginate, parseJson, toIso } from '../crm/util';

export interface CheckoutRow {
  id: string;
  name: string;
  status: CheckoutStatus;
  definition: string;
  revision: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Validates a definition document; Zod issues become `validation_failed` details under `definition.`. */
export function parseCheckoutDefinition(input: unknown): CheckoutDefinition {
  const result = checkoutDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw invalidMany(
      result.error.issues.map((issue) => ({
        path: ['definition', ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function storedCheckoutDefinition(row: Pick<CheckoutRow, 'definition'>): CheckoutDefinition {
  const result = checkoutDefinitionSchema.safeParse(parseJson<unknown>(row.definition, {}));
  return result.success ? result.data : defaultCheckoutDefinition();
}

/** Catalog references must exist and agree on the currency. */
function assertRefs(ctx: CrmContext, d: CheckoutDefinition): void {
  if (d.crm.tag_ids.length > 0) assertTags(ctx, d.crm.tag_ids, 'definition.crm.tag_ids');
  assertRef(ctx, 'lead_source', d.crm.lead_source_id, 'definition.crm.lead_source_id');
  const currencies = new Set<string>();
  const product = (id: string, path: string): void => {
    const row = ctx.db.all<{ currency: string }>(
      `SELECT currency FROM crm_products WHERE id = ? AND deleted_at IS NULL`,
      id,
    )[0];
    if (row === undefined) throw invalid(path, `product ${id} not found`);
    currencies.add(row.currency);
  };
  const plan = (id: string, path: string): void => {
    const row = ctx.db.all<{ currency: string }>(
      `SELECT currency FROM crm_subscription_plans WHERE id = ? AND deleted_at IS NULL`,
      id,
    )[0];
    if (row === undefined) throw invalid(path, `plan ${id} not found`);
    currencies.add(row.currency);
  };
  d.items.forEach((item, i) =>
    (item.kind === 'plan' ? plan : product)(item.ref_id, `definition.items.${String(i)}.ref_id`),
  );
  d.bumps.forEach((bump, i) => product(bump.product_id, `definition.bumps.${String(i)}.product_id`));
  d.offers.forEach((offer, i) =>
    (offer.item_kind === 'plan' ? plan : product)(offer.ref_id, `definition.offers.${String(i)}.ref_id`),
  );
  if (currencies.size > 1) {
    throw invalid('definition.items', 'every item, bump and offer must be priced in the same currency');
  }
}

export function getCheckoutRow(ctx: CrmContext, id: string): CheckoutRow {
  const row = ctx.db.all<CheckoutRow>(
    `SELECT * FROM crm_checkouts WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('checkout', id);
  return row;
}

interface Stats {
  checkout_id: string;
  sessions: number;
  paid: number;
}

function statsOf(ctx: CrmContext, ids: string[]): Map<string, Checkout['stats']> {
  const out = new Map<string, Checkout['stats']>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => '?').join(', ');
  const sessions = ctx.db.all<Stats>(
    `SELECT checkout_id, COUNT(*) AS sessions, SUM(CASE WHEN paid_at IS NOT NULL THEN 1 ELSE 0 END) AS paid
     FROM crm_checkout_sessions WHERE checkout_id IN (${marks}) GROUP BY checkout_id`,
    ...ids,
  );
  const revenue = ctx.db.all<{ checkout_id: string; revenue: number; offers: number }>(
    `SELECT checkout_id, SUM(paid_minor - refunded_minor) AS revenue,
       SUM(CASE WHEN parent_order_id IS NOT NULL AND paid_minor > 0 THEN 1 ELSE 0 END) AS offers
     FROM crm_orders WHERE deleted_at IS NULL AND checkout_id IN (${marks}) GROUP BY checkout_id`,
    ...ids,
  );
  for (const id of ids) {
    out.set(id, { sessions: 0, paid: 0, revenue_minor: 0, offers_accepted: 0 });
  }
  for (const s of sessions) {
    const entry = out.get(s.checkout_id);
    if (entry !== undefined) {
      entry.sessions = s.sessions;
      entry.paid = s.paid;
    }
  }
  for (const r of revenue) {
    const entry = out.get(r.checkout_id);
    if (entry !== undefined) {
      entry.revenue_minor = r.revenue;
      entry.offers_accepted = r.offers;
    }
  }
  return out;
}

const EMPTY_STATS: Checkout['stats'] = { sessions: 0, paid: 0, revenue_minor: 0, offers_accepted: 0 };

function serialize(row: CheckoutRow, stats: Checkout['stats']): Checkout {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    definition: storedCheckoutDefinition(row) as unknown as Checkout['definition'],
    revision: row.revision,
    stats,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function getCheckout(ctx: CrmContext, input: { id: string }): Checkout {
  const row = getCheckoutRow(ctx, input.id);
  return serialize(row, statsOf(ctx, [row.id]).get(row.id) ?? EMPTY_STATS);
}

export function listCheckouts(ctx: CrmContext, input: ListCheckoutsQuery): Page<CheckoutSummary> {
  const where: string[] = ['deleted_at IS NULL'];
  const params: SqlValue[] = [];
  if (input.status !== undefined) {
    where.push('status = ?');
    params.push(input.status);
  } else {
    where.push(`status <> 'archived'`);
  }
  if (input.q !== undefined && input.q !== '') {
    where.push(`name LIKE ? ESCAPE '\\'`);
    params.push(`%${input.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    where.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
    params.push(Number(cursor.v), Number(cursor.v), cursor.id);
  }
  const rows = ctx.db.all<CheckoutRow>(
    `SELECT * FROM crm_checkouts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: row.updated_at, id: row.id }));
  const stats = statsOf(
    ctx,
    page.rows.map((r) => r.id),
  );
  return {
    data: page.rows.map((row) => {
      const { definition: _definition, ...base } = serialize(row, stats.get(row.id) ?? EMPTY_STATS);
      const d = storedCheckoutDefinition(row);
      return { ...base, item_count: d.items.length, bump_count: d.bumps.length, offer_count: d.offers.length };
    }),
    next_cursor: page.nextCursor,
  };
}

export function createCheckout(ctx: CrmContext, input: CreateCheckoutInput): Checkout {
  const definition =
    input.definition === undefined ? defaultCheckoutDefinition() : parseCheckoutDefinition(input.definition);
  assertRefs(ctx, definition);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_checkouts (id, name, status, definition, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.status ?? 'draft',
    JSON.stringify(definition),
    ctx.actor.id,
    now,
    now,
  );
  return getCheckout(ctx, { id });
}

export function updateCheckout(ctx: CrmContext, input: { id: string; data: UpdateCheckoutInput }): Checkout {
  const row = getCheckoutRow(ctx, input.id);
  const d = input.data;
  if (d.revision !== undefined && d.revision !== row.revision) {
    throw new CrmError('conflict', 'the checkout was changed by someone else; reload it');
  }
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (d.name !== undefined) {
    sets.push('name = ?');
    values.push(d.name.trim());
  }
  if (d.status !== undefined) {
    sets.push('status = ?');
    values.push(d.status);
  }
  if (d.definition !== undefined) {
    const definition = parseCheckoutDefinition(d.definition);
    assertRefs(ctx, definition);
    sets.push('definition = ?');
    values.push(JSON.stringify(definition));
  }
  if (sets.length > 0) {
    sets.push('revision = revision + 1', 'updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE crm_checkouts SET ${sets.join(', ')} WHERE id = ?`, ...values, row.id);
  }
  return getCheckout(ctx, { id: row.id });
}

/** Orders and sessions are kept: they belong to the sales history. */
export function deleteCheckout(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getCheckoutRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(`UPDATE crm_checkouts SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, row.id);
  return { id: row.id, deleted: true };
}

export function duplicateCheckout(ctx: CrmContext, input: { id: string; name?: string }): Checkout {
  const row = getCheckoutRow(ctx, input.id);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_checkouts (id, name, status, definition, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, 1, ?, ?, ?)`,
    id,
    (input.name ?? `${row.name} (copy)`).slice(0, 200),
    row.definition,
    ctx.actor.id,
    now,
    now,
  );
  return getCheckout(ctx, { id });
}

/** Checkout as seen by buyers: only active ones exist. */
export function activeCheckoutRow(ctx: CrmContext, id: string): CheckoutRow {
  const row = ctx.db.all<CheckoutRow>(
    `SELECT * FROM crm_checkouts WHERE id = ? AND deleted_at IS NULL AND status = 'active'`,
    id,
  )[0];
  if (row === undefined) throw new CrmError('not_found', 'checkout not found');
  return row;
}
