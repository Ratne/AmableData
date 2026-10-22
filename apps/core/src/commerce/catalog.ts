import type {
  CreatePlanInput,
  CreateProductCategoryInput,
  CreateProductInput,
  ListPlansQuery,
  ListProductsQuery,
  Page,
  Plan,
  Product,
  ProductCategory,
  UpdatePlanInput,
  UpdateProductCategoryInput,
  UpdateProductInput,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { placeholders } from '../crm/db/sql';
import { CrmError, invalid, notFound } from '../crm/errors';
import { decodeCursor, encodeCursor, toIso } from '../crm/util';
import { getSettings } from './settings';

// ---------------------------------------------------------------- categories

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  position: number;
  product_count: number;
  created_at: number;
  updated_at: number;
}

const CATEGORY_SELECT = `SELECT c.id, c.name, c.description, c.position, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM crm_products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count
  FROM crm_product_categories c`;

function categoryToApi(row: CategoryRow): ProductCategory {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    position: row.position,
    product_count: row.product_count,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getCategoryRow(ctx: CrmContext, id: string): CategoryRow {
  const row = ctx.db.all<CategoryRow>(
    `${CATEGORY_SELECT} WHERE c.id = ? AND c.deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('product category', id);
  return row;
}

function assertCategoryNameFree(ctx: CrmContext, name: string, exceptId: string | null): void {
  const clash = ctx.db.all(
    `SELECT 1 FROM crm_product_categories WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?`,
    name,
    exceptId,
  );
  if (clash.length > 0) throw new CrmError('conflict', `a category named "${name}" already exists`);
}

export function listCategories(ctx: CrmContext, _input: Record<string, never>): ProductCategory[] {
  return ctx.db
    .all<CategoryRow>(
      `${CATEGORY_SELECT} WHERE c.deleted_at IS NULL ORDER BY c.position, c.name COLLATE NOCASE`,
    )
    .map(categoryToApi);
}

export function getCategory(ctx: CrmContext, input: { id: string }): ProductCategory {
  return categoryToApi(getCategoryRow(ctx, input.id));
}

export function createCategory(
  ctx: CrmContext,
  input: CreateProductCategoryInput,
): ProductCategory {
  assertCategoryNameFree(ctx, input.name, null);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_product_categories (id, name, description, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.description ?? null,
    input.position ?? 0,
    now,
    now,
  );
  return getCategory(ctx, { id });
}

export function updateCategory(
  ctx: CrmContext,
  input: { id: string; data: UpdateProductCategoryInput },
): ProductCategory {
  const row = getCategoryRow(ctx, input.id);
  if (input.data.name !== undefined) assertCategoryNameFree(ctx, input.data.name, row.id);
  ctx.db.run(
    `UPDATE crm_product_categories SET name = ?, description = ?, position = ?, updated_at = ? WHERE id = ?`,
    input.data.name ?? row.name,
    input.data.description === undefined ? row.description : input.data.description,
    input.data.position ?? row.position,
    ctx.now(),
    row.id,
  );
  return getCategory(ctx, { id: row.id });
}

/** Deleting a category leaves its products uncategorized. */
export function deleteCategory(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getCategoryRow(ctx, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_products SET category_id = NULL, updated_at = ? WHERE category_id = ?`,
    now,
    row.id,
  );
  ctx.db.run(`UPDATE crm_product_categories SET deleted_at = ? WHERE id = ?`, now, row.id);
  return { id: row.id, deleted: true };
}

// --------------------------------------------------------------------- plans

export interface PlanRow {
  id: string;
  product_id: string;
  name: string;
  interval: Plan['interval'];
  interval_count: number;
  trial_days: number;
  price_minor: number;
  setup_fee_minor: number;
  currency: string;
  active: number;
  position: number;
  created_at: number;
  updated_at: number;
}

function planToApi(row: PlanRow): Plan {
  return {
    id: row.id,
    product_id: row.product_id,
    name: row.name,
    interval: row.interval,
    interval_count: row.interval_count,
    trial_days: row.trial_days,
    price_minor: row.price_minor,
    setup_fee_minor: row.setup_fee_minor,
    currency: row.currency,
    active: row.active === 1,
    position: row.position,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function getPlanRow(ctx: CrmContext, id: string): PlanRow {
  const row = ctx.db.all<PlanRow>(
    `SELECT * FROM crm_subscription_plans WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('plan', id);
  return row;
}

function plansOf(ctx: CrmContext, productIds: string[]): Map<string, Plan[]> {
  const result = new Map<string, Plan[]>(productIds.map((id) => [id, []]));
  if (productIds.length === 0) return result;
  for (const row of ctx.db.all<PlanRow>(
    `SELECT * FROM crm_subscription_plans WHERE deleted_at IS NULL
       AND product_id IN (${placeholders(productIds.length)}) ORDER BY position, price_minor, id`,
    ...productIds,
  )) {
    result.get(row.product_id)?.push(planToApi(row));
  }
  return result;
}

function insertPlan(
  ctx: CrmContext,
  product: ProductRow,
  plan: CreatePlanInput,
  position: number,
): string {
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_subscription_plans (id, product_id, name, interval, interval_count, trial_days,
       price_minor, setup_fee_minor, currency, active, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    product.id,
    plan.name,
    plan.interval,
    plan.interval_count ?? 1,
    plan.trial_days ?? 0,
    plan.price_minor,
    plan.setup_fee_minor ?? 0,
    product.currency,
    plan.active === false ? 0 : 1,
    plan.position ?? position,
    now,
    now,
  );
  return id;
}

export function getPlan(ctx: CrmContext, input: { id: string }): Plan {
  return planToApi(getPlanRow(ctx, input.id));
}

export function listPlans(ctx: CrmContext, input: ListPlansQuery): Page<Plan> {
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const active = input.active === undefined ? null : input.active === 'true' ? 1 : 0;
  const rows = ctx.db.all<PlanRow>(
    `SELECT * FROM crm_subscription_plans WHERE deleted_at IS NULL
       AND (? IS NULL OR product_id = ?) AND (? IS NULL OR active = ?) AND (? IS NULL OR id > ?)
     ORDER BY id LIMIT ?`,
    input.product_id ?? null,
    input.product_id ?? null,
    active,
    active,
    after,
    after,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(planToApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}

export function createPlan(
  ctx: CrmContext,
  input: { productId: string; data: CreatePlanInput },
): Plan {
  const product = getProductRow(ctx, input.productId);
  const count =
    ctx.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crm_subscription_plans WHERE product_id = ? AND deleted_at IS NULL`,
      product.id,
    )[0]?.n ?? 0;
  return getPlan(ctx, { id: insertPlan(ctx, product, input.data, count) });
}

/** Plan edits never touch running subscriptions: they snapshot price and interval. */
export function updatePlan(ctx: CrmContext, input: { id: string; data: UpdatePlanInput }): Plan {
  const row = getPlanRow(ctx, input.id);
  const d = input.data;
  ctx.db.run(
    `UPDATE crm_subscription_plans SET name = ?, interval = ?, interval_count = ?, trial_days = ?,
       price_minor = ?, setup_fee_minor = ?, active = ?, position = ?, updated_at = ? WHERE id = ?`,
    d.name ?? row.name,
    d.interval ?? row.interval,
    d.interval_count ?? row.interval_count,
    d.trial_days ?? row.trial_days,
    d.price_minor ?? row.price_minor,
    d.setup_fee_minor ?? row.setup_fee_minor,
    d.active === undefined ? row.active : d.active ? 1 : 0,
    d.position ?? row.position,
    ctx.now(),
    row.id,
  );
  return getPlan(ctx, { id: row.id });
}

export function deletePlan(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getPlanRow(ctx, input.id);
  const live = ctx.db.all(
    `SELECT 1 FROM crm_subscriptions WHERE plan_id = ? AND status <> 'cancelled' LIMIT 1`,
    row.id,
  );
  if (live.length > 0) {
    throw new CrmError('conflict', 'plan has live subscriptions; deactivate it instead');
  }
  ctx.db.run(`UPDATE crm_subscription_plans SET deleted_at = ? WHERE id = ?`, ctx.now(), row.id);
  return { id: row.id, deleted: true };
}

// ------------------------------------------------------------------ products

export interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  category_id: string | null;
  price_minor: number;
  currency: string;
  tax_rate_bps: number;
  active: number;
  created_at: number;
  updated_at: number;
}

function productsToApi(ctx: CrmContext, rows: ProductRow[]): Product[] {
  const plans = plansOf(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sku: row.sku,
    category_id: row.category_id,
    price_minor: row.price_minor,
    currency: row.currency,
    tax_rate_bps: row.tax_rate_bps,
    active: row.active === 1,
    plans: plans.get(row.id) ?? [],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }));
}

export function getProductRow(ctx: CrmContext, id: string): ProductRow {
  const row = ctx.db.all<ProductRow>(
    `SELECT * FROM crm_products WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('product', id);
  return row;
}

export function getProduct(ctx: CrmContext, input: { id: string }): Product {
  const [product] = productsToApi(ctx, [getProductRow(ctx, input.id)]);
  if (product === undefined) throw notFound('product', input.id);
  return product;
}

function assertSkuFree(
  ctx: CrmContext,
  sku: string | null | undefined,
  exceptId: string | null,
): void {
  if (sku === null || sku === undefined) return;
  const clash = ctx.db.all(
    `SELECT 1 FROM crm_products WHERE sku = ? COLLATE NOCASE AND deleted_at IS NULL AND id IS NOT ?`,
    sku,
    exceptId,
  );
  if (clash.length > 0)
    throw new CrmError('conflict', `SKU ${sku} is already used by another product`);
}

function assertCategory(ctx: CrmContext, id: string | null | undefined): void {
  if (id === null || id === undefined) return;
  const rows = ctx.db.all(
    `SELECT 1 FROM crm_product_categories WHERE id = ? AND deleted_at IS NULL`,
    id,
  );
  if (rows.length === 0) throw invalid('category_id', `product category ${id} not found`);
}

export function listProducts(ctx: CrmContext, input: ListProductsQuery): Page<Product> {
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const name = cursor === null ? null : String(cursor.v ?? '');
  const active = input.active === undefined ? null : input.active === 'true' ? 1 : 0;
  const like =
    input.q === undefined || input.q === ''
      ? null
      : `%${input.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = ctx.db.all<ProductRow>(
    `SELECT * FROM crm_products WHERE deleted_at IS NULL
       AND (? IS NULL OR category_id = ?) AND (? IS NULL OR active = ?)
       AND (? IS NULL OR LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(sku, '')) LIKE ? ESCAPE '\\')
       AND (? IS NULL OR LOWER(name) > ? OR (LOWER(name) = ? AND id > ?))
     ORDER BY LOWER(name), id LIMIT ?`,
    input.category_id ?? null,
    input.category_id ?? null,
    active,
    active,
    like,
    like,
    like,
    name,
    name,
    name,
    cursor?.id ?? null,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: productsToApi(ctx, page),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: last.name.toLowerCase(), id: last.id })
        : null,
  };
}

export function createProduct(ctx: CrmContext, input: CreateProductInput): Product {
  assertSkuFree(ctx, input.sku, null);
  assertCategory(ctx, input.category_id);
  const id = ctx.newId();
  const now = ctx.now();
  const settings = getSettings(ctx);
  ctx.db.run(
    `INSERT INTO crm_products (id, name, description, sku, category_id, price_minor, currency, tax_rate_bps,
       active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.description ?? null,
    input.sku ?? null,
    input.category_id ?? null,
    input.price_minor,
    input.currency ?? settings.default_currency,
    input.tax_rate_bps ?? settings.default_tax_rate_bps,
    input.active === false ? 0 : 1,
    ctx.actor.id,
    now,
    now,
  );
  const row = getProductRow(ctx, id);
  (input.plans ?? []).forEach((plan, i) => insertPlan(ctx, row, plan, i));
  return getProduct(ctx, { id });
}

export function updateProduct(
  ctx: CrmContext,
  input: { id: string; data: UpdateProductInput },
): Product {
  const row = getProductRow(ctx, input.id);
  const d = input.data;
  if (d.sku !== undefined) assertSkuFree(ctx, d.sku, row.id);
  assertCategory(ctx, d.category_id);
  if (d.currency !== undefined && d.currency !== row.currency) {
    const plans = ctx.db.all(
      `SELECT 1 FROM crm_subscription_plans WHERE product_id = ? AND deleted_at IS NULL LIMIT 1`,
      row.id,
    );
    if (plans.length > 0)
      throw invalid('currency', 'cannot change the currency of a product with plans');
  }
  ctx.db.run(
    `UPDATE crm_products SET name = ?, description = ?, sku = ?, category_id = ?, price_minor = ?, currency = ?,
       tax_rate_bps = ?, active = ?, updated_at = ? WHERE id = ?`,
    d.name ?? row.name,
    d.description === undefined ? row.description : d.description,
    d.sku === undefined ? row.sku : d.sku,
    d.category_id === undefined ? row.category_id : d.category_id,
    d.price_minor ?? row.price_minor,
    d.currency ?? row.currency,
    d.tax_rate_bps ?? row.tax_rate_bps,
    d.active === undefined ? row.active : d.active ? 1 : 0,
    ctx.now(),
    row.id,
  );
  return getProduct(ctx, { id: row.id });
}

/** Soft delete; past orders keep their line snapshots. Products with live subscriptions stay. */
export function deleteProduct(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getProductRow(ctx, input.id);
  const live = ctx.db.all(
    `SELECT 1 FROM crm_subscriptions WHERE product_id = ? AND status <> 'cancelled' LIMIT 1`,
    row.id,
  );
  if (live.length > 0) {
    throw new CrmError('conflict', 'product has live subscriptions; deactivate it instead');
  }
  const now = ctx.now();
  ctx.db.run(`UPDATE crm_products SET deleted_at = ? WHERE id = ?`, now, row.id);
  ctx.db.run(
    `UPDATE crm_subscription_plans SET deleted_at = ? WHERE product_id = ? AND deleted_at IS NULL`,
    now,
    row.id,
  );
  return { id: row.id, deleted: true };
}
