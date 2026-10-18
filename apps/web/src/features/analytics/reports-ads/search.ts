import { AD_PLATFORMS, type AdPlatform } from '@amable/api-types';
import { validateAnalyticsSearch, type AnalyticsSearch } from '../lib/query-state';
import { searchString } from '../lib/search';
import { parsePerformanceSearch, type PerformanceSearchParams } from './model';

/* Search params of the ads report pages (site / range keys shared with the other analytics pages). */

export interface PerformanceSearch extends AnalyticsSearch, PerformanceSearchParams {}

export const LTV_GROUPS = ['source', 'campaign', 'platform'] as const;
export const LTV_MODELS = ['first_click', 'last_click'] as const;
export type LtvGroup = (typeof LTV_GROUPS)[number];

export interface LtvSearch extends AnalyticsSearch {
  readonly group?: LtvGroup;
  readonly lm?: (typeof LTV_MODELS)[number];
}

export const COHORT_GRANULARITIES = ['month', 'week'] as const;

export interface CohortSearch extends AnalyticsSearch {
  readonly gran?: (typeof COHORT_GRANULARITIES)[number];
  readonly platform?: AdPlatform;
}

export const JOURNEY_STEPS = ['source', 'campaign', 'node'] as const;

export interface JourneySearch extends AnalyticsSearch {
  readonly step?: (typeof JOURNEY_STEPS)[number];
  /** `1` = only journeys ending in a conversion. */
  readonly conv?: '1';
}

const pick = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function validatePerformanceSearch(raw: Record<string, unknown>): PerformanceSearch {
  return { ...validateAnalyticsSearch(raw), ...parsePerformanceSearch(raw) };
}

export function validateLtvSearch(raw: Record<string, unknown>): LtvSearch {
  return compact({
    ...validateAnalyticsSearch(raw),
    group: pick(LTV_GROUPS, raw['group']),
    lm: pick(LTV_MODELS, raw['lm']),
  });
}

export function validateCohortSearch(raw: Record<string, unknown>): CohortSearch {
  return compact({
    ...validateAnalyticsSearch(raw),
    gran: pick(COHORT_GRANULARITIES, raw['gran']),
    platform: pick(AD_PLATFORMS, raw['platform']),
  });
}

export function validateJourneySearch(raw: Record<string, unknown>): JourneySearch {
  return compact({
    ...validateAnalyticsSearch(raw),
    step: pick(JOURNEY_STEPS, raw['step']),
    conv: searchString(raw['conv']) === '1' ? ('1' as const) : undefined,
  });
}
