import {
  CHART_TYPES,
  COMPARE_MODES,
  DATE_PRESETS,
  REPORT_SOURCE_SPECS,
  type DashboardWidget,
  type ReportCatalogEntry,
} from '@amable/api-types/reports';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { Field } from '../../automations/components/form-bits';
import { ChoiceSelect } from '../../crm/components/inputs';
import { groupByArea } from '../lib/areas';
import { dynamicLabel, measureLabel, reportName } from '../lib/labels';
import { widgetFormFrom, widgetFromForm, type WidgetFormState } from '../lib/widget-form';

export interface WidgetDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** null = new widget. */
  readonly widget: DashboardWidget | null;
  readonly others: readonly DashboardWidget[];
  readonly catalog: readonly ReportCatalogEntry[];
  readonly onSubmit: (widget: DashboardWidget) => void;
}

function WidgetForm({
  widget,
  others,
  catalog,
  onSubmit,
  onCancel,
}: Omit<WidgetDialogProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<WidgetFormState>(() =>
    widgetFormFrom(widget, catalog[0]?.id ?? ''),
  );
  const set = (patch: Partial<WidgetFormState>) => setForm((f) => ({ ...f, ...patch }));
  const entry = catalog.find((e) => e.id === form.reportId);
  const measures =
    entry === undefined ? [] : Object.keys(REPORT_SOURCE_SPECS[entry.definition.source].measures);
  const reportChoices = groupByArea(catalog).flatMap((group) =>
    group.entries.map((e) => ({
      value: e.id,
      label: `${dynamicLabel(t, `rep.area.${group.area}`, group.area)} · ${reportName(t, e)}`,
    })),
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (form.reportId === '') return;
        onSubmit(
          widgetFromForm(
            form,
            widget,
            others.filter((o) => o.id !== widget?.id),
          ),
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('rep.widget.type')}>
          <ChoiceSelect
            value={form.type}
            onChange={(value) => set({ type: value as WidgetFormState['type'] })}
            choices={CHART_TYPES.map((value) => ({
              value,
              label: dynamicLabel(t, `rep.chart.${value}`, value),
            }))}
            allowEmpty={false}
            className="min-w-0"
            ariaLabel={t('rep.widget.type')}
          />
        </Field>
        <Field label={t('rep.widget.report')}>
          <ChoiceSelect
            value={form.reportId}
            onChange={(value) => set({ reportId: value, measures: [] })}
            choices={reportChoices}
            allowEmpty={false}
            className="min-w-0"
            ariaLabel={t('rep.widget.report')}
          />
        </Field>
      </div>
      <Field label={t('rep.widget.title')} hint={t('rep.widget.titleHint')}>
        <Input
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          maxLength={200}
          className="h-8"
        />
      </Field>
      {measures.length > 0 ? (
        <Field label={t('rep.widget.measures')}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {measures.map((measure) => {
              const id = `widget-measure-${measure}`;
              const checked = form.measures.includes(measure);
              return (
                <div key={measure} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() =>
                      set({
                        measures: checked
                          ? form.measures.filter((m) => m !== measure)
                          : measures.filter((m) => m === measure || form.measures.includes(m)),
                      })
                    }
                  />
                  <Label htmlFor={id} className="text-sm font-normal">
                    {measureLabel(t, measure)}
                  </Label>
                </div>
              );
            })}
          </div>
        </Field>
      ) : null}
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('rep.widget.range')}>
          <ChoiceSelect
            value={form.preset}
            onChange={(value) => set({ preset: value as WidgetFormState['preset'] })}
            choices={DATE_PRESETS.map((value) => ({
              value,
              label: dynamicLabel(t, `rep.preset.${value}`, value),
            }))}
            emptyLabel={t('rep.widget.rangeReport')}
            className="min-w-0"
            ariaLabel={t('rep.widget.range')}
          />
        </Field>
        <Field label={t('rep.widget.compare')}>
          <ChoiceSelect
            value={form.compare}
            onChange={(value) => set({ compare: value as WidgetFormState['compare'] })}
            choices={COMPARE_MODES.map((value) => ({
              value,
              label: dynamicLabel(t, `rep.compare.${value}`, value),
            }))}
            emptyLabel={t('rep.widget.rangeReport')}
            className="min-w-0"
            ariaLabel={t('rep.widget.compare')}
          />
        </Field>
        <Field label={t('rep.widget.limit')}>
          <Input
            type="number"
            min={1}
            max={500}
            value={form.limit}
            onChange={(e) => set({ limit: e.target.value })}
            className="h-8"
          />
        </Field>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('rep.cancel')}
        </Button>
        <Button type="submit" disabled={form.reportId === ''} data-testid="widget-submit">
          {t('rep.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function WidgetDialog({ open, onOpenChange, ...props }: WidgetDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {props.widget === null ? t('rep.widget.titleNew') : t('rep.widget.titleEdit')}
          </DialogTitle>
        </DialogHeader>
        {open ? <WidgetForm {...props} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
