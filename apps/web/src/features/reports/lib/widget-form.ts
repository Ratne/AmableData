import type {
  ChartType,
  CompareMode,
  DashboardWidget,
  DatePreset,
  ReportOverrides,
} from '@amable/api-types/reports';
import { DEFAULT_SIZE, freeSlot, widgetId } from './layout';

/** Editable fields of a dashboard widget (empty strings = keep the report's own setting). */
export interface WidgetFormState {
  readonly type: ChartType;
  readonly reportId: string;
  readonly title: string;
  readonly measures: readonly string[];
  readonly preset: DatePreset | '';
  readonly compare: CompareMode | '';
  readonly limit: string;
}

export function widgetFormFrom(widget: DashboardWidget | null, reportId = ''): WidgetFormState {
  if (widget === null)
    return { type: 'kpi', reportId, title: '', measures: [], preset: '', compare: '', limit: '' };
  return {
    type: widget.type,
    reportId: widget.report_id,
    title: widget.title ?? '',
    measures: widget.measures ?? [],
    preset: widget.overrides?.date_range?.preset ?? '',
    compare: widget.overrides?.compare ?? '',
    limit: widget.overrides?.limit === undefined ? '' : String(widget.overrides.limit),
  };
}

/**
 * Widget of the form. Overrides that the form does not edit (dimension,
 * params, …) are kept; a new widget gets an id and the first free slot of
 * its type's default size.
 */
export function widgetFromForm(
  form: WidgetFormState,
  existing: DashboardWidget | null,
  others: readonly DashboardWidget[],
): DashboardWidget {
  const overrides: ReportOverrides = { ...(existing?.overrides ?? {}) };
  delete overrides.date_range;
  delete overrides.compare;
  delete overrides.limit;
  if (form.preset !== '') overrides.date_range = { preset: form.preset };
  if (form.compare !== '') overrides.compare = form.compare;
  const limit = Number.parseInt(form.limit, 10);
  if (Number.isFinite(limit) && limit >= 1) overrides.limit = Math.min(500, limit);
  // KPIs read the totals only; charts go back to the report's grouping.
  if (form.type === 'kpi' && overrides.dimension === undefined) overrides.dimension = null;
  if (form.type !== 'kpi' && existing?.type === 'kpi' && overrides.dimension === null)
    delete overrides.dimension;
  const title = form.title.trim();
  return {
    id: existing?.id ?? widgetId(others, form.type),
    type: form.type,
    title: title === '' ? null : title,
    report_id: form.reportId,
    ...(form.measures.length > 0 ? { measures: form.measures.slice(0, 8) } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    layout: existing?.layout ?? freeSlot(others, DEFAULT_SIZE[form.type]),
  };
}
