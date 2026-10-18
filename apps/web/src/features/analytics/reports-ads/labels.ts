import {
  AD_PLATFORMS,
  type AttributionModelV2,
  type PerformanceGroupBy,
  type PerformanceRow,
} from '@amable/api-types';
import type { Translate as T } from '../lib/labels';
import type { PerformanceColumn } from './model';

export const modelLabel = (t: T, model: AttributionModelV2) =>
  t(`analytics.performance.model.${model}`);

export const modelHint = (t: T, model: AttributionModelV2) =>
  t(`analytics.performance.modelHint.${model}`);

export const groupLabel = (t: T, group: PerformanceGroupBy) =>
  t(`analytics.performance.group.${group}`);

export const columnLabel = (t: T, column: PerformanceColumn) =>
  t(`analytics.performance.col.${column}`);

export function platformLabel(t: T, value: string): string {
  return (AD_PLATFORMS as readonly string[]).includes(value)
    ? t(`analytics.performance.platform.${value as (typeof AD_PLATFORMS)[number]}`)
    : value;
}

/** Name of a report row: platform names translated, null key = unattributed, '' = none. */
export function rowLabel(
  t: T,
  groupBy: PerformanceGroupBy,
  row: Pick<PerformanceRow, 'key' | 'label'>,
): string {
  if (row.key === null) return t('analytics.performance.unattributed');
  if (row.key === '') return t('analytics.performance.none');
  if (groupBy === 'platform') return platformLabel(t, row.key);
  return row.label ?? row.key;
}
