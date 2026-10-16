import {
  CHART_TYPES,
  COMPARE_MODES,
  DATE_PRESETS,
  GRANULARITIES,
  type ChartType,
  type ReportSourceSpec,
} from '@amable/api-types/reports';
import { Input } from '@amable/ui/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@amable/ui/ui/toggle-group';
import {
  BarChart3,
  Filter as FilterIcon,
  Gauge,
  LineChart,
  Table2,
  TrendingDown,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { ChoiceSelect } from '../../crm/components/inputs';
import { Field } from '../../automations/components/form-bits';
import { dimensionLabel, dynamicLabel, optionLabel, paramLabel } from '../lib/labels';
import type { RunnerState } from '../lib/runner';

export const CHART_ICONS: Readonly<Record<ChartType, typeof Gauge>> = {
  kpi: Gauge,
  line: LineChart,
  bar: BarChart3,
  table: Table2,
  funnel: TrendingDown,
};

const NO_GROUPING = '__none';

export interface ReportToolbarProps {
  readonly state: RunnerState;
  readonly onChange: (next: RunnerState) => void;
  readonly spec: ReportSourceSpec;
  /** Choices of the source parameters (from the last result). */
  readonly options: Readonly<Record<string, ReadonlyArray<{ value: string; label: string }>>>;
  readonly filterCount: number;
  readonly filtersOpen: boolean;
  readonly onToggleFilters: () => void;
  readonly actions?: ReactNode;
}

export function ReportToolbar({
  state,
  onChange,
  spec,
  options,
  filterCount,
  filtersOpen,
  onToggleFilters,
  actions,
}: ReportToolbarProps) {
  const { t } = useI18n();
  const set = (patch: Partial<RunnerState>) => onChange({ ...state, ...patch });
  const presets = [...DATE_PRESETS, 'custom' as const].map((value) => ({
    value,
    label: dynamicLabel(t, `rep.preset.${value}`, value),
  }));
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="report-toolbar">
      {spec.snapshot !== true ? (
        <>
          <Field label={t('rep.toolbar.range')}>
            <ChoiceSelect
              value={state.preset}
              onChange={(value) => set({ preset: value as RunnerState['preset'] })}
              choices={presets}
              allowEmpty={false}
              ariaLabel={t('rep.toolbar.range')}
            />
          </Field>
          {state.preset === 'custom' ? (
            <>
              <Field label={t('rep.toolbar.from')}>
                <Input
                  type="date"
                  className="h-8 w-36"
                  value={state.from}
                  onChange={(e) => set({ from: e.target.value })}
                />
              </Field>
              <Field label={t('rep.toolbar.to')}>
                <Input
                  type="date"
                  className="h-8 w-36"
                  value={state.to}
                  onChange={(e) => set({ to: e.target.value })}
                />
              </Field>
            </>
          ) : null}
          <Field label={t('rep.toolbar.compare')}>
            <ChoiceSelect
              value={state.compare}
              onChange={(value) => set({ compare: value as RunnerState['compare'] })}
              choices={COMPARE_MODES.map((value) => ({
                value,
                label: dynamicLabel(t, `rep.compare.${value}`, value),
              }))}
              allowEmpty={false}
              ariaLabel={t('rep.toolbar.compare')}
            />
          </Field>
        </>
      ) : null}
      <Field label={t('rep.toolbar.groupBy')}>
        <ChoiceSelect
          value={state.dimension ?? NO_GROUPING}
          onChange={(value) => set({ dimension: value === NO_GROUPING ? null : value })}
          choices={[
            { value: NO_GROUPING, label: t('rep.toolbar.noGrouping') },
            ...spec.dimensions.map((value) => ({ value, label: dimensionLabel(t, value) })),
          ]}
          allowEmpty={false}
          ariaLabel={t('rep.toolbar.groupBy')}
        />
      </Field>
      {state.dimension === 'date' ? (
        <Field label={t('rep.toolbar.granularity')}>
          <ChoiceSelect
            value={state.granularity}
            onChange={(value) => set({ granularity: value as RunnerState['granularity'] })}
            choices={GRANULARITIES.map((value) => ({
              value,
              label: dynamicLabel(t, `rep.gran.${value}`, value),
            }))}
            allowEmpty={false}
            className="min-w-28"
            ariaLabel={t('rep.toolbar.granularity')}
          />
        </Field>
      ) : null}
      {(spec.params ?? []).map((param) => {
        const choices = options[param] ?? [];
        if (choices.length === 0) return null;
        return (
          <Field key={param} label={paramLabel(t, param)}>
            <ChoiceSelect
              value={state.params[param] ?? ''}
              onChange={(value) => set({ params: { ...state.params, [param]: value } })}
              choices={choices.map((c) => ({
                value: c.value,
                label: optionLabel(t, param, c.value, c.label),
              }))}
              emptyLabel={t('rep.param.any')}
              ariaLabel={paramLabel(t, param)}
            />
          </Field>
        );
      })}
      <Field label={t('rep.toolbar.chart')}>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={state.chart}
          onValueChange={(value) => {
            if (value !== '') set({ chart: value as ChartType });
          }}
        >
          {CHART_TYPES.map((chart) => {
            const Icon = CHART_ICONS[chart];
            const label = dynamicLabel(t, `rep.chart.${chart}`, chart);
            return (
              <ToggleGroupItem key={chart} value={chart} aria-label={label} title={label}>
                <Icon className="size-3.5" aria-hidden />
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </Field>
      {spec.filter !== null ? (
        <button
          type="button"
          onClick={onToggleFilters}
          aria-expanded={filtersOpen}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm hover:bg-muted aria-expanded:bg-muted"
        >
          <FilterIcon className="size-3.5" aria-hidden />
          {filterCount > 0
            ? t('rep.toolbar.filtersCount', { count: filterCount })
            : t('rep.toolbar.filters')}
        </button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  );
}
