import {
  CHART_TYPES,
  COMPARE_MODES,
  DATE_PRESETS,
  GRANULARITIES,
  REPORT_SOURCES,
  type ReportSource,
} from '@amable/api-types/reports';
import { PageBody, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Textarea } from '@amable/ui/ui/textarea';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../../commerce/components/currency-select';
import { Field, SwitchRow } from '../../automations/components/form-bits';
import { errorMessage } from '../../crm/api/hooks';
import { ChoiceSelect } from '../../crm/components/inputs';
import { useFieldCatalog } from '../../crm/field-catalog';
import { QueryBuilder } from '../../search/query-builder';
import {
  useAdHocRun,
  useCustomReport,
  useReportApi,
  useReportCatalog,
  useReportEntry,
  useReportMutation,
  useReportPermissions,
} from '../api/hooks';
import { ReportVisual } from '../components/report-visual';
import {
  changeSource,
  emptyForm,
  formFromCatalogEntry,
  formFromReport,
  formToDefinition,
  formToPayload,
  MAX_MEASURES,
  specOf,
  toggleMeasure,
  validateForm,
  type ReportFormState,
} from '../lib/definition-form';
import { dimensionLabel, dynamicLabel, measureLabel, reportName, sourceLabel } from '../lib/labels';
import { useStableDebounced } from '../lib/use-debounced';

const NO_GROUPING = '__none';

function BuilderForm({ initial, customId }: { initial: ReportFormState; customId: string | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { slug, api } = useReportApi();
  const catalogQuery = useReportCatalog();
  const [state, setState] = useState<ReportFormState>(initial);
  const [touched, setTouched] = useState(false);
  const spec = specOf(state.source);
  const fieldCatalog = useFieldCatalog(spec.filter === 'company' ? 'company' : 'contact');
  const set = (patch: Partial<ReportFormState>) => setState((s) => ({ ...s, ...patch }));
  const issues = validateForm(state);

  const readable = catalogQuery.data?.sources;
  const sources = REPORT_SOURCES.filter((s) => readable === undefined || s in readable);
  const definition = useMemo(
    () => (state.measures.length > 0 ? formToDefinition(state, fieldCatalog.kinds) : null),
    [state, fieldCatalog.kinds],
  );
  const preview = useAdHocRun(useStableDebounced(definition, 500));

  const save = useReportMutation({
    mutationFn: async () => {
      const payload = formToPayload(state, fieldCatalog.kinds);
      return customId === null
        ? api.createCustomReport(payload)
        : api.updateCustomReport(customId, payload);
    },
    success: t('rep.saved'),
    onSuccess: (report) => {
      void navigate({
        to: '/t/$tenant/reports/$reportId',
        params: { tenant: slug, reportId: report.id },
      });
    },
  });

  const submit = () => {
    setTouched(true);
    if (issues.length === 0) save.mutate(undefined);
  };

  return (
    <PageBody className="grid gap-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <Link
            to="/t/$tenant/reports"
            params={{ tenant: slug }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" aria-hidden /> {t('rep.back')}
          </Link>
          <h1 className="text-lg font-semibold">
            {customId === null ? t('rep.builder.titleNew') : t('rep.builder.titleEdit')}
          </h1>
        </div>
        <Button size="sm" onClick={submit} disabled={save.isPending} data-testid="report-save">
          <Save className="size-4" aria-hidden /> {t('rep.save')}
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(20rem,26rem)_1fr]">
        <Card className="py-4">
          <CardContent className="grid gap-4 px-4">
            <Field
              label={t('rep.builder.name')}
              hint={touched && issues.includes('name') ? t('rep.builder.nameRequired') : undefined}
            >
              <Input
                value={state.name}
                onChange={(e) => set({ name: e.target.value })}
                aria-invalid={touched && issues.includes('name')}
                maxLength={200}
                data-testid="report-name"
              />
            </Field>
            <Field label={t('rep.builder.description')}>
              <Textarea
                value={state.description}
                onChange={(e) => set({ description: e.target.value })}
                rows={2}
                maxLength={2000}
              />
            </Field>
            <Field label={t('rep.builder.source')}>
              <ChoiceSelect
                value={state.source}
                onChange={(value) => setState((s) => changeSource(s, value as ReportSource))}
                choices={sources.map((value) => ({ value, label: sourceLabel(t, value) }))}
                allowEmpty={false}
                ariaLabel={t('rep.builder.source')}
              />
            </Field>
            <Field
              label={t('rep.builder.measures')}
              hint={
                touched && issues.includes('measures')
                  ? t('rep.builder.measureRequired')
                  : t('rep.builder.measuresHint')
              }
            >
              <div
                className="grid grid-cols-2 gap-x-3 gap-y-1.5"
                role="group"
                aria-label={t('rep.builder.measures')}
              >
                {Object.keys(spec.measures).map((measure) => {
                  const checked = state.measures.includes(measure);
                  const id = `measure-${measure}`;
                  return (
                    <div key={measure} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={!checked && state.measures.length >= MAX_MEASURES}
                        onCheckedChange={() => setState((s) => toggleMeasure(s, measure))}
                      />
                      <Label htmlFor={id} className="text-sm font-normal">
                        {measureLabel(t, measure)}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rep.builder.dimension')}>
                <ChoiceSelect
                  value={state.dimension ?? NO_GROUPING}
                  onChange={(value) => set({ dimension: value === NO_GROUPING ? null : value })}
                  choices={[
                    { value: NO_GROUPING, label: t('rep.toolbar.noGrouping') },
                    ...spec.dimensions.map((value) => ({ value, label: dimensionLabel(t, value) })),
                  ]}
                  allowEmpty={false}
                  className="min-w-0"
                  ariaLabel={t('rep.builder.dimension')}
                />
              </Field>
              <Field label={t('rep.toolbar.granularity')}>
                <ChoiceSelect
                  value={state.granularity}
                  onChange={(value) =>
                    set({ granularity: value as ReportFormState['granularity'] })
                  }
                  choices={GRANULARITIES.map((value) => ({
                    value,
                    label: dynamicLabel(t, `rep.gran.${value}`, value),
                  }))}
                  allowEmpty={false}
                  disabled={state.dimension !== 'date'}
                  className="min-w-0"
                  ariaLabel={t('rep.toolbar.granularity')}
                />
              </Field>
            </div>
            {spec.snapshot === true ? (
              <p className="text-xs text-muted-foreground">{t('rep.builder.snapshot')}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('rep.toolbar.range')}>
                    <ChoiceSelect
                      value={state.preset}
                      onChange={(value) => set({ preset: value as ReportFormState['preset'] })}
                      choices={[...DATE_PRESETS, 'custom' as const].map((value) => ({
                        value,
                        label: dynamicLabel(t, `rep.preset.${value}`, value),
                      }))}
                      allowEmpty={false}
                      className="min-w-0"
                      ariaLabel={t('rep.toolbar.range')}
                    />
                  </Field>
                  <Field label={t('rep.toolbar.compare')}>
                    <ChoiceSelect
                      value={state.compare}
                      onChange={(value) => set({ compare: value as ReportFormState['compare'] })}
                      choices={COMPARE_MODES.map((value) => ({
                        value,
                        label: dynamicLabel(t, `rep.compare.${value}`, value),
                      }))}
                      allowEmpty={false}
                      className="min-w-0"
                      ariaLabel={t('rep.toolbar.compare')}
                    />
                  </Field>
                </div>
                {state.preset === 'custom' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label={t('rep.toolbar.from')}>
                      <Input
                        type="date"
                        className="h-8"
                        value={state.from}
                        onChange={(e) => set({ from: e.target.value })}
                      />
                    </Field>
                    <Field label={t('rep.toolbar.to')}>
                      <Input
                        type="date"
                        className="h-8"
                        value={state.to}
                        onChange={(e) => set({ to: e.target.value })}
                      />
                    </Field>
                  </div>
                ) : null}
              </>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('rep.builder.chart')}>
                <ChoiceSelect
                  value={state.chart}
                  onChange={(value) => set({ chart: value as ReportFormState['chart'] })}
                  choices={CHART_TYPES.map((value) => ({
                    value,
                    label: dynamicLabel(t, `rep.chart.${value}`, value),
                  }))}
                  allowEmpty={false}
                  className="min-w-0"
                  ariaLabel={t('rep.builder.chart')}
                />
              </Field>
              <Field label={t('rep.builder.limit')}>
                <Input
                  type="number"
                  min={1}
                  max={500}
                  className="h-8"
                  value={String(state.limit)}
                  onChange={(e) => set({ limit: Number(e.target.value) })}
                />
              </Field>
            </div>
            {spec.currency ? (
              <Field label={t('rep.builder.currency')} hint={t('rep.builder.currencyHint')}>
                <CurrencySelect
                  value={state.currency}
                  onChange={(currency) => set({ currency })}
                  allowEmpty
                  ariaLabel={t('rep.builder.currency')}
                />
              </Field>
            ) : null}
            <SwitchRow
              label={`${t('rep.builder.sharing')}: ${state.shared ? t('rep.shared') : t('rep.private')}`}
              checked={state.shared}
              onChange={(shared) => set({ shared })}
            />
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4">
          <Card className="py-3">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">{t('rep.builder.filters')}</CardTitle>
            </CardHeader>
            <CardContent className="px-4">
              {spec.filter === null ? (
                <p className="text-xs text-muted-foreground">{t('rep.builder.noFilters')}</p>
              ) : (
                <QueryBuilder
                  root={state.filter}
                  onChange={(filter) => set({ filter })}
                  fields={fieldCatalog.fields}
                  allowTags={spec.filter === 'contact'}
                />
              )}
            </CardContent>
          </Card>
          <Card className="py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">{t('rep.builder.preview')}</CardTitle>
            </CardHeader>
            <CardContent className="px-4" data-testid="report-preview">
              {definition === null ? (
                <p className="text-sm text-muted-foreground">{t('rep.builder.measureRequired')}</p>
              ) : preview.isPending ? (
                <Skeleton className="h-[320px]" />
              ) : preview.isError ? (
                <p className="text-sm text-destructive">{errorMessage(t, preview.error)}</p>
              ) : preview.data !== undefined ? (
                <ReportVisual result={preview.data} chart={state.chart} />
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}

export function ReportBuilderPage() {
  const { t } = useI18n();
  usePageChrome({ title: t('rep.builder.titleNew') });
  const perms = useReportPermissions();
  const { customId } = useParams({ strict: false });
  const search: { from?: string } = useSearch({ strict: false });
  const custom = useCustomReport(customId ?? null);
  const template = useReportEntry(search.from ?? '');
  const templateWanted = customId === undefined && search.from !== undefined;

  if (perms.ready && !perms.canCreate)
    return (
      <PageBody className="pt-10 text-center text-sm text-muted-foreground">
        {t('rep.forbidden')}
      </PageBody>
    );
  if (customId !== undefined) {
    if (custom.isPending)
      return (
        <PageBody className="pt-4">
          <Skeleton className="h-[480px]" />
        </PageBody>
      );
    if (custom.isError)
      return (
        <PageBody className="pt-10 text-center text-sm text-muted-foreground">
          {errorMessage(t, custom.error)}
        </PageBody>
      );
    return (
      <BuilderForm
        key={custom.data.id}
        initial={formFromReport(custom.data)}
        customId={custom.data.id}
      />
    );
  }
  if (templateWanted) {
    if (template.isPending)
      return (
        <PageBody className="pt-4">
          <Skeleton className="h-[480px]" />
        </PageBody>
      );
    if (template.isSuccess) {
      const form = formFromCatalogEntry(template.data);
      return (
        <BuilderForm
          key={template.data.id}
          initial={{ ...form, name: reportName(t, template.data) }}
          customId={null}
        />
      );
    }
  }
  return <BuilderForm key="new" initial={emptyForm()} customId={null} />;
}
