import type {
  ChartType,
  CustomReport,
  Dashboard,
  DashboardWidget,
  ReportDefinition,
} from '@amable/api-types/reports';
import type { CrmContext } from '../crm/context';
import { CrmError } from '../crm/errors';
import { toIso } from '../crm/util';

/**
 * Saved custom reports and widget dashboards of a tenant, stored as JSON rows
 * of `tenant_meta` (`reports.custom:<id>`, `reports.dashboard:<id>`): no new
 * table, no migration, range scans on the primary key. Definitions are
 * validated by the REST layer before they reach the DO.
 *
 * Visibility: shared items are visible to every member with report access;
 * private ones only to their owner. Changes: owner, or `canManageAll`
 * (owner/admin roles). Only `canManageAll` marks the tenant default dashboard.
 */

const CUSTOM = 'reports.custom:';
const DASHBOARD = 'reports.dashboard:';
const MAX_CUSTOM_REPORTS = 500;
const MAX_DASHBOARDS = 200;

interface StoredCustomReport {
  id: string;
  name: string;
  description: string | null;
  definition: ReportDefinition;
  chart: ChartType;
  shared: boolean;
  owner_id: string | null;
  created_at: number;
  updated_at: number;
}

interface StoredDashboard {
  id: string;
  name: string;
  shared: boolean;
  is_default: boolean;
  owner_id: string | null;
  widgets: DashboardWidget[];
  created_at: number;
  updated_at: number;
}

/** Keys with `prefix`: `[prefix, prefix-with-next-char)` is a primary-key range scan. */
function scan<T>(ctx: CrmContext, prefix: string): T[] {
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return ctx.db
    .all<{ value: string }>(
      `SELECT value FROM tenant_meta WHERE key >= ? AND key < ? ORDER BY key`,
      prefix,
      end,
    )
    .map((r) => JSON.parse(r.value) as T);
}

function read<T>(ctx: CrmContext, key: string): T | null {
  const row = ctx.db.all<{ value: string }>(`SELECT value FROM tenant_meta WHERE key = ?`, key)[0];
  return row === undefined ? null : (JSON.parse(row.value) as T);
}

function write(ctx: CrmContext, key: string, value: unknown): void {
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    JSON.stringify(value),
  );
}

function remove(ctx: CrmContext, key: string): void {
  ctx.db.run(`DELETE FROM tenant_meta WHERE key = ?`, key);
}

function visible(ctx: CrmContext, item: { shared: boolean; owner_id: string | null }): boolean {
  return item.shared || (item.owner_id !== null && item.owner_id === ctx.actor.id);
}

function assertCanChange(
  ctx: CrmContext,
  item: { owner_id: string | null },
  canManageAll: boolean,
): void {
  if (canManageAll) return;
  if (item.owner_id === null || item.owner_id !== ctx.actor.id) {
    throw new CrmError('forbidden', 'only the owner (or an admin) can change this item');
  }
}

// ----------------------------------------------------------- custom reports

function toCustomReport(row: StoredCustomReport): CustomReport {
  return { ...row, created_at: toIso(row.created_at), updated_at: toIso(row.updated_at) };
}

export function listCustomReports(ctx: CrmContext, _input: Record<string, never>): CustomReport[] {
  return scan<StoredCustomReport>(ctx, CUSTOM)
    .filter((r) => visible(ctx, r))
    .sort((a, b) => b.updated_at - a.updated_at)
    .map(toCustomReport);
}

function customOrThrow(ctx: CrmContext, id: string): StoredCustomReport {
  const row = read<StoredCustomReport>(ctx, CUSTOM + id);
  if (row === null || !visible(ctx, row))
    throw new CrmError('not_found', 'custom report not found');
  return row;
}

export function getCustomReport(ctx: CrmContext, input: { id: string }): CustomReport {
  return toCustomReport(customOrThrow(ctx, input.id));
}

export interface CustomReportData {
  name: string;
  description?: string | null | undefined;
  definition: ReportDefinition;
  chart: ChartType;
  shared: boolean;
}

export function createCustomReport(
  ctx: CrmContext,
  input: { data: CustomReportData },
): CustomReport {
  if (scan<StoredCustomReport>(ctx, CUSTOM).length >= MAX_CUSTOM_REPORTS) {
    throw new CrmError(
      'conflict',
      `at most ${String(MAX_CUSTOM_REPORTS)} custom reports per tenant`,
    );
  }
  const now = ctx.now();
  const row: StoredCustomReport = {
    id: ctx.newId(),
    name: input.data.name,
    description: input.data.description ?? null,
    definition: input.data.definition,
    chart: input.data.chart,
    shared: input.data.shared,
    owner_id: ctx.actor.id,
    created_at: now,
    updated_at: now,
  };
  write(ctx, CUSTOM + row.id, row);
  return toCustomReport(row);
}

export function updateCustomReport(
  ctx: CrmContext,
  input: { id: string; data: Partial<CustomReportData>; canManageAll: boolean },
): CustomReport {
  const row = customOrThrow(ctx, input.id);
  assertCanChange(ctx, row, input.canManageAll);
  const next: StoredCustomReport = {
    ...row,
    ...(input.data.name === undefined ? {} : { name: input.data.name }),
    ...(input.data.description === undefined ? {} : { description: input.data.description }),
    ...(input.data.definition === undefined ? {} : { definition: input.data.definition }),
    ...(input.data.chart === undefined ? {} : { chart: input.data.chart }),
    ...(input.data.shared === undefined ? {} : { shared: input.data.shared }),
    updated_at: ctx.now(),
  };
  write(ctx, CUSTOM + row.id, next);
  return toCustomReport(next);
}

export function deleteCustomReport(
  ctx: CrmContext,
  input: { id: string; canManageAll: boolean },
): { id: string } {
  const row = customOrThrow(ctx, input.id);
  assertCanChange(ctx, row, input.canManageAll);
  remove(ctx, CUSTOM + row.id);
  return { id: row.id };
}

// --------------------------------------------------------------- dashboards

function toDashboard(row: StoredDashboard): Dashboard {
  return {
    ...row,
    builtin: false,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function listDashboards(ctx: CrmContext, _input: Record<string, never>): Dashboard[] {
  return scan<StoredDashboard>(ctx, DASHBOARD)
    .filter((d) => visible(ctx, d))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.name.localeCompare(b.name))
    .map(toDashboard);
}

function dashboardOrThrow(ctx: CrmContext, id: string): StoredDashboard {
  const row = read<StoredDashboard>(ctx, DASHBOARD + id);
  if (row === null || !visible(ctx, row)) throw new CrmError('not_found', 'dashboard not found');
  return row;
}

export function getDashboard(ctx: CrmContext, input: { id: string }): Dashboard {
  return toDashboard(dashboardOrThrow(ctx, input.id));
}

/** The tenant default (shared) dashboard of the home page, if any. */
export function defaultDashboard(ctx: CrmContext, _input: Record<string, never>): Dashboard | null {
  const row = scan<StoredDashboard>(ctx, DASHBOARD).find((d) => d.is_default && d.shared);
  return row === undefined ? null : toDashboard(row);
}

export interface DashboardData {
  name: string;
  shared: boolean;
  is_default: boolean;
  widgets: DashboardWidget[];
}

function assertWidgets(widgets: readonly DashboardWidget[]): void {
  const ids = new Set<string>();
  for (const w of widgets) {
    if (ids.has(w.id)) throw new CrmError('validation_failed', `duplicate widget id ${w.id}`);
    ids.add(w.id);
    if (w.layout.x + w.layout.w > 12) {
      throw new CrmError('validation_failed', `widget ${w.id} overflows the 12-column grid`);
    }
  }
}

function clearOtherDefaults(ctx: CrmContext, keepId: string): void {
  for (const d of scan<StoredDashboard>(ctx, DASHBOARD)) {
    if (d.id !== keepId && d.is_default) write(ctx, DASHBOARD + d.id, { ...d, is_default: false });
  }
}

export function createDashboard(
  ctx: CrmContext,
  input: { data: DashboardData; canManageAll: boolean },
): Dashboard {
  if (scan<StoredDashboard>(ctx, DASHBOARD).length >= MAX_DASHBOARDS) {
    throw new CrmError('conflict', `at most ${String(MAX_DASHBOARDS)} dashboards per tenant`);
  }
  if (input.data.is_default && !input.canManageAll) {
    throw new CrmError('forbidden', 'only owners and admins choose the default dashboard');
  }
  if (input.data.is_default && !input.data.shared) {
    throw new CrmError('validation_failed', 'the default dashboard must be shared');
  }
  assertWidgets(input.data.widgets);
  const now = ctx.now();
  const row: StoredDashboard = {
    id: ctx.newId(),
    ...input.data,
    owner_id: ctx.actor.id,
    created_at: now,
    updated_at: now,
  };
  write(ctx, DASHBOARD + row.id, row);
  if (row.is_default) clearOtherDefaults(ctx, row.id);
  return toDashboard(row);
}

export function updateDashboard(
  ctx: CrmContext,
  input: { id: string; data: Partial<DashboardData>; canManageAll: boolean },
): Dashboard {
  const row = dashboardOrThrow(ctx, input.id);
  assertCanChange(ctx, row, input.canManageAll);
  if (
    input.data.is_default !== undefined &&
    input.data.is_default !== row.is_default &&
    !input.canManageAll
  ) {
    throw new CrmError('forbidden', 'only owners and admins choose the default dashboard');
  }
  const next: StoredDashboard = {
    ...row,
    ...(input.data.name === undefined ? {} : { name: input.data.name }),
    ...(input.data.shared === undefined ? {} : { shared: input.data.shared }),
    ...(input.data.is_default === undefined ? {} : { is_default: input.data.is_default }),
    ...(input.data.widgets === undefined ? {} : { widgets: input.data.widgets }),
    updated_at: ctx.now(),
  };
  if (next.is_default && !next.shared)
    throw new CrmError('validation_failed', 'the default dashboard must be shared');
  assertWidgets(next.widgets);
  write(ctx, DASHBOARD + row.id, next);
  if (next.is_default) clearOtherDefaults(ctx, row.id);
  return toDashboard(next);
}

export function deleteDashboard(
  ctx: CrmContext,
  input: { id: string; canManageAll: boolean },
): { id: string } {
  const row = dashboardOrThrow(ctx, input.id);
  assertCanChange(ctx, row, input.canManageAll);
  remove(ctx, DASHBOARD + row.id);
  return { id: row.id };
}
