import {
  ATTRIBUTION_MODELS_V2,
  DEFAULT_ATTRIBUTION_MODEL_V2,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  PERFORMANCE_GROUP_BY,
  REPORT_BASIS,
  type AttributionModelV2,
  type PerformanceFilter,
  type PerformanceGroupBy,
  type PerformanceReport,
  type PerformanceRow,
  type ReportBasis,
} from '@amable/api-types';
import { currencyDigits, type Formatters } from '../lib/format';
import { searchString } from '../lib/search';

/*
 * Pure state of the ads reports: columns and models of the performance
 * report, their search-param encoding, the query params sent to
 * `/ads-reports/*`, CSV export and metric formatting.
 */

// ---------------------------------------------------------------- columns

export type MetricFormat = 'int' | 'number' | 'money' | 'ratio' | 'percent';

/** Metric columns of the performance report and how their values read. */
export const PERFORMANCE_COLUMNS = {
  visits: 'int',
  clicks: 'int',
  cost_minor: 'money',
  revenue_minor: 'money',
  total_revenue_minor: 'money',
  profit_minor: 'money',
  net_profit_minor: 'money',
  roas: 'ratio',
  roi: 'percent',
  sales: 'number',
  leads: 'number',
  new_leads: 'number',
  returning_customers: 'number',
  aov_minor: 'money',
  cpa_minor: 'money',
  cvr: 'percent',
  reported_conversions: 'number',
  reported_revenue_minor: 'money',
  reported_vs_revenue_minor: 'money',
} as const satisfies Partial<Record<keyof PerformanceRow, MetricFormat>>;

export type PerformanceColumn = keyof typeof PERFORMANCE_COLUMNS;
export const PERFORMANCE_COLUMN_IDS = Object.keys(PERFORMANCE_COLUMNS) as PerformanceColumn[];

export const DEFAULT_PERFORMANCE_COLUMNS: readonly PerformanceColumn[] = [
  'clicks',
  'cost_minor',
  'revenue_minor',
  'roas',
  'sales',
  'cpa_minor',
  'reported_revenue_minor',
  'reported_vs_revenue_minor',
];

/** Columns where a higher value is worse (colored red when rising). */
export const LOWER_IS_BETTER: ReadonlySet<PerformanceColumn> = new Set(['cost_minor', 'cpa_minor']);

export function isPerformanceColumn(value: unknown): value is PerformanceColumn {
  return typeof value === 'string' && value in PERFORMANCE_COLUMNS;
}

/** `cols` search param (`a,b,c` or a list) → valid, unique columns; undefined when none. */
export function parseColumns(raw: unknown): PerformanceColumn[] | undefined {
  const parts =
    typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : ([] as unknown[]);
  const out: PerformanceColumn[] = [];
  for (const part of parts) {
    const id = typeof part === 'string' ? part.trim() : part;
    if (isPerformanceColumn(id) && !out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : undefined;
}

/** Columns → `cols` search param; undefined for the default set (clean URLs). */
export function serializeColumns(columns: readonly PerformanceColumn[]): string | undefined {
  const valid = parseColumns([...columns]) ?? [];
  if (valid.length === 0) return undefined;
  const same =
    valid.length === DEFAULT_PERFORMANCE_COLUMNS.length &&
    valid.every((c, i) => c === DEFAULT_PERFORMANCE_COLUMNS[i]);
  return same ? undefined : valid.join(',');
}

/** Toggles a column, keeping the canonical order of `PERFORMANCE_COLUMN_IDS`. */
export function toggleColumn(
  columns: readonly PerformanceColumn[],
  column: PerformanceColumn,
): PerformanceColumn[] {
  const next = columns.includes(column)
    ? columns.filter((c) => c !== column)
    : [...columns, column];
  return PERFORMANCE_COLUMN_IDS.filter((c) => next.includes(c));
}

// ----------------------------------------------------------------- search

/** Window presets of `windowed_hybrid` (days). */
export const WINDOW_PRESETS = [1, 5, 7, 10, 15, 30] as const;

/** Platform → campaign → adset → ad: the drill-down path of the ad entities. */
export const PERFORMANCE_HIERARCHY = ['platform', 'campaign', 'adset', 'ad'] as const;

export const PERFORMANCE_VIEWS = ['table', 'nested', 'chart'] as const;
export type PerformanceView = (typeof PERFORMANCE_VIEWS)[number];

/** Top-level groupings offered by the report (the hierarchy starts at `platform`). */
export const PERFORMANCE_TOP_GROUPS: readonly PerformanceGroupBy[] = [
  'platform',
  'source',
  'funnel',
  'node',
  'day',
  'country',
  'device',
];

/** Performance-report search params (`am` = attribution model, `dd` = drill path). */
export interface PerformanceSearchParams {
  readonly am?: AttributionModelV2;
  readonly win?: number;
  readonly basis?: ReportBasis;
  readonly group?: PerformanceGroupBy;
  /** Drill-down path as `dimension:value` (empty value = rows without one). */
  readonly dd?: readonly string[];
  readonly cols?: string;
  readonly view?: PerformanceView;
  readonly cmp?: '1';
  readonly metric?: PerformanceColumn;
}

const includes = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

export function isGroupBy(value: unknown): value is PerformanceGroupBy {
  return includes(PERFORMANCE_GROUP_BY, value);
}

export function encodeDrill(filter: PerformanceFilter): string {
  return `${filter.dimension}:${filter.value}`;
}

export function decodeDrill(raw: string): PerformanceFilter | null {
  const at = raw.indexOf(':');
  if (at < 0) return null;
  const dimension = raw.slice(0, at);
  if (!isGroupBy(dimension)) return null;
  return { dimension, value: raw.slice(at + 1).slice(0, 255) };
}

function windowDays(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(searchString(raw));
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : undefined;
}

/** Parses the performance-only keys of the search (the site/range keys are validated elsewhere). */
export function parsePerformanceSearch(raw: Record<string, unknown>): PerformanceSearchParams {
  const out: { -readonly [K in keyof PerformanceSearchParams]: PerformanceSearchParams[K] } = {};
  if (includes(ATTRIBUTION_MODELS_V2, raw['am'])) out.am = raw['am'];
  const win = windowDays(raw['win']);
  if (win !== undefined) out.win = win;
  if (includes(REPORT_BASIS, raw['basis'])) out.basis = raw['basis'];
  if (isGroupBy(raw['group'])) out.group = raw['group'];
  const dd = (Array.isArray(raw['dd']) ? raw['dd'] : typeof raw['dd'] === 'string' ? [raw['dd']] : [])
    .filter((x): x is string => typeof x === 'string' && decodeDrill(x) !== null)
    .slice(0, 10);
  if (dd.length > 0) out.dd = dd;
  const cols = parseColumns(raw['cols']);
  if (cols) out.cols = cols.join(',');
  if (includes(PERFORMANCE_VIEWS, raw['view'])) out.view = raw['view'];
  if (searchString(raw['cmp']) === '1') out.cmp = '1';
  if (isPerformanceColumn(raw['metric'])) out.metric = raw['metric'];
  return out;
}

export interface PerformanceOptions {
  readonly model: AttributionModelV2;
  readonly windowDays: number;
  readonly basis: ReportBasis;
  /** Grouping chosen at the top level. */
  readonly topGroup: PerformanceGroupBy;
  readonly drill: readonly PerformanceFilter[];
  /** Grouping of the rows shown: the child level of the last drill step. */
  readonly groupBy: PerformanceGroupBy;
  readonly columns: readonly PerformanceColumn[];
  readonly view: PerformanceView;
  readonly compare: boolean;
  readonly chartMetric: PerformanceColumn;
}

/** Next level of the ad hierarchy, or null at the leaf / outside the hierarchy. */
export function childDimension(dimension: PerformanceGroupBy): PerformanceGroupBy | null {
  const at = (PERFORMANCE_HIERARCHY as readonly string[]).indexOf(dimension);
  return at < 0 ? null : (PERFORMANCE_HIERARCHY[at + 1] ?? null);
}

export function resolvePerformance(search: PerformanceSearchParams): PerformanceOptions {
  const drill = (search.dd ?? [])
    .map(decodeDrill)
    .filter((f): f is PerformanceFilter => f !== null);
  const topGroup = search.group ?? 'platform';
  const last = drill[drill.length - 1];
  const groupBy = last ? (childDimension(last.dimension) ?? last.dimension) : topGroup;
  const columns = parseColumns(search.cols) ?? [...DEFAULT_PERFORMANCE_COLUMNS];
  return {
    model: search.am ?? DEFAULT_ATTRIBUTION_MODEL_V2,
    windowDays: search.win ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS,
    basis: search.basis ?? 'click_date',
    topGroup,
    drill,
    groupBy,
    columns,
    view: search.view ?? 'table',
    compare: search.cmp === '1',
    chartMetric: search.metric ?? (columns.includes('revenue_minor') ? 'revenue_minor' : columns[0]!),
  };
}

/** Drill path after opening `key` of a row grouped by `dimension`. */
export function drillInto(
  drill: readonly PerformanceFilter[],
  dimension: PerformanceGroupBy,
  key: string | null,
): string[] {
  return [...drill, { dimension, value: key ?? '' }].slice(-10).map(encodeDrill);
}

// ----------------------------------------------------------- query params

export type QueryValue = string | number | boolean | null | undefined;

/** Query string (without `?`) of a GET; null / undefined / '' values are skipped. */
export function queryString(
  params: Readonly<Record<string, QueryValue>>,
  filters: readonly PerformanceFilter[] = [],
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  for (const filter of filters) search.append(`filter_${filter.dimension}`, filter.value);
  return search.toString();
}

export interface ReportRange {
  readonly from: string;
  readonly to: string;
  readonly timezone?: string;
}

export interface PerformanceRequest extends ReportRange {
  readonly site_id: string;
  readonly model: AttributionModelV2;
  readonly window_days?: number;
  readonly group_by: PerformanceGroupBy;
  readonly basis: ReportBasis;
  readonly filters?: readonly PerformanceFilter[];
  readonly limit?: number;
}

/** Query string of `GET /ads-reports/performance`; `window_days` only for `windowed_hybrid`. */
export function performanceQueryString(request: PerformanceRequest): string {
  const { filters = [], ...rest } = request;
  return queryString(
    {
      site_id: rest.site_id,
      from: rest.from,
      to: rest.to,
      timezone: rest.timezone,
      model: rest.model,
      window_days: rest.model === 'windowed_hybrid' ? rest.window_days : undefined,
      group_by: rest.group_by,
      basis: rest.basis,
      limit: rest.limit,
    },
    filters,
  );
}

export function performanceRequest(
  siteId: string,
  range: ReportRange,
  options: Pick<PerformanceOptions, 'model' | 'windowDays' | 'basis' | 'groupBy' | 'drill'>,
): PerformanceRequest {
  return {
    site_id: siteId,
    from: range.from,
    to: range.to,
    ...(range.timezone ? { timezone: range.timezone } : {}),
    model: options.model,
    window_days: options.windowDays,
    group_by: options.groupBy,
    basis: options.basis,
    filters: options.drill,
  };
}

// --------------------------------------------------------------- formatting

/** Display value of a metric; '—' for null (no spend, no platform data…). */
export function formatMetric(
  f: Formatters,
  column: PerformanceColumn,
  value: number | null,
  currency: string,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (PERFORMANCE_COLUMNS[column]) {
    case 'money':
      return f.money(Math.round(value), currency);
    case 'ratio':
      return `${f.number(value, 2)}×`;
    case 'percent':
      return f.percent(value, 1);
    case 'number':
      return f.number(value, Number.isInteger(value) ? 0 : 1);
    default:
      return f.number(value);
  }
}

export type DeltaTone = 'positive' | 'negative' | 'neutral';

/** Tone of a reported-vs-actual delta (tracked revenue minus platform-reported). */
export function reportedDeltaTone(delta: number | null): DeltaTone {
  if (delta === null || delta === 0) return 'neutral';
  return delta > 0 ? 'positive' : 'negative';
}

/** Tone of a period-over-period change of a column. */
export function changeTone(column: PerformanceColumn, change: number | null): DeltaTone {
  if (change === null || Math.abs(change) < 0.0005) return 'neutral';
  return change > 0 !== LOWER_IS_BETTER.has(column) ? 'positive' : 'negative';
}

/** Rows of the previous period by key (`null` key = unattributed). */
export function rowsByKey(rows: readonly PerformanceRow[]): Map<string | null, PerformanceRow> {
  return new Map(rows.map((row) => [row.key, row]));
}

/** Relative change, null without a comparable baseline. */
export function metricChange(current: number | null, previous: number | null | undefined): number | null {
  if (current === null || previous === null || previous === undefined || previous === 0) return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return (current - previous) / Math.abs(previous);
}

// ---------------------------------------------------------------------- CSV

/** RFC 4180 CSV; text cells that a spreadsheet would run as a formula are prefixed with `'`. */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  const cell = (value: string | number | null): string => {
    if (value === null) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

/** Raw CSV value of a metric: money in major units with the currency's digits. */
export function csvValue(column: PerformanceColumn, value: number | null, currency: string): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (PERFORMANCE_COLUMNS[column] === 'money') {
    const digits = currencyDigits(currency);
    return Number((value / 10 ** digits).toFixed(digits));
  }
  return Number(value.toFixed(4));
}

export function performanceCsv(
  report: Pick<PerformanceReport, 'rows' | 'totals' | 'currency'>,
  columns: readonly PerformanceColumn[],
  labels: {
    readonly dimension: string;
    readonly column: (column: PerformanceColumn) => string;
    readonly unattributed: string;
    readonly total: string;
  },
): string {
  const line = (name: string, row: PerformanceRow) => [
    name,
    ...columns.map((c) => csvValue(c, row[c], report.currency)),
  ];
  return toCsv([
    [labels.dimension, ...columns.map(labels.column)],
    ...report.rows.map((row) => line(row.label ?? row.key ?? labels.unattributed, row)),
    line(labels.total, report.totals),
  ]);
}

/** Heatmap shade of a cohort ROI: tone by sign, intensity 0..1 (saturating at ±100%). */
export function roiHeat(roi: number | null): { tone: DeltaTone; intensity: number } {
  if (roi === null || !Number.isFinite(roi)) return { tone: 'neutral', intensity: 0 };
  const intensity = Math.min(1, Math.abs(roi));
  if (roi === 0) return { tone: 'neutral', intensity: 0 };
  return { tone: roi > 0 ? 'positive' : 'negative', intensity: Number(intensity.toFixed(3)) };
}

/** Label of a journey step; '' is the step without a value. */
export function journeyStepLabel(step: string, none: string): string {
  return step === '' ? none : step;
}
