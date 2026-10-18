import type { PerformanceRow } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { createFormatters } from '../src/features/analytics/lib/format';
import {
  changeTone,
  childDimension,
  csvValue,
  DEFAULT_PERFORMANCE_COLUMNS,
  drillInto,
  formatMetric,
  journeyStepLabel,
  metricChange,
  parseColumns,
  parsePerformanceSearch,
  performanceCsv,
  performanceQueryString,
  performanceRequest,
  reportedDeltaTone,
  resolvePerformance,
  roiHeat,
  serializeColumns,
  toCsv,
  toggleColumn,
} from '../src/features/analytics/reports-ads/model';
import {
  validateCohortSearch,
  validateJourneySearch,
  validateLtvSearch,
  validatePerformanceSearch,
} from '../src/features/analytics/reports-ads/search';

function row(patch: Partial<PerformanceRow> = {}): PerformanceRow {
  return {
    key: 'meta',
    label: 'Meta',
    parent_key: null,
    visits: 10,
    clicks: 8,
    cost_minor: 10_000,
    revenue_minor: 25_050,
    total_revenue_minor: 30_000,
    profit_minor: 15_050,
    hard_costs_minor: 1_050,
    net_profit_minor: 14_000,
    roas: 2.505,
    roi: 1.505,
    sales: 2.5,
    leads: 4,
    new_leads: 3,
    returning_customers: 0,
    aov_minor: 10_020,
    cpa_minor: 4_000,
    cvr: 0.25,
    reported_conversions: 3,
    reported_revenue_minor: 30_000,
    reported_vs_revenue_minor: -4_950,
    ...patch,
  };
}

const range = { from: '2026-10-01', to: '2026-10-30' };

describe('performance columns in the search params', () => {
  it('parses lists and comma strings, dropping unknown and duplicate columns', () => {
    expect(parseColumns('clicks,roas,bogus,clicks')).toEqual(['clicks', 'roas']);
    expect(parseColumns(['cost_minor', 'cvr'])).toEqual(['cost_minor', 'cvr']);
    expect(parseColumns('')).toBeUndefined();
    expect(parseColumns(42)).toBeUndefined();
  });

  it('serializes to a compact string and omits the default set', () => {
    expect(serializeColumns(['roas', 'clicks'])).toBe('roas,clicks');
    expect(serializeColumns(DEFAULT_PERFORMANCE_COLUMNS)).toBeUndefined();
    expect(serializeColumns([])).toBeUndefined();
    const custom = ['visits', 'net_profit_minor'] as const;
    expect(parseColumns(serializeColumns(custom))).toEqual(custom);
  });

  it('toggles columns in the canonical order', () => {
    expect(toggleColumn(['roas'], 'clicks')).toEqual(['clicks', 'roas']);
    expect(toggleColumn(['clicks', 'roas'], 'clicks')).toEqual(['roas']);
  });
});

describe('performance search → options', () => {
  it('keeps only valid keys', () => {
    expect(
      parsePerformanceSearch({
        am: 'u_shaped',
        win: 15,
        basis: 'sale_date',
        group: 'nope',
        dd: ['platform:meta', 'bogus:x', 7],
        cols: 'roas,zzz',
        view: 'chart',
        cmp: 1,
        metric: 'cost_minor',
      }),
    ).toEqual({
      am: 'u_shaped',
      win: 15,
      basis: 'sale_date',
      dd: ['platform:meta'],
      cols: 'roas',
      view: 'chart',
      cmp: '1',
      metric: 'cost_minor',
    });
    expect(parsePerformanceSearch({ am: 'last_touch', win: 31, view: 'grid' })).toEqual({});
    expect(parsePerformanceSearch({ win: '5' })).toEqual({ win: 5 });
  });

  it('merges with the shared analytics keys', () => {
    const search = validatePerformanceSearch({ site: 's1', range: '7d', am: 'linear', f: 'x' });
    expect(search).toMatchObject({ site: 's1', range: '7d', am: 'linear' });
  });

  it('defaults to last click by platform, table view, default columns', () => {
    const o = resolvePerformance({});
    expect(o).toMatchObject({
      model: 'last_click',
      windowDays: 7,
      basis: 'click_date',
      groupBy: 'platform',
      view: 'table',
      compare: false,
      chartMetric: 'revenue_minor',
    });
    expect(o.columns).toEqual(DEFAULT_PERFORMANCE_COLUMNS);
  });

  it('drills down platform → campaign → adset → ad', () => {
    expect(childDimension('platform')).toBe('campaign');
    expect(childDimension('adset')).toBe('ad');
    expect(childDimension('ad')).toBeNull();
    expect(childDimension('source')).toBeNull();
    const dd = drillInto([], 'platform', 'meta');
    expect(dd).toEqual(['platform:meta']);
    const o = resolvePerformance({ dd: drillInto(resolvePerformance({ dd }).drill, 'campaign', 'c:1') });
    expect(o.drill).toEqual([
      { dimension: 'platform', value: 'meta' },
      { dimension: 'campaign', value: 'c:1' },
    ]);
    expect(o.groupBy).toBe('adset');
    expect(resolvePerformance({ dd: drillInto([], 'campaign', null) }).drill).toEqual([
      { dimension: 'campaign', value: '' },
    ]);
  });
});

describe('performance query params', () => {
  it('maps model, basis, grouping and drill-down filters', () => {
    const options = resolvePerformance({
      am: 'first_click',
      basis: 'sale_date',
      dd: ['platform:meta', 'campaign:'],
    });
    const qs = new URLSearchParams(
      performanceQueryString(performanceRequest('site_1', { ...range, timezone: 'Europe/Rome' }, options)),
    );
    expect(Object.fromEntries(qs)).toEqual({
      site_id: 'site_1',
      from: '2026-10-01',
      to: '2026-10-30',
      timezone: 'Europe/Rome',
      model: 'first_click',
      group_by: 'adset',
      basis: 'sale_date',
      filter_platform: 'meta',
      filter_campaign: '',
    });
  });

  it('sends window_days only with windowed_hybrid', () => {
    const hybrid = resolvePerformance({ am: 'windowed_hybrid', win: 10 });
    expect(new URLSearchParams(performanceQueryString(performanceRequest('s', range, hybrid))).get('window_days')).toBe('10');
    const linear = resolvePerformance({ am: 'linear', win: 10 });
    expect(new URLSearchParams(performanceQueryString(performanceRequest('s', range, linear))).has('window_days')).toBe(false);
  });

  it('repeats a filter dimension', () => {
    const qs = performanceQueryString({
      site_id: 's',
      ...range,
      model: 'last_click',
      group_by: 'ad',
      basis: 'click_date',
      filters: [
        { dimension: 'campaign', value: 'a' },
        { dimension: 'campaign', value: 'b' },
      ],
    });
    expect(new URLSearchParams(qs).getAll('filter_campaign')).toEqual(['a', 'b']);
  });
});

describe('metric formatting', () => {
  const f = createFormatters('en');

  it('formats money, ratios, percents and nulls', () => {
    expect(formatMetric(f, 'cost_minor', 10_000, 'EUR')).toBe('€100.00');
    expect(formatMetric(f, 'revenue_minor', 1234.6, 'EUR')).toBe('€12.35');
    expect(formatMetric(f, 'roas', 2.505, 'EUR')).toBe('2.51×');
    expect(formatMetric(f, 'roi', 1.505, 'EUR')).toBe('150.5%');
    expect(formatMetric(f, 'sales', 2.5, 'EUR')).toBe('2.5');
    expect(formatMetric(f, 'clicks', 1200, 'EUR')).toBe('1,200');
    expect(formatMetric(f, 'roas', null, 'EUR')).toBe('—');
    expect(formatMetric(f, 'cost_minor', 500, 'JPY')).toBe('¥500');
  });

  it('colors reported vs actual and period changes', () => {
    expect(reportedDeltaTone(-4950)).toBe('negative');
    expect(reportedDeltaTone(10)).toBe('positive');
    expect(reportedDeltaTone(null)).toBe('neutral');
    expect(changeTone('revenue_minor', 0.2)).toBe('positive');
    expect(changeTone('cost_minor', 0.2)).toBe('negative');
    expect(changeTone('cpa_minor', -0.1)).toBe('positive');
    expect(changeTone('clicks', null)).toBe('neutral');
  });

  it('computes changes only against a baseline', () => {
    expect(metricChange(150, 100)).toBeCloseTo(0.5);
    expect(metricChange(-50, -100)).toBeCloseTo(0.5);
    expect(metricChange(10, 0)).toBeNull();
    expect(metricChange(null, 10)).toBeNull();
    expect(metricChange(10, undefined)).toBeNull();
  });

  it('shades cohort ROI', () => {
    expect(roiHeat(null)).toEqual({ tone: 'neutral', intensity: 0 });
    expect(roiHeat(0.5)).toEqual({ tone: 'positive', intensity: 0.5 });
    expect(roiHeat(-3)).toEqual({ tone: 'negative', intensity: 1 });
  });

  it('labels the empty journey step', () => {
    expect(journeyStepLabel('', '(none)')).toBe('(none)');
    expect(journeyStepLabel('Meta', '(none)')).toBe('Meta');
  });
});

describe('CSV export', () => {
  it('escapes quotes, separators and formula prefixes', () => {
    expect(toCsv([['a,b', 'say "hi"', null, 3], ['=SUM(A1)', '-x', -2, 'ok']])).toBe(
      '"a,b","say ""hi""",,3\r\n\'=SUM(A1),\'-x,-2,ok',
    );
  });

  it('writes money in major units with the currency digits', () => {
    expect(csvValue('cost_minor', 12_345, 'EUR')).toBe(123.45);
    expect(csvValue('cost_minor', 500, 'JPY')).toBe(500);
    expect(csvValue('roas', 2.505555, 'EUR')).toBe(2.5056);
    expect(csvValue('roas', null, 'EUR')).toBeNull();
  });

  it('builds rows, unattributed label and totals', () => {
    const csv = performanceCsv(
      {
        currency: 'EUR',
        rows: [row(), row({ key: null, label: null, roas: null, cost_minor: 0 })],
        totals: row({ key: null, label: null }),
      },
      ['cost_minor', 'roas'],
      {
        dimension: 'Platform',
        column: (c) => (c === 'cost_minor' ? 'Spend' : 'ROAS'),
        unattributed: '(unattributed)',
        total: 'Total',
      },
    );
    expect(csv.split('\r\n')).toEqual([
      'Platform,Spend,ROAS',
      'Meta,100,2.505',
      '(unattributed),0,',
      'Total,100,2.505',
    ]);
  });
});

describe('other report search params', () => {
  it('validates LTV, cohort and journey keys', () => {
    expect(validateLtvSearch({ group: 'campaign', lm: 'last_click', x: 1 })).toEqual({
      group: 'campaign',
      lm: 'last_click',
    });
    expect(validateLtvSearch({ group: 'ad', lm: 'linear' })).toEqual({});
    expect(validateCohortSearch({ gran: 'week', platform: 'tiktok' })).toEqual({
      gran: 'week',
      platform: 'tiktok',
    });
    expect(validateCohortSearch({ gran: 'day', platform: 'myspace' })).toEqual({});
    expect(validateJourneySearch({ step: 'node', conv: 1 })).toEqual({ step: 'node', conv: '1' });
    expect(validateJourneySearch({ step: 'ad', conv: '0' })).toEqual({});
  });
});
