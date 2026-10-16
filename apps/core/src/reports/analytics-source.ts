import {
  ATTRIBUTION_MODELS,
  type AnalyticsBreakdownDimension,
  type AnalyticsInterval,
  type AnalyticsRange,
  type AttributionModel,
} from '@amable/api-types';
import { siteStub, tenantSitesStub, type AnalyticsNamespace } from '@amable/app-edge/analytics';
import type { AggregateOutput, AggregateRow } from './aggregate';

/**
 * Report adapter of the web analytics (AnalyticsDO per site, edge worker).
 * The engine codes against this small interface only: methods that a given
 * analytics build lacks (attribution, ads) fail at call time and the report
 * degrades to an explained empty state instead of an error.
 */

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type { AttributionModel };

/** The fields the reports read (the analytics responses carry more). */
export interface OverviewFacts {
  visitors: number;
  sessions: number;
  pageviews: number;
  revenue_minor: number;
  conversions: number;
  goals?: number;
  currency: string;
}
export interface TimeseriesFacts {
  points: Array<{
    t: string;
    label: string;
    visitors: number;
    sessions: number;
    pageviews: number;
    goals: number;
    revenue_minor: number;
  }>;
}
export interface BreakdownFacts {
  rows: Array<{
    value: string | null;
    visitors: number;
    sessions?: number;
    pageviews?: number;
    revenue_minor?: number;
    /** Attributed customers (fractional with the multi-touch models). */
    conversions?: number;
  }>;
}
export interface AdsFacts {
  currency: string;
  totals: { spend_minor: number; revenue_minor: number; clicks: number; impressions: number };
  campaigns: Array<{
    campaign_id: string;
    campaign_name: string;
    spend_minor: number;
    impressions: number;
    clicks: number;
    customers: number;
    revenue_minor: number;
  }>;
}

export interface AnalyticsSiteApi {
  getSite(): Promise<{
    tenantId: string;
    deleted: boolean;
    site: { id: string; name: string; currency: string };
  } | null>;
  overview(range: AnalyticsRange): Promise<Result<OverviewFacts>>;
  timeseries(range: AnalyticsRange, interval: AnalyticsInterval): Promise<Result<TimeseriesFacts>>;
  breakdown(
    range: AnalyticsRange,
    dimension: AnalyticsBreakdownDimension,
    limit: number,
    model?: AttributionModel,
  ): Promise<Result<BreakdownFacts>>;
  ads(range: AnalyticsRange, model?: AttributionModel): Promise<Result<AdsFacts>>;
}

export interface AnalyticsPort {
  siteIds(tenantId: string): Promise<string[]>;
  site(siteId: string): AnalyticsSiteApi;
}

/** Port over the cross-script `ANALYTICS` namespace (RPC boundary: structural view of the stub). */
export function analyticsPort(ns: AnalyticsNamespace): AnalyticsPort {
  return {
    siteIds: (tenantId) => tenantSitesStub(ns, tenantId).indexList(),
    site: (siteId) => siteStub(ns, siteId) as unknown as AnalyticsSiteApi,
  };
}

export interface AnalyticsQuery {
  tenantId: string;
  source: 'analytics' | 'ad_campaigns';
  measures: string[];
  dimension: string | null;
  granularity: AnalyticsInterval;
  range: { from: string; to: string; timezone: string };
  limit: number;
  params: Record<string, string>;
}

const MODEL_OPTIONS = ATTRIBUTION_MODELS.map((m) => ({ value: m, label: m }));

function empty(
  reason:
    | AggregateOutput['emptyReason']
    | 'analytics_unavailable'
    | 'no_sites'
    | 'attribution_unavailable',
  options: AggregateOutput['options'] = {},
): AnalyticsOutput {
  return {
    rows: [],
    totals: {},
    currency: null,
    currencies: [],
    truncated: false,
    options,
    reason,
  };
}

export interface AnalyticsOutput extends Omit<AggregateOutput, 'emptyReason'> {
  reason:
    | AggregateOutput['emptyReason']
    | 'analytics_unavailable'
    | 'no_sites'
    | 'attribution_unavailable'
    | null;
}

function pick(
  values: Record<string, number | undefined>,
  measures: string[],
): Record<string, number> {
  return Object.fromEntries(measures.map((m) => [m, values[m] ?? 0]));
}

export async function queryAnalytics(
  port: AnalyticsPort | null,
  q: AnalyticsQuery,
): Promise<AnalyticsOutput> {
  if (port === null) return empty('analytics_unavailable');
  let siteIds: string[];
  try {
    siteIds = await port.siteIds(q.tenantId);
  } catch {
    return empty('analytics_unavailable');
  }
  const sites: Array<{ value: string; label: string; currency: string }> = [];
  for (const id of siteIds.slice(0, 50)) {
    const record = await port.site(id).getSite();
    if (record !== null && !record.deleted && record.tenantId === q.tenantId) {
      sites.push({ value: id, label: record.site.name, currency: record.site.currency });
    }
  }
  const options = {
    site_id: sites.map(({ value, label }) => ({ value, label })),
    model: MODEL_OPTIONS,
  };
  const site = sites.find((s) => s.value === q.params['site_id']) ?? sites[0];
  if (site === undefined) return empty('no_sites', options);
  const api = port.site(site.value);
  const range: AnalyticsRange = { ...q.range, filters: [] };
  const model = ATTRIBUTION_MODELS.find((m) => m === q.params['model']);
  try {
    if (q.source === 'ad_campaigns') {
      const ads = await api.ads(range, model);
      if (!ads.ok) return empty('attribution_unavailable', options);
      const rows: AggregateRow[] = ads.value.campaigns.map((c) => ({
        key: c.campaign_id,
        label: c.campaign_name,
        values: pick(
          {
            spend: c.spend_minor,
            revenue: c.revenue_minor,
            clicks: c.clicks,
            impressions: c.impressions,
            customers: c.customers,
          },
          q.measures,
        ),
      }));
      const customers = ads.value.campaigns.reduce((s, c) => s + c.customers, 0);
      const t = ads.value.totals;
      return {
        rows: q.dimension === null ? [] : rows.slice(0, q.limit),
        totals: pick(
          {
            spend: t.spend_minor,
            revenue: t.revenue_minor,
            clicks: t.clicks,
            impressions: t.impressions,
            customers,
          },
          q.measures,
        ),
        currency: ads.value.currency,
        currencies: [],
        truncated: rows.length > q.limit,
        options,
        reason: null,
      };
    }
    const overview = await api.overview(range);
    if (!overview.ok) return empty('analytics_unavailable', options);
    const o = overview.value;
    // Same meaning as the rows: goals per date bucket, credited purchases per source value.
    let conversions = q.dimension === 'date' ? (o.goals ?? o.conversions) : o.conversions;
    let rows: AggregateRow[] = [];
    let truncated = false;
    if (q.dimension === 'date') {
      const ts = await api.timeseries(range, q.granularity);
      if (ts.ok) {
        rows = ts.value.points.map((p) => ({
          key: p.t,
          label: p.label,
          values: pick(
            {
              visitors: p.visitors,
              sessions: p.sessions,
              pageviews: p.pageviews,
              revenue: p.revenue_minor,
              conversions: p.goals,
            },
            q.measures,
          ),
        }));
      }
    } else if (q.dimension !== null) {
      const breakdown = await api.breakdown(
        range,
        q.dimension as AnalyticsBreakdownDimension,
        q.limit + 1,
        model,
      );
      if (!breakdown.ok) return empty('attribution_unavailable', options);
      if (breakdown.value.rows.some((r) => r.conversions !== undefined)) {
        const credited = breakdown.value.rows.reduce((sum, r) => sum + (r.conversions ?? 0), 0);
        conversions = Math.round(credited * 1000) / 1000;
      }
      rows = breakdown.value.rows.map((r) => ({
        key: r.value ?? '',
        label: r.value ?? '',
        values: pick(
          {
            visitors: r.visitors,
            sessions: r.sessions,
            pageviews: r.pageviews,
            revenue: r.revenue_minor,
            conversions: r.conversions,
          },
          q.measures,
        ),
      }));
      truncated = rows.length > q.limit;
      rows = rows.slice(0, q.limit);
    }
    const totals = pick(
      {
        visitors: o.visitors,
        sessions: o.sessions,
        pageviews: o.pageviews,
        revenue: o.revenue_minor,
        conversions,
      },
      q.measures,
    );
    return { rows, totals, currency: o.currency, currencies: [], truncated, options, reason: null };
  } catch {
    return empty('attribution_unavailable', options);
  }
}
