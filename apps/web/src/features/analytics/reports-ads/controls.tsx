import {
  ATTRIBUTION_MODELS_V2,
  REPORT_BASIS,
  type AttributionModelV2,
  type ReportBasis,
} from '@amable/api-types';
import {
  cn,
  DashboardButton,
  DashboardFilterMenu,
  DashboardPopover,
  DashboardPopoverContent,
  DashboardPopoverTrigger,
} from '@amable/ui';
import { Check, Columns3, Info } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { columnLabel, modelHint, modelLabel } from './labels';
import {
  DEFAULT_PERFORMANCE_COLUMNS,
  PERFORMANCE_COLUMN_IDS,
  toggleColumn,
  WINDOW_PRESETS,
  type PerformanceColumn,
} from './model';

/** Attribution model picker, the window of `windowed_hybrid` and an explainer of every model. */
export function AttributionModelControls({
  model,
  windowDays,
  onModel,
  onWindow,
}: {
  model: AttributionModelV2;
  windowDays: number;
  onModel: (model: AttributionModelV2) => void;
  onWindow: (days: number) => void;
}) {
  const { t } = useI18n();
  const windows: number[] = [...WINDOW_PRESETS];
  if (!windows.includes(windowDays)) windows.push(windowDays);
  windows.sort((a, b) => a - b);
  return (
    <>
      <DashboardFilterMenu
        label={t('analytics.performance.model')}
        value={model}
        options={ATTRIBUTION_MODELS_V2.map((value) => ({ value, label: modelLabel(t, value) }))}
        onValueChange={(value) => onModel(value as AttributionModelV2)}
      />
      {model === 'windowed_hybrid' ? (
        <DashboardFilterMenu
          label={t('analytics.performance.window')}
          value={String(windowDays)}
          options={windows.map((days) => ({
            value: String(days),
            label: t('analytics.performance.windowDays', { days }),
          }))}
          onValueChange={(value) => onWindow(Number(value))}
        />
      ) : null}
      <ModelExplainer model={model} />
    </>
  );
}

function ModelExplainer({ model }: { model: AttributionModelV2 }) {
  const { t } = useI18n();
  return (
    <DashboardPopover>
      <DashboardPopoverTrigger asChild>
        <DashboardButton variant="ghost" size="sm" aria-label={t('analytics.performance.modelLearn')}>
          <Info aria-hidden />
        </DashboardButton>
      </DashboardPopoverTrigger>
      <DashboardPopoverContent align="start" className="w-80 p-3">
        <h3 className="mb-2 text-xs font-medium">{t('analytics.performance.modelLearn')}</h3>
        <dl className="flex flex-col gap-2">
          {ATTRIBUTION_MODELS_V2.map((value) => (
            <div
              key={value}
              className={cn(
                'rounded-md px-2 py-1.5',
                value === model ? 'bg-primary/10' : 'bg-foreground/[0.03]',
              )}
            >
              <dt className="text-xs font-medium">{modelLabel(t, value)}</dt>
              <dd className="text-[11.5px] leading-snug text-muted-foreground">
                {modelHint(t, value)}
              </dd>
            </div>
          ))}
        </dl>
      </DashboardPopoverContent>
    </DashboardPopover>
  );
}

export function BasisPicker({
  basis,
  onChange,
}: {
  basis: ReportBasis;
  onChange: (basis: ReportBasis) => void;
}) {
  const { t } = useI18n();
  return (
    <span title={t(`analytics.performance.basisHint.${basis}`)}>
      <DashboardFilterMenu
        label={t('analytics.performance.basis')}
        value={basis}
        options={REPORT_BASIS.map((value) => ({
          value,
          label: t(`analytics.performance.basis.${value}`),
        }))}
        onValueChange={(value) => onChange(value as ReportBasis)}
      />
    </span>
  );
}

export function ColumnPicker({
  columns,
  onChange,
}: {
  columns: readonly PerformanceColumn[];
  onChange: (columns: PerformanceColumn[]) => void;
}) {
  const { t } = useI18n();
  return (
    <DashboardPopover>
      <DashboardPopoverTrigger asChild>
        <DashboardButton variant="ghost" size="sm">
          <Columns3 aria-hidden />
          <span className="hidden sm:inline">{t('analytics.performance.columns')}</span>
        </DashboardButton>
      </DashboardPopoverTrigger>
      <DashboardPopoverContent align="end" className="w-64 p-2">
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {PERFORMANCE_COLUMN_IDS.map((column) => {
            const on = columns.includes(column);
            const last = on && columns.length === 1;
            return (
              <li key={column}>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={last}
                  onClick={() => onChange(toggleColumn(columns, column))}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-foreground/[0.05] disabled:opacity-60"
                >
                  <span
                    className={cn(
                      'flex size-3.5 items-center justify-center rounded-[4px] border',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )}
                  >
                    {on ? <Check className="size-2.5" aria-hidden /> : null}
                  </span>
                  {columnLabel(t, column)}
                </button>
              </li>
            );
          })}
        </ul>
        <DashboardButton
          variant="ghost"
          size="sm"
          className="mt-1 w-full"
          onClick={() => onChange([...DEFAULT_PERFORMANCE_COLUMNS])}
        >
          {t('analytics.performance.columnsReset')}
        </DashboardButton>
      </DashboardPopoverContent>
    </DashboardPopover>
  );
}
