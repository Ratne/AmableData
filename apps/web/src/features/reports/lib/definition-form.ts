import type { FilterGroup } from '@amable/api-types/crm';
import {
  createCustomReportSchema,
  REPORT_SOURCE_SPECS,
  type ChartType,
  type CompareMode,
  type CreateCustomReportInput,
  type CustomReport,
  type DatePreset,
  type Granularity,
  type ReportCatalogEntry,
  type ReportDefinition,
  type ReportSource,
  type ReportSourceSpec,
} from '@amable/api-types/reports';
import {
  emptyGroup,
  fromFilterGroup,
  toFilterGroup,
  type FieldKinds,
  type UiGroup,
} from '../../search/query-model';

/**
 * State of the custom report builder form and its mapping to the REST
 * payload (`POST|PATCH /customReports`). Kept free of React so the mapping
 * is unit tested.
 */

export const MAX_MEASURES = 8;

export interface ReportFormState {
  readonly name: string;
  readonly description: string;
  readonly chart: ChartType;
  readonly shared: boolean;
  readonly source: ReportSource;
  readonly measures: readonly string[];
  readonly dimension: string | null;
  readonly granularity: Granularity;
  readonly preset: DatePreset | 'custom';
  readonly from: string;
  readonly to: string;
  readonly compare: CompareMode;
  readonly currency: string;
  readonly limit: number;
  readonly params: Readonly<Record<string, string>>;
  readonly filter: UiGroup;
}

export function specOf(source: ReportSource): ReportSourceSpec {
  return REPORT_SOURCE_SPECS[source];
}

export function emptyForm(source: ReportSource = 'orders'): ReportFormState {
  const spec = specOf(source);
  const measures = Object.keys(spec.measures).slice(0, 1);
  return {
    name: '',
    description: '',
    chart: spec.dimensions.includes('date') ? 'line' : 'table',
    shared: true,
    source,
    measures,
    dimension: spec.dimensions[0] ?? null,
    granularity: 'month',
    preset: 'last_12_months',
    from: '',
    to: '',
    compare: 'none',
    currency: '',
    limit: 100,
    params: {},
    filter: emptyGroup(),
  };
}

/** Switches the source, keeping the measures / dimension / params the new source supports. */
export function changeSource(state: ReportFormState, source: ReportSource): ReportFormState {
  const spec = specOf(source);
  const measures = state.measures.filter((m) => m in spec.measures);
  const allowed = new Set(spec.params ?? []);
  return {
    ...state,
    source,
    measures: measures.length > 0 ? measures : Object.keys(spec.measures).slice(0, 1),
    dimension:
      state.dimension !== null && spec.dimensions.includes(state.dimension)
        ? state.dimension
        : (spec.dimensions[0] ?? null),
    params: Object.fromEntries(Object.entries(state.params).filter(([k]) => allowed.has(k))),
    filter: spec.filter === specOf(state.source).filter ? state.filter : emptyGroup(),
  };
}

export function toggleMeasure(state: ReportFormState, measure: string): ReportFormState {
  if (state.measures.includes(measure))
    return { ...state, measures: state.measures.filter((m) => m !== measure) };
  if (state.measures.length >= MAX_MEASURES) return state;
  const order = Object.keys(specOf(state.source).measures);
  const measures = [...state.measures, measure].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ...state, measures };
}

export type FormIssue = 'name' | 'measures' | 'range';

export function validateForm(state: ReportFormState): FormIssue[] {
  const issues: FormIssue[] = [];
  if (state.name.trim() === '') issues.push('name');
  if (state.measures.length === 0) issues.push('measures');
  if (
    state.preset === 'custom' &&
    !(/^\d{4}-\d{2}-\d{2}$/.test(state.from) && /^\d{4}-\d{2}-\d{2}$/.test(state.to))
  )
    issues.push('range');
  return issues;
}

/** Definition of the form (also the body of the builder preview `POST /reports/run`). */
export function formToDefinition(state: ReportFormState, kinds: FieldKinds): ReportDefinition {
  const spec = specOf(state.source);
  const filter: FilterGroup | undefined =
    spec.filter === null ? undefined : toFilterGroup(state.filter, kinds);
  const params = Object.fromEntries(
    Object.entries(state.params).filter(
      ([key, value]) => (spec.params ?? []).includes(key) && value.trim() !== '',
    ),
  );
  const currency = state.currency.trim().toUpperCase();
  return {
    source: state.source,
    measures: state.measures.filter((m) => m in spec.measures).slice(0, MAX_MEASURES),
    dimension:
      state.dimension !== null && spec.dimensions.includes(state.dimension)
        ? state.dimension
        : null,
    granularity: state.granularity,
    ...(filter === undefined ? {} : { filter }),
    date_range:
      state.preset === 'custom' ? { from: state.from, to: state.to } : { preset: state.preset },
    compare: state.compare,
    ...(spec.currency && /^[A-Z]{3}$/.test(currency) ? { currency } : {}),
    limit: Math.min(500, Math.max(1, Math.round(state.limit) || 100)),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/** Body of `POST /customReports` (also valid for PATCH), validated against the API schema. */
export function formToPayload(state: ReportFormState, kinds: FieldKinds): CreateCustomReportInput {
  const description = state.description.trim();
  const payload: CreateCustomReportInput = {
    name: state.name.trim(),
    description: description === '' ? null : description,
    definition: formToDefinition(state, kinds),
    chart: state.chart,
    shared: state.shared,
  };
  createCustomReportSchema.parse(payload);
  return payload;
}

/** Form of a stored report (custom, or a built-in used as a template). */
export function formFromReport(
  report: Pick<CustomReport, 'name' | 'description' | 'definition' | 'chart'> & {
    shared?: boolean;
  },
): ReportFormState {
  const d = report.definition;
  const custom = d.date_range.preset === undefined;
  return {
    name: report.name,
    description: report.description ?? '',
    chart: report.chart,
    shared: report.shared ?? true,
    source: d.source,
    measures: [...d.measures],
    dimension: d.dimension,
    granularity: d.granularity,
    preset: d.date_range.preset ?? 'custom',
    from: custom ? (d.date_range.from ?? '') : '',
    to: custom ? (d.date_range.to ?? '') : '',
    compare: d.compare,
    currency: d.currency ?? '',
    limit: d.limit,
    params: { ...(d.params ?? {}) },
    filter: fromFilterGroup(d.filter),
  };
}

export function formFromCatalogEntry(entry: ReportCatalogEntry): ReportFormState {
  return formFromReport({
    name: entry.name,
    description: entry.description,
    definition: entry.definition,
    chart: entry.chart,
    shared: entry.shared ?? true,
  });
}
