import {
  ANALYTICS_FILTER_DIMENSIONS,
  ANALYTICS_INTERVALS,
  ATTRIBUTION_MODELS,
  type AnalyticsFilter,
  type AnalyticsFilterDimension,
  type AnalyticsInterval,
  type AttributionModel,
  type Site,
} from '@amable/api-types';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSites, type AnalyticsQuery, type AnalyticsSource } from '../api';
import {
  allowedIntervals,
  defaultInterval,
  DEFAULT_PRESET,
  isRangePreset,
  isYmd,
  resolveRange,
  type DayRange,
  type RangePreset,
} from './range';

/**
 * Site, range, interval, attribution model and filters of the analytics pages,
 * kept in the URL search params so every view is a shareable link:
 * `?site=…&range=30d&interval=day&model=linear&f=["country:is:IT"]`.
 */
export interface AnalyticsSearch {
  readonly site?: string;
  readonly range?: RangePreset;
  readonly from?: string;
  readonly to?: string;
  readonly interval?: AnalyticsInterval;
  readonly model?: AttributionModel;
  /** Filters as `dimension:op:value`. */
  readonly f?: readonly string[];
}

const OPS = ['is', 'is_not', 'contains'] as const;

export function isFilterDimension(value: string): value is AnalyticsFilterDimension {
  return (ANALYTICS_FILTER_DIMENSIONS as readonly string[]).includes(value);
}

export function encodeFilter(filter: AnalyticsFilter): string {
  return `${filter.dimension}:${filter.op}:${filter.value}`;
}

export function decodeFilter(raw: string): AnalyticsFilter | null {
  const first = raw.indexOf(':');
  const second = first < 0 ? -1 : raw.indexOf(':', first + 1);
  if (second < 0) return null;
  const dimension = raw.slice(0, first);
  const op = raw.slice(first + 1, second);
  const value = raw.slice(second + 1);
  if (!isFilterDimension(dimension) || !(OPS as readonly string[]).includes(op)) return null;
  return { dimension, op: op as AnalyticsFilter['op'], value };
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const out = value.filter((item): item is string => typeof item === 'string');
    return out.length > 0 ? out.slice(0, 20) : undefined;
  }
  return undefined;
}

export function validateAnalyticsSearch(raw: Record<string, unknown>): AnalyticsSearch {
  const site = raw['site'] ?? raw['site_id'];
  const interval = raw['interval'];
  const model = raw['model'];
  const f = stringList(raw['f']);
  return {
    ...(typeof site === 'string' && site ? { site } : {}),
    ...(isRangePreset(raw['range']) ? { range: raw['range'] } : {}),
    ...(isYmd(raw['from']) ? { from: raw['from'] } : {}),
    ...(isYmd(raw['to']) ? { to: raw['to'] } : {}),
    ...(typeof interval === 'string' &&
    (ANALYTICS_INTERVALS as readonly string[]).includes(interval)
      ? { interval: interval as AnalyticsInterval }
      : {}),
    ...(typeof model === 'string' && (ATTRIBUTION_MODELS as readonly string[]).includes(model)
      ? { model: model as AttributionModel }
      : {}),
    ...(f ? { f } : {}),
  };
}

export interface DerivedQuery {
  readonly preset: RangePreset;
  readonly range: DayRange;
  readonly interval: AnalyticsInterval;
  readonly intervals: AnalyticsInterval[];
  readonly filters: AnalyticsFilter[];
  readonly query: AnalyticsQuery;
}

export function deriveQuery(search: AnalyticsSearch, timezone: string | undefined): DerivedQuery {
  const preset = search.range ?? DEFAULT_PRESET;
  const range = resolveRange(preset, timezone, { from: search.from, to: search.to });
  const intervals = allowedIntervals(range);
  const interval =
    search.interval && intervals.includes(search.interval)
      ? search.interval
      : defaultInterval(range);
  const filters = (search.f ?? [])
    .map(decodeFilter)
    .filter((f): f is AnalyticsFilter => f !== null);
  return {
    preset,
    range,
    interval,
    intervals,
    filters,
    query: { from: range.from, to: range.to, timezone, filters },
  };
}

export interface QueryControls extends DerivedQuery {
  readonly search: AnalyticsSearch;
  readonly model: AttributionModel;
  readonly update: (patch: Partial<AnalyticsSearch>) => void;
  readonly addFilter: (filter: AnalyticsFilter) => void;
  readonly removeFilter: (index: number) => void;
  readonly setFilters: (filters: readonly AnalyticsFilter[]) => void;
}

function withFilter(
  current: readonly AnalyticsFilter[],
  filter: AnalyticsFilter,
): AnalyticsFilter[] {
  const others = current.filter(
    (existing) => !(existing.dimension === filter.dimension && existing.op === filter.op),
  );
  return [...others, filter].slice(-20);
}

function useControls(
  search: AnalyticsSearch,
  timezone: string | undefined,
  defaultModel: AttributionModel,
  apply: (patch: Partial<AnalyticsSearch>) => void,
): QueryControls {
  const derived = useMemo(() => deriveQuery(search, timezone), [search, timezone]);
  const setFilters = useCallback(
    (filters: readonly AnalyticsFilter[]) =>
      apply({ f: filters.length > 0 ? filters.map(encodeFilter) : undefined }),
    [apply],
  );
  return {
    ...derived,
    search,
    model: search.model ?? defaultModel,
    update: apply,
    setFilters,
    addFilter: (filter) => setFilters(withFilter(derived.filters, filter)),
    removeFilter: (index) => setFilters(derived.filters.filter((_, i) => i !== index)),
  };
}

const siteStorageKey = (tenant: string) => `amable.analytics.site.${tenant}`;

function readStoredSite(tenant: string): string | null {
  try {
    return localStorage.getItem(siteStorageKey(tenant));
  } catch {
    return null;
  }
}

export interface AnalyticsState extends QueryControls {
  readonly tenant: string;
  readonly sites: ReturnType<typeof useSites>;
  readonly site: Site | null;
  readonly source: AnalyticsSource | null;
  /** Search params to carry when linking to another analytics page. */
  readonly linkSearch: AnalyticsSearch;
}

/** URL-backed query state of the workspace analytics pages. */
export function useAnalyticsQueryState(tenant: string): AnalyticsState {
  const raw: Record<string, unknown> = useSearch({ strict: false });
  const search = useMemo(() => validateAnalyticsSearch(raw), [raw]);
  const navigate = useNavigate();
  const sites = useSites(tenant);

  const site = useMemo(() => {
    const list = sites.data ?? [];
    const wanted = search.site ?? readStoredSite(tenant);
    return list.find((candidate) => candidate.id === wanted) ?? list[0] ?? null;
  }, [sites.data, search.site, tenant]);

  useEffect(() => {
    if (!site) return;
    try {
      localStorage.setItem(siteStorageKey(tenant), site.id);
    } catch {
      // Storage disabled: the URL still carries the site.
    }
  }, [site, tenant]);

  const apply = useCallback(
    (patch: Partial<AnalyticsSearch>) => {
      void navigate({
        to: '.',
        replace: true,
        search: (previous: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
          return next;
        },
      } as never);
    },
    [navigate],
  );

  const controls = useControls(
    search,
    site?.timezone,
    site?.attribution_model ?? 'last_non_direct',
    apply,
  );
  const source = useMemo<AnalyticsSource | null>(
    () => (site ? { kind: 'tenant', tenant, siteId: site.id } : null),
    [site, tenant],
  );
  const linkSearch = useMemo<AnalyticsSearch>(
    () => ({ ...search, ...(site ? { site: site.id } : {}) }),
    [search, site],
  );
  return { ...controls, tenant, sites, site, source, linkSearch };
}

/** In-memory query state of the public share page (no URL, no site picker). */
export function usePublicQueryState(timezone: string | undefined): QueryControls {
  const [search, setSearch] = useState<AnalyticsSearch>({ range: '7d' });
  const apply = useCallback(
    (patch: Partial<AnalyticsSearch>) => setSearch((previous) => ({ ...previous, ...patch })),
    [],
  );
  return useControls(search, timezone, 'last_non_direct', apply);
}
