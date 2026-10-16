import {
  ANALYTICS_FILTER_DIMENSIONS,
  ATTRIBUTION_MODELS,
  type AnalyticsFilter,
  type AnalyticsFilterDimension,
  type AnalyticsInterval,
  type AttributionModel,
  type Site,
} from '@amable/api-types';
import {
  DashboardButton,
  DashboardFilterMenu,
  DashboardPopover,
  DashboardPopoverContent,
  DashboardPopoverTrigger,
} from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Plus, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { countryName } from '../lib/countries';
import { dimensionLabel, intervalLabel, modelLabel, opLabel, presetLabel } from '../lib/labels';
import type { QueryControls } from '../lib/query-state';
import { isRangePreset, RANGE_PRESETS, type RangePreset } from '../lib/range';

export function SitePicker({
  sites,
  site,
  onChange,
}: {
  sites: readonly Site[];
  site: Site | null;
  onChange: (siteId: string) => void;
}) {
  const { t } = useI18n();
  if (!site) return null;
  return (
    <DashboardFilterMenu
      label={t('analytics.controls.site')}
      value={site.id}
      options={sites.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
      onValueChange={onChange}
    />
  );
}

const dateInput =
  'h-[30px] rounded-md border border-(--obsidian-dashboard-shell-border) bg-(--obsidian-dashboard-shell-control) px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

export function RangeControls({
  controls,
  showInterval = true,
}: {
  controls: QueryControls;
  showInterval?: boolean;
}) {
  const { t } = useI18n();
  const { preset, range, interval, intervals, update } = controls;
  return (
    <>
      <DashboardFilterMenu
        label={t('analytics.controls.range')}
        value={preset}
        options={RANGE_PRESETS.map((value) => ({ value, label: presetLabel(t, value) }))}
        onValueChange={(value) => {
          if (!isRangePreset(value)) return;
          const next: RangePreset = value;
          update(
            next === 'custom'
              ? { range: next, from: range.from, to: range.to, interval: undefined }
              : { range: next, from: undefined, to: undefined, interval: undefined },
          );
        }}
      />
      {preset === 'custom' ? (
        <span className="flex items-center gap-1">
          <input
            type="date"
            className={dateInput}
            value={range.from}
            max={range.to}
            aria-label={t('analytics.controls.from')}
            onChange={(event) => event.target.value && update({ from: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            className={dateInput}
            value={range.to}
            min={range.from}
            aria-label={t('analytics.controls.to')}
            onChange={(event) => event.target.value && update({ to: event.target.value })}
          />
        </span>
      ) : null}
      {showInterval && intervals.length > 1 ? (
        <DashboardFilterMenu
          label={t('analytics.controls.interval')}
          value={interval}
          options={intervals.map((value) => ({ value, label: intervalLabel(t, value) }))}
          onValueChange={(value) => update({ interval: value as AnalyticsInterval })}
        />
      ) : null}
    </>
  );
}

export function ModelPicker({ controls }: { controls: QueryControls }) {
  const { t } = useI18n();
  return (
    <DashboardFilterMenu
      label={t('analytics.controls.attribution')}
      value={controls.model}
      options={ATTRIBUTION_MODELS.map((value) => ({ value, label: modelLabel(t, value) }))}
      onValueChange={(value) => controls.update({ model: value as AttributionModel })}
    />
  );
}

function filterValueLabel(filter: AnalyticsFilter, locale: string): string {
  return filter.dimension === 'country' && filter.op !== 'contains'
    ? countryName(filter.value, locale) || filter.value
    : filter.value;
}

function AddFilter({ onAdd }: { onAdd: (filter: AnalyticsFilter) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [dimension, setDimension] = useState<AnalyticsFilterDimension>('page');
  const [op, setOp] = useState<AnalyticsFilter['op']>('is');
  const [value, setValue] = useState('');
  const select =
    'h-8 w-full rounded-md border border-(--obsidian-dashboard-shell-border) bg-(--obsidian-dashboard-shell-control) px-2 text-xs text-foreground outline-none';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    onAdd({ dimension, op, value: value.trim() });
    setValue('');
    setOpen(false);
  };

  return (
    <DashboardPopover open={open} onOpenChange={setOpen}>
      <DashboardPopoverTrigger asChild>
        <DashboardButton variant="ghost" size="sm">
          <Plus aria-hidden />
          {t('analytics.filter.add')}
        </DashboardButton>
      </DashboardPopoverTrigger>
      <DashboardPopoverContent align="start" className="w-72 p-3">
        <form onSubmit={submit} className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="amb-filter-dim">
              {t('analytics.filter.dimension')}
            </Label>
            <select
              id="amb-filter-dim"
              className={select}
              value={dimension}
              onChange={(event) => setDimension(event.target.value as AnalyticsFilterDimension)}
            >
              {ANALYTICS_FILTER_DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {dimensionLabel(t, d)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="amb-filter-op">
              {t('analytics.filter.operator')}
            </Label>
            <select
              id="amb-filter-op"
              className={select}
              value={op}
              onChange={(event) => setOp(event.target.value as AnalyticsFilter['op'])}
            >
              {(['is', 'is_not', 'contains'] as const).map((o) => (
                <option key={o} value={o}>
                  {opLabel(t, o)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs" htmlFor="amb-filter-value">
              {t('analytics.filter.value')}
            </Label>
            <Input
              id="amb-filter-value"
              className="h-8 text-xs"
              value={value}
              maxLength={255}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                dimension === 'country' ? 'IT' : dimension.includes('page') ? '/pricing' : ''
              }
            />
          </div>
          <DashboardButton type="submit" variant="primary" size="sm" disabled={!value.trim()}>
            {t('analytics.filter.apply')}
          </DashboardButton>
        </form>
      </DashboardPopoverContent>
    </DashboardPopover>
  );
}

/** Active filters as removable chips, plus "Add filter". */
export function FilterBar({ controls, extra }: { controls: QueryControls; extra?: ReactNode }) {
  const { t, locale } = useI18n();
  const { filters, removeFilter, setFilters, addFilter } = controls;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
      {filters.map((filter, index) => (
        <span
          key={`${filter.dimension}-${filter.op}-${index}`}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-primary/10 pl-2.5 pr-1 text-xs text-foreground"
        >
          <span className="text-muted-foreground">{dimensionLabel(t, filter.dimension)}</span>
          <span className="text-muted-foreground">{opLabel(t, filter.op)}</span>
          <span className="max-w-48 truncate font-medium">{filterValueLabel(filter, locale)}</span>
          <button
            type="button"
            onClick={() => removeFilter(index)}
            aria-label={t('analytics.filter.remove')}
            className="ml-0.5 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <AddFilter onAdd={addFilter} />
      {filters.length > 1 ? (
        <DashboardButton variant="ghost" size="sm" onClick={() => setFilters([])}>
          {t('analytics.filter.clear')}
        </DashboardButton>
      ) : null}
      {extra}
    </div>
  );
}
