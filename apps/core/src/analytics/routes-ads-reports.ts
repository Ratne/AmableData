import { z } from '@hono/zod-openapi';
import {
  AD_PLATFORMS,
  ATTRIBUTION_MODELS_V2,
  cohortReportSchema,
  journeyReportSchema,
  ltvReportSchema,
  PERFORMANCE_GROUP_BY,
  performanceReportSchema,
  REPORT_BASIS,
  trackingQualitySchema,
  type PerformanceFilter,
} from '@amable/api-types';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { crmRoute, json } from '../crm/api/core';
import type { AppEnv } from '../middleware';
import { siteForQuery, unwrap } from './service';

type Ctx = Context<AppEnv>;

const tags = ['Analytics'];
const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeParams = {
  site_id: z.string().min(1).max(64),
  /** First day (site time zone); default: 29 days before `to`. */
  from: day.optional(),
  /** Last day, inclusive; default: today. */
  to: day.optional(),
  timezone: z.string().max(64).optional(),
};
const rangeNote = `Range: \`from\` / \`to\` days (inclusive, site time zone), default the last ${DEFAULT_RANGE_DAYS} days.`;

const performanceParams = z.object({
  ...rangeParams,
  model: z.enum(ATTRIBUTION_MODELS_V2).optional(),
  window_days: z.coerce.number().int().min(1).max(30).optional(),
  group_by: z.enum(PERFORMANCE_GROUP_BY).optional(),
  basis: z.enum(REPORT_BASIS).optional(),
  platform: z.enum(AD_PLATFORMS).optional(),
  traffic_source_id: z.string().max(64).optional(),
  funnel_id: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const ltvParams = z.object({
  ...rangeParams,
  group_by: z.enum(['source', 'campaign', 'platform']).optional(),
  model: z.enum(['first_click', 'last_click']).optional(),
});
const cohortParams = z.object({
  ...rangeParams,
  granularity: z.enum(['week', 'month']).optional(),
  traffic_source_id: z.string().max(64).optional(),
  platform: z.enum(AD_PLATFORMS).optional(),
});
const journeyParams = z.object({
  ...rangeParams,
  step: z.enum(['source', 'campaign', 'node']).optional(),
  converted_only: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const qualityParams = z.object(rangeParams);

/** `from` / `to` with the defaults filled; the DO validates the rest. */
function range(
  c: Ctx,
  p: { from?: string | undefined; to?: string | undefined },
): { from: string; to: string } {
  const now = c.get('services').now();
  const to = p.to ?? new Date(now).toISOString().slice(0, 10);
  const from =
    p.from ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
  return { from, to };
}

/** Drill-down filters: `filter_<dimension>=value` (empty value = rows without one). */
function drillDown(c: Ctx): PerformanceFilter[] {
  const out: PerformanceFilter[] = [];
  for (const dimension of PERFORMANCE_GROUP_BY) {
    for (const value of c.req.queries(`filter_${dimension}`) ?? []) out.push({ dimension, value });
  }
  return out;
}

function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Ad attribution reports over the funnel click-log, the ad spend and the conversions. */
export function registerAdsReportRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads-reports/performance',
      tags,
      summary:
        'Ads performance per platform, source, campaign, adset, ad, day, funnel, node, country or device',
      description: `Cost (ad spend, else the touch cost) and revenue credited with the attribution model (${ATTRIBUTION_MODELS_V2.join(', ')}); \`window_days\` applies to windowed_hybrid. \`basis=click_date\` credits conversions to the date of the credited touch, \`sale_date\` to the conversion date. Drill-down: \`filter_<dimension>=value\` (repeatable; empty = without a value). ${rangeNote}`,
      request: { query: performanceParams },
      responses: { 200: json(performanceReportSchema, 'Rows, totals and the settings used') },
    }),
    async (c) => {
      const { site_id, ...p } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      const report = unwrap(
        await stub.adsPerformanceReport({
          ...defined(p),
          site_id,
          ...range(c, p),
          filters: drillDown(c),
        }),
      );
      return c.json(report, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads-reports/ltv',
      tags,
      summary:
        'Lifetime value per source, campaign or platform at 30/60/90/180/365 days from the join date',
      description: `Customers whose first arrival touch falls in the range, grouped by that touch (first_click) or the last one before their first sale (last_click). ${rangeNote}`,
      request: { query: ltvParams },
      responses: { 200: json(ltvReportSchema, 'LTV per group and window') },
    }),
    async (c) => {
      const { site_id, ...p } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      return c.json(
        unwrap(await stub.adsLtvReport({ ...defined(p), site_id, ...range(c, p) })),
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads-reports/cohorts',
      tags,
      summary:
        'Acquisition cohorts (week or month of the first touch) with revenue and ROI at 0/30/60/90 days',
      description: rangeNote,
      request: { query: cohortParams },
      responses: { 200: json(cohortReportSchema, 'One row per cohort period') },
    }),
    async (c) => {
      const { site_id, ...p } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      return c.json(
        unwrap(await stub.adsCohortReport({ ...defined(p), site_id, ...range(c, p) })),
        200,
      );
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads-reports/journeys',
      tags,
      summary:
        'Aggregated journeys: step sequences up to the first sale with visitors, conversions and revenue',
      description: `Steps by traffic source, campaign or funnel node (max 30 per journey, consecutive repeats collapsed). ${rangeNote}`,
      request: { query: journeyParams },
      responses: { 200: json(journeyReportSchema, 'Journeys, highest revenue first') },
    }),
    async (c) => {
      const { site_id, converted_only, ...p } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      const report = await stub.adsJourneyReport({
        ...defined(p),
        ...(converted_only === undefined ? {} : { converted_only: converted_only === 'true' }),
        site_id,
        ...range(c, p),
      });
      return c.json(unwrap(report), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/ads-reports/tracking-quality',
      tags,
      summary: 'Share of the conversions with an identity, a platform click id and a funnel touch',
      description: rangeNote,
      request: { query: qualityParams },
      responses: { 200: json(trackingQualitySchema, 'Counts and score (0..1)') },
    }),
    async (c) => {
      const { site_id, ...p } = c.req.valid('query');
      const stub = await siteForQuery(c, site_id);
      return c.json(
        unwrap(await stub.trackingQuality({ ...defined(p), site_id, ...range(c, p) })),
        200,
      );
    },
  );
}
