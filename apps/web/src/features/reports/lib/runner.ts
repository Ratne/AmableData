import type { FilterGroup } from '@amable/api-types/crm';
import type {
  ChartType,
  CompareMode,
  DatePreset,
  Granularity,
  ReportCatalogEntry,
  ReportOverrides,
} from '@amable/api-types/reports';
import {
  fromFilterGroup,
  toFilterGroup,
  type FieldKinds,
  type UiGroup,
} from '../../search/query-model';

/** Toolbar state of the report runner page and its mapping to run / export overrides. */

export interface RunnerState {
  readonly preset: DatePreset | 'custom';
  readonly from: string;
  readonly to: string;
  readonly compare: CompareMode;
  readonly granularity: Granularity;
  readonly dimension: string | null;
  readonly params: Readonly<Record<string, string>>;
  readonly chart: ChartType;
  readonly filter: UiGroup;
}

export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function runnerFromEntry(entry: ReportCatalogEntry): RunnerState {
  const d = entry.definition;
  return {
    preset: d.date_range.preset ?? 'custom',
    from: d.date_range.from ?? '',
    to: d.date_range.to ?? '',
    compare: d.compare,
    granularity: d.granularity,
    dimension: d.dimension,
    params: { ...(d.params ?? {}) },
    chart: entry.chart,
    filter: fromFilterGroup(d.filter),
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Overrides of the run (and of the CSV export, so the file matches the
 * screen). Incomplete custom ranges keep the stored range.
 */
export function runnerOverrides(
  state: RunnerState,
  kinds: FieldKinds,
  options: { filterable: boolean; timezone?: string },
): ReportOverrides {
  const params = Object.fromEntries(Object.entries(state.params).filter(([, v]) => v !== ''));
  let filter: FilterGroup | undefined;
  if (options.filterable)
    filter = toFilterGroup(state.filter, kinds) ?? { type: 'group', op: 'and', conditions: [] };
  const range =
    state.preset !== 'custom'
      ? { preset: state.preset }
      : ISO_DAY.test(state.from) && ISO_DAY.test(state.to) && state.from <= state.to
        ? { from: state.from, to: state.to }
        : undefined;
  return {
    ...(range === undefined ? {} : { date_range: range }),
    compare: state.compare,
    granularity: state.granularity,
    dimension: state.dimension,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(filter === undefined ? {} : { filter }),
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
  };
}
