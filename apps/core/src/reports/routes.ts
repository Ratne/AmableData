import { z } from '@hono/zod-openapi';
import {
  REPORT_SOURCE_SPECS,
  createCustomReportSchema,
  createDashboardSchema,
  customReportSchema,
  dashboardSchema,
  reportCatalogEntrySchema,
  reportOverridesSchema,
  reportResultSchema,
  runAdHocReportSchema,
  updateCustomReportSchema,
  updateDashboardSchema,
  type CustomReport,
  type Dashboard,
  type DashboardWidget,
  type ReportCatalogEntry,
  type ReportDefinition,
  type ReportSource,
  type ReportSourceSpec,
} from '@amable/api-types/reports';
import type { Context, Hono } from 'hono';
import { callCrm, createCrmRouter, CrmHttpError, crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import type { CrmResult } from '../crm/ops';
import { callMail } from '../email/http';
import { audit, getTenant, type AppEnv } from '../middleware';
import type { AggregateOutput } from './aggregate';
import { analyticsPort } from './analytics-source';
import { BUILTIN_REPORTS, builtinHomeWidgets, builtinReport } from './catalog';
import { csvHeader, csvRows, csvStream } from './csv';
import { applyOverrides, runReport, validateDefinition, type ReportPorts } from './engine';

type Ctx = Context<AppEnv>;
const tags = ['Reports'];
const reportIdParam = z.object({ reportId: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
const idParam = z.object({ id: z.string().regex(/^[A-Za-z0-9]{1,64}$/) });
const EXPORT_PAGE = 1000;
const MAX_EXPORT_ROWS = 50_000;
const USER_CHUNK = 90;

// --------------------------------------------------------------------- access

/** Report permission (sales vs all reports) + the module permission of the source. */
export function canReadSource(c: Ctx, source: ReportSource): boolean {
  const tenant = getTenant(c);
  const spec: ReportSourceSpec = REPORT_SOURCE_SPECS[source];
  return (
    tenant.can(spec.sales ? 'reports:sales_read' : 'reports:read') && tenant.can(spec.permission)
  );
}

function assertSourceAccess(c: Ctx, source: ReportSource): void {
  if (!canReadSource(c, source)) {
    throw new CrmError('forbidden', `your role cannot read ${source} reports`);
  }
}

function canManageAll(c: Ctx): boolean {
  return getTenant(c).can('settings:manage');
}

// ---------------------------------------------------------------------- ports

async function userLabels(c: Ctx, ids: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += USER_CHUNK) {
    const chunk = unique.slice(i, i + USER_CHUNK);
    const rows = await c.env.DB.prepare(
      `SELECT u.id AS id, COALESCE(u.name, u.email) AS label FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ?
        WHERE u.id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(getTenant(c).tenant.id, ...chunk)
      .all<{ id: string; label: string }>();
    for (const r of rows.results) labels.set(r.id, r.label);
  }
  return labels;
}

export function reportPorts(c: Ctx): ReportPorts {
  const tenantId = getTenant(c).tenant.id;
  return {
    tenantId,
    aggregate: async (target, input) => {
      if (target === 'tenant')
        return (await callCrm(c, 'reports.aggregate', input)) as AggregateOutput;
      if (target === 'mail')
        return (await callMail(c, 'reports.aggregate', input)) as AggregateOutput;
      const stub = c.env.ENGINE.get(c.env.ENGINE.idFromName(tenantId));
      const result = (await stub.report(
        tenantId,
        'reports.aggregate',
        input,
      )) as CrmResult<AggregateOutput>;
      if (!result.ok) throw new CrmHttpError(result.error);
      return result.value;
    },
    analytics: c.env.ANALYTICS === undefined ? null : analyticsPort(c.env.ANALYTICS),
    userLabels: (ids) => userLabels(c, ids),
    now: () => c.get('services').now(),
  };
}

// -------------------------------------------------------------------- catalog

function builtinEntry(id: string): ReportCatalogEntry | null {
  const r = builtinReport(id);
  if (r === undefined) return null;
  return {
    id: r.id,
    kind: 'builtin',
    category: r.category,
    name: r.name,
    description: r.description,
    chart: r.chart,
    definition: r.definition,
  };
}

function customEntry(r: CustomReport): ReportCatalogEntry {
  return {
    id: r.id,
    kind: 'custom',
    category: REPORT_SOURCE_SPECS[r.definition.source].sales ? 'sales' : 'crm',
    name: r.name,
    description: r.description ?? '',
    chart: r.chart,
    definition: r.definition,
    shared: r.shared,
    owner_id: r.owner_id,
  };
}

async function customEntries(c: Ctx): Promise<ReportCatalogEntry[]> {
  return (await callCrm(c, 'reports.custom.list', {})).map(customEntry);
}

/** Built-in or custom report by id, readable by the caller. */
async function resolveReport(c: Ctx, id: string): Promise<ReportCatalogEntry> {
  const resolved = builtinEntry(id) ?? customEntry(await callCrm(c, 'reports.custom.get', { id }));
  assertSourceAccess(c, resolved.definition.source);
  return resolved;
}

function readableSources(c: Ctx): Partial<Record<ReportSource, ReportSourceSpec>> {
  const out: Partial<Record<ReportSource, ReportSourceSpec>> = {};
  for (const [source, spec] of Object.entries(REPORT_SOURCE_SPECS) as Array<
    [ReportSource, ReportSourceSpec]
  >) {
    if (canReadSource(c, source)) out[source] = spec;
  }
  return out;
}

async function assertWidgetReports(
  c: Ctx,
  widgets: readonly DashboardWidget[] | undefined,
): Promise<void> {
  if (widgets === undefined || widgets.length === 0) return;
  const custom = new Set((await callCrm(c, 'reports.custom.list', {})).map((r) => r.id));
  for (const w of widgets) {
    if (builtinReport(w.report_id) === undefined && !custom.has(w.report_id)) {
      throw new CrmError('validation_failed', `widgets: unknown report ${w.report_id}`);
    }
  }
}

function homeDashboard(c: Ctx): Dashboard {
  return {
    id: 'home',
    name: 'Home',
    shared: true,
    is_default: true,
    owner_id: null,
    widgets: builtinHomeWidgets((id) => {
      const r = builtinReport(id);
      return r !== undefined && canReadSource(c, r.definition.source);
    }),
    builtin: true,
    created_at: null,
    updated_at: null,
  };
}

// ---------------------------------------------------------------------- routes

/** Report engine REST v2, relative to `/api/v2/t/{slug}`. */
export const reportsApi = createCrmRouter();

const sourcesSchema = z.record(z.string(), z.unknown());

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/reports',
    tags,
    summary:
      'Report catalog: built-in and saved custom reports the caller can run, plus the source specs',
    responses: {
      200: json(
        z.object({ data: z.array(reportCatalogEntrySchema), sources: sourcesSchema }),
        'Catalog',
      ),
    },
  }),
  async (c) => {
    const builtins = BUILTIN_REPORTS.map((r) => builtinEntry(r.id)).filter(
      (e): e is ReportCatalogEntry => e !== null,
    );
    const all = [...builtins, ...(await customEntries(c))].filter((e) =>
      canReadSource(c, e.definition.source),
    );
    return c.json({ data: all, sources: readableSources(c) }, 200);
  },
);

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'post',
    path: '/reports/run',
    tags,
    summary: 'Run an ad-hoc report definition (report builder preview)',
    request: { body: jsonBody(runAdHocReportSchema) },
    responses: { 200: json(reportResultSchema, 'Report result') },
  }),
  async (c) => {
    const { definition } = c.req.valid('json');
    assertSourceAccess(c, definition.source);
    return c.json(await runReport(reportPorts(c), definition, { reportId: null }), 200);
  },
);

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/reports/{reportId}',
    tags,
    summary: 'Get a report (definition and metadata)',
    request: { params: reportIdParam },
    responses: { 200: json(reportCatalogEntrySchema, 'Report') },
  }),
  async (c) => c.json(await resolveReport(c, c.req.valid('param').reportId), 200),
);

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'post',
    path: '/reports/{reportId}/run',
    tags,
    summary:
      'Run a report, optionally overriding range, comparison, granularity, currency, parameters',
    request: {
      params: reportIdParam,
      body: {
        required: false,
        content: {
          'application/json': {
            schema: z.strictObject({ overrides: reportOverridesSchema.optional() }),
          },
        },
      },
    },
    responses: { 200: json(reportResultSchema, 'Report result') },
  }),
  async (c) => {
    const entry = await resolveReport(c, c.req.valid('param').reportId);
    const body = c.req.valid('json');
    const def = applyOverrides(entry.definition, body.overrides);
    return c.json(await runReport(reportPorts(c), def, { reportId: entry.id }), 200);
  },
);

function parseOverridesQuery(
  raw: string | undefined,
): z.infer<typeof reportOverridesSchema> | undefined {
  if (raw === undefined || raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CrmError('validation_failed', 'overrides: not valid JSON');
  }
  const parsed = reportOverridesSchema.safeParse(value);
  if (!parsed.success)
    throw new CrmError(
      'validation_failed',
      `overrides: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  return parsed.data;
}

reportsApi.openapi(
  crmRoute('reports:export', {
    method: 'get',
    path: '/reports/{reportId}/export.csv',
    tags,
    summary:
      'Export every row of a report as CSV (streamed; `overrides` = URL-encoded JSON overrides)',
    request: {
      params: reportIdParam,
      query: z.object({ overrides: z.string().max(4000).optional() }),
    },
    responses: {
      200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } },
    },
  }),
  async (c) => {
    const entry = await resolveReport(c, c.req.valid('param').reportId);
    const def: ReportDefinition = applyOverrides(
      entry.definition,
      parseOverridesQuery(c.req.valid('query').overrides),
    );
    const ports = reportPorts(c);
    const first = await runReport(ports, def, {
      reportId: entry.id,
      offset: 0,
      pageLimit: EXPORT_PAGE,
    });
    await audit(c, 'reports.exported', {
      target: entry.id,
      details: { source: def.source, from: first.range.from, to: first.range.to },
    });
    async function* pages(): AsyncGenerator<Array<Array<string | number | null>>> {
      let result = first;
      let offset = 0;
      for (;;) {
        const paged = result.dimension !== null && result.dimension !== 'date';
        const last = !paged || !result.meta.truncated || offset + EXPORT_PAGE >= MAX_EXPORT_ROWS;
        yield csvRows(result, last);
        if (last) return;
        offset += EXPORT_PAGE;
        result = await runReport(ports, def, {
          reportId: entry.id,
          offset,
          pageLimit: EXPORT_PAGE,
        });
      }
    }
    const filename = `${entry.id}-${first.range.from}-${first.range.to}.csv`;
    return c.body(csvStream(csvHeader(first), pages()), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    });
  },
);

// ------------------------------------------------------------- custom reports

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/customReports',
    tags,
    summary: 'List saved custom reports (shared + own)',
    responses: { 200: json(z.object({ data: z.array(customReportSchema) }), 'Custom reports') },
  }),
  async (c) => {
    const list = await callCrm(c, 'reports.custom.list', {});
    return c.json({ data: list.filter((r) => canReadSource(c, r.definition.source)) }, 200);
  },
);

reportsApi.openapi(
  crmRoute('reports:create', {
    method: 'post',
    path: '/customReports',
    tags,
    summary: 'Save a custom report',
    request: { body: jsonBody(createCustomReportSchema) },
    responses: { 201: json(customReportSchema, 'Created') },
  }),
  async (c) => {
    const data = c.req.valid('json');
    assertSourceAccess(c, data.definition.source);
    validateDefinition(data.definition);
    const created = await callCrm(c, 'reports.custom.create', { data });
    await audit(c, 'reports.custom_created', {
      target: created.id,
      details: { name: created.name },
    });
    return c.json(created, 201);
  },
);

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/customReports/{id}',
    tags,
    summary: 'Get a custom report',
    request: { params: idParam },
    responses: { 200: json(customReportSchema, 'Custom report') },
  }),
  async (c) => {
    const report = await callCrm(c, 'reports.custom.get', { id: c.req.valid('param').id });
    assertSourceAccess(c, report.definition.source);
    return c.json(report, 200);
  },
);

reportsApi.openapi(
  crmRoute('reports:create', {
    method: 'patch',
    path: '/customReports/{id}',
    tags,
    summary: 'Update a custom report (owner, or owner/admin roles)',
    request: { params: idParam, body: jsonBody(updateCustomReportSchema) },
    responses: { 200: json(customReportSchema, 'Updated') },
  }),
  async (c) => {
    const data = c.req.valid('json');
    if (data.definition !== undefined) {
      assertSourceAccess(c, data.definition.source);
      validateDefinition(data.definition);
    }
    const updated = await callCrm(c, 'reports.custom.update', {
      id: c.req.valid('param').id,
      data,
      canManageAll: canManageAll(c),
    });
    return c.json(updated, 200);
  },
);

reportsApi.openapi(
  crmRoute('reports:create', {
    method: 'delete',
    path: '/customReports/{id}',
    tags,
    summary: 'Delete a custom report',
    request: { params: idParam },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) }), 'Deleted') },
  }),
  async (c) => {
    const { id } = await callCrm(c, 'reports.custom.delete', {
      id: c.req.valid('param').id,
      canManageAll: canManageAll(c),
    });
    await audit(c, 'reports.custom_deleted', { target: id });
    return c.json({ id, deleted: true as const }, 200);
  },
);

// ----------------------------------------------------------------- dashboards

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/dashboards',
    tags,
    summary: 'List widget dashboards (shared + own)',
    responses: { 200: json(z.object({ data: z.array(dashboardSchema) }), 'Dashboards') },
  }),
  async (c) => c.json({ data: await callCrm(c, 'reports.dashboards.list', {}) }, 200),
);

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/dashboards/home',
    tags,
    summary: 'Dashboard of the tenant home page (the default one, or a built-in fallback)',
    responses: { 200: json(dashboardSchema, 'Home dashboard') },
  }),
  async (c) =>
    c.json((await callCrm(c, 'reports.dashboards.default', {})) ?? homeDashboard(c), 200),
);

reportsApi.openapi(
  crmRoute('reports:create', {
    method: 'post',
    path: '/dashboards',
    tags,
    summary:
      'Create a dashboard (private by default; only owner/admin can make it the tenant default)',
    request: { body: jsonBody(createDashboardSchema) },
    responses: { 201: json(dashboardSchema, 'Created') },
  }),
  async (c) => {
    const data = c.req.valid('json');
    await assertWidgetReports(c, data.widgets);
    const created = await callCrm(c, 'reports.dashboards.create', {
      data,
      canManageAll: canManageAll(c),
    });
    await audit(c, 'reports.dashboard_created', {
      target: created.id,
      details: { name: created.name },
    });
    return c.json(created, 201);
  },
);

reportsApi.openapi(
  crmRoute('reports:sales_read', {
    method: 'get',
    path: '/dashboards/{id}',
    tags,
    summary: 'Get a dashboard',
    request: { params: idParam },
    responses: { 200: json(dashboardSchema, 'Dashboard') },
  }),
  async (c) =>
    c.json(await callCrm(c, 'reports.dashboards.get', { id: c.req.valid('param').id }), 200),
);

reportsApi.openapi(
  crmRoute('reports:create', {
    method: 'patch',
    path: '/dashboards/{id}',
    tags,
    summary: 'Update a dashboard: name, sharing, default flag, widgets and their layout',
    request: { params: idParam, body: jsonBody(updateDashboardSchema) },
    responses: { 200: json(dashboardSchema, 'Updated') },
  }),
  async (c) => {
    const data = c.req.valid('json');
    await assertWidgetReports(c, data.widgets);
    const updated = await callCrm(c, 'reports.dashboards.update', {
      id: c.req.valid('param').id,
      data,
      canManageAll: canManageAll(c),
    });
    return c.json(updated, 200);
  },
);

reportsApi.openapi(
  crmRoute('reports:create', {
    method: 'delete',
    path: '/dashboards/{id}',
    tags,
    summary: 'Delete a dashboard',
    request: { params: idParam },
    responses: { 200: json(z.object({ id: z.string(), deleted: z.literal(true) }), 'Deleted') },
  }),
  async (c) => {
    const { id } = await callCrm(c, 'reports.dashboards.delete', {
      id: c.req.valid('param').id,
      canManageAll: canManageAll(c),
    });
    await audit(c, 'reports.dashboard_deleted', { target: id });
    return c.json({ id, deleted: true as const }, 200);
  },
);

/** OpenAPI 3.1 document of the report surface. */
export function reportsOpenApiDocument(): ReturnType<typeof reportsApi.getOpenAPI31Document> {
  return reportsApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'amabledata REST API — reports',
      version: '2.0.0',
      description:
        'Report catalog, report runs (JSON definitions over CRM, e-commerce, email, automation and web analytics sources), CSV export, saved custom reports and widget dashboards. Same authentication, permissions (`x-amable-permission`) and conventions as the CRM API.',
    },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
  });
}

/**
 * Mounts the report API on the core app (basePath `/api`). The central guards
 * on `/v2/t/:slug/*` are registered by the CRM mount.
 */
export function mountReportsApi(app: Hono<AppEnv>): void {
  app.route('/v2/t/:slug', reportsApi);
  app.get('/v2/openapi/reports.json', (c) => c.json(reportsOpenApiDocument()));
}
