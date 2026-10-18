import {
  COST_TYPES,
  type AdPlatform,
  type CostType,
  type Site,
  type TrafficSource,
} from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Link } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useAnalyticsMutation } from '../api';
import { errorDetails, funnelKeys, funnelsApi, useAdConnections } from '../api-funnels';
import { Segmented } from '../components/ui';
import { Field, selectClass, SwitchRow } from '../funnel-builder/panels/form-bits';
import { currencyDigits } from '../lib/format';
import { TrackingFieldsTable } from './fields-table';
import {
  conversionMode,
  setConversionMode,
  sourceIssues,
  toSourceInput,
  urlParamErrors,
  type ConversionMode,
  type SourceDraft,
} from './tracking-fields';

type Tab = 'general' | 'fields' | 'conversion' | 'advanced';

const CONVERSION_EVENTS = [
  'sale',
  'lead',
  ...Array.from({ length: 10 }, (_, i) => `event:${String(i + 1)}`),
];

const PLATFORM_EVENT_HINT: Record<AdPlatform, string> = {
  meta: 'Purchase, Lead, CompleteRegistration',
  google: 'customers/123/conversionActions/456',
  tiktok: 'CompletePayment, SubmitForm',
};

const TAB_FIELDS: Record<Tab, readonly string[]> = {
  general: ['name', 'category'],
  fields: ['reserved_fields', 'fields'],
  conversion: ['conversion'],
  advanced: [
    'cost_type',
    'default_cost_minor',
    'cost_modifier_pct',
    'revenue_modifier_pct',
    'skip_zero_revenue_postbacks',
    'postback_throttle_pct',
  ],
};

function ErrorLine({ message }: { message: string | undefined }) {
  return message ? <span className="text-[11px] text-destructive">{message}</span> : null;
}

/** Text input bound to a nullable number (`''` = null). */
function OptionalNumber({
  value,
  onChange,
  step,
  label,
  suffix,
  invalid,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  step?: string;
  label: string;
  suffix?: ReactNode;
  invalid?: boolean;
}) {
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  const parsed = raw.trim() === '' ? null : Number(raw.replace(',', '.'));
  const bad = parsed !== null && !Number.isFinite(parsed);
  return (
    <span className="flex items-center gap-1.5">
      <Input
        className="h-8 w-32"
        inputMode="decimal"
        step={step}
        aria-label={label}
        aria-invalid={bad || invalid}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          const next = e.target.value.trim() === '' ? null : Number(e.target.value.replace(',', '.'));
          if (next === null || Number.isFinite(next)) onChange(next);
        }}
      />
      {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
    </span>
  );
}

/** Create / edit dialog of a traffic source: general, tracking fields, conversions, advanced. */
export function SourceEditorDialog({
  tenant,
  site,
  source,
  initial,
  onClose,
}: {
  tenant: string;
  site: Site;
  /** Stored source being edited; absent when creating from a template. */
  source?: TrafficSource;
  initial: SourceDraft;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<SourceDraft>(initial);
  const [tab, setTab] = useState<Tab>('general');
  const [mode, setMode] = useState<ConversionMode>(() => conversionMode(initial.conversion));
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Map<string, string>>(new Map());
  const connections = useAdConnections(tenant, site.id);
  const digits = currencyDigits(site.currency);

  const paramMessages = useMemo(() => {
    const out = new Map<string, string>();
    for (const [path, code] of urlParamErrors(draft))
      out.set(path, t(`analytics.sources.error.urlParam.${code}`));
    return out;
  }, [draft, t]);
  const schemaIssues = useMemo(() => sourceIssues(draft), [draft]);
  const postbackMissing = mode === 'postback' && !(draft.conversion.postback_url ?? '').trim();
  const connectionMissing = mode === 'integration' && !draft.conversion.ad_connection_id;
  const errors = useMemo(() => {
    const out = new Map<string, string>(attempted ? schemaIssues : []);
    for (const [path, message] of serverErrors) out.set(path, message);
    for (const [path, message] of paramMessages) out.set(path, message);
    if (attempted && postbackMissing)
      out.set('conversion.postback_url', t('analytics.sources.error.required'));
    if (attempted && connectionMissing)
      out.set('conversion.ad_connection_id', t('analytics.sources.error.required'));
    return out;
  }, [attempted, schemaIssues, serverErrors, paramMessages, postbackMissing, connectionMissing, t]);
  const tabHasError = (name: Tab) =>
    [...errors.keys()].some((path) => TAB_FIELDS[name].some((p) => path === p || path.startsWith(`${p}.`)));

  const edit = (next: SourceDraft) => {
    setDraft(next);
    if (serverErrors.size > 0) setServerErrors(new Map());
  };
  const conversion = draft.conversion;
  const setConversion = (patch: Partial<SourceDraft['conversion']>) =>
    edit({ ...draft, conversion: { ...conversion, ...patch } });

  const api = funnelsApi(tenant);
  const save = useAnalyticsMutation(
    tenant,
    () =>
      source
        ? api.sources.update(site.id, source.id, toSourceInput(draft))
        : api.sources.create(site.id, toSourceInput(draft)),
    {
      invalidate: [funnelKeys.sources(tenant, site.id)],
      success: source ? 'analytics.sources.saved' : 'analytics.sources.created',
      onSuccess: onClose,
      onError: (error) => {
        const details = errorDetails(error);
        if (details.length === 0) return false;
        setServerErrors(new Map(details.map((d) => [d.path, d.message])));
        return false;
      },
    },
  );
  const submit = () => {
    setAttempted(true);
    if (schemaIssues.size > 0 || paramMessages.size > 0 || postbackMissing || connectionMissing) {
      const first = (['general', 'fields', 'conversion', 'advanced'] as const).find((name) =>
        [...schemaIssues.keys(), ...paramMessages.keys(), ...(postbackMissing || connectionMissing ? ['conversion'] : [])].some(
          (path) => TAB_FIELDS[name].some((p) => path === p || path.startsWith(`${p}.`)),
        ),
      );
      if (first) setTab(first);
      return;
    }
    save.mutate(undefined);
  };

  const activeConnections = (connections.data?.data ?? []).filter(
    (c) => c.status !== 'disconnected',
  );
  const tabLabel = (name: Tab) =>
    `${t(`analytics.sources.tab.${name}`)}${tabHasError(name) ? ' •' : ''}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {source ? t('analytics.sources.editTitle', { name: source.name }) : t('analytics.sources.newTitle')}
          </DialogTitle>
          <DialogDescription>{t('analytics.sources.editorHint')}</DialogDescription>
        </DialogHeader>
        <Segmented
          label={t('analytics.sources.tabs')}
          options={(['general', 'fields', 'conversion', 'advanced'] as const).map((value) => ({
            value,
            label: tabLabel(value),
          }))}
          value={tab}
          onChange={setTab}
        />

        {tab === 'general' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('analytics.common.name')}>
              <Input
                className="h-8"
                value={draft.name}
                maxLength={200}
                aria-invalid={errors.has('name')}
                onChange={(e) => edit({ ...draft, name: e.target.value })}
              />
              <ErrorLine message={errors.get('name')} />
            </Field>
            <Field label={t('analytics.sources.category')} hint={t('analytics.sources.categoryHint')}>
              <Input
                className="h-8"
                value={draft.category ?? ''}
                maxLength={64}
                onChange={(e) => edit({ ...draft, category: e.target.value })}
              />
              <ErrorLine message={errors.get('category')} />
            </Field>
            <Field label={t('analytics.sources.template')}>
              <span className="flex h-8 items-center text-xs text-muted-foreground">
                {t(`analytics.sources.template.${draft.template}`)}
              </span>
            </Field>
          </div>
        ) : null}

        {tab === 'fields' ? (
          <TrackingFieldsTable draft={draft} onChange={edit} errors={errors} />
        ) : null}

        {tab === 'conversion' ? (
          <div className="grid gap-4">
            <Field label={t('analytics.sources.conversion.mode')}>
              <Segmented
                label={t('analytics.sources.conversion.mode')}
                options={(['integration', 'postback', 'none'] as const).map((value) => ({
                  value,
                  label: t(`analytics.sources.conversion.mode.${value}`),
                }))}
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  edit({ ...draft, conversion: setConversionMode(conversion, next) });
                }}
              />
            </Field>
            {mode === 'integration' ? (
              <>
                <Field
                  label={t('analytics.sources.conversion.connection')}
                  hint={
                    activeConnections.length === 0 ? (
                      <>
                        {t('analytics.sources.conversion.noConnections')}{' '}
                        <Link
                          to="/t/$tenant/analytics/settings"
                          params={{ tenant }}
                          search={{ site: site.id, tab: 'ads' }}
                          className="font-medium text-foreground underline underline-offset-2"
                        >
                          {t('analytics.sources.conversion.connect')}
                        </Link>
                      </>
                    ) : (
                      t('analytics.sources.conversion.connectionHint')
                    )
                  }
                >
                  <select
                    className={selectClass}
                    value={conversion.ad_connection_id ?? ''}
                    aria-invalid={errors.has('conversion.ad_connection_id')}
                    onChange={(e) => {
                      const picked = activeConnections.find((c) => c.id === e.target.value);
                      setConversion({
                        ad_connection_id: picked?.id ?? null,
                        platform: picked?.platform ?? conversion.platform ?? null,
                      });
                    }}
                  >
                    <option value="">{t('analytics.sources.conversion.pickConnection')}</option>
                    {activeConnections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {t(`analytics.ads.connections.platform.${c.platform}`)} ·{' '}
                        {c.account_name ?? c.account_id}
                      </option>
                    ))}
                  </select>
                  <ErrorLine message={errors.get('conversion.ad_connection_id')} />
                </Field>
                <Field
                  label={t('analytics.sources.conversion.mapping')}
                  hint={t('analytics.sources.conversion.mappingHint')}
                >
                  <ul className="grid gap-1.5">
                    {conversion.mapping.map((row, i) => (
                      <li key={i} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] gap-2">
                        <select
                          className={selectClass}
                          aria-label={t('analytics.sources.conversion.event')}
                          value={row.event}
                          onChange={(e) =>
                            setConversion({
                              mapping: conversion.mapping.map((m, j) =>
                                j === i ? { ...m, event: e.target.value } : m,
                              ),
                            })
                          }
                        >
                          {CONVERSION_EVENTS.map((event) => (
                            <option key={event} value={event}>
                              {event.startsWith('event:')
                                ? t('analytics.sources.conversion.customEvent', { n: event.slice(6) })
                                : t(`analytics.sources.conversion.event.${event as 'sale' | 'lead'}`)}
                            </option>
                          ))}
                        </select>
                        <span className="grid gap-0.5">
                          <Input
                            className="h-8 font-mono text-xs"
                            aria-label={t('analytics.sources.conversion.platformEvent')}
                            placeholder={
                              conversion.platform ? PLATFORM_EVENT_HINT[conversion.platform] : ''
                            }
                            value={row.platform_event}
                            maxLength={200}
                            onChange={(e) =>
                              setConversion({
                                mapping: conversion.mapping.map((m, j) =>
                                  j === i ? { ...m, platform_event: e.target.value } : m,
                                ),
                              })
                            }
                          />
                          <ErrorLine
                            message={
                              errors.get(`conversion.mapping.${String(i)}.platform_event`) ??
                              errors.get(`conversion.mapping.${String(i)}.event`)
                            }
                          />
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          aria-label={t('analytics.sources.conversion.removeMapping')}
                          onClick={() =>
                            setConversion({ mapping: conversion.mapping.filter((_, j) => j !== i) })
                          }
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 justify-self-start text-xs"
                    disabled={conversion.mapping.length >= 30}
                    onClick={() =>
                      setConversion({
                        mapping: [
                          ...conversion.mapping,
                          {
                            event:
                              CONVERSION_EVENTS.find(
                                (e) => !conversion.mapping.some((m) => m.event === e),
                              ) ?? 'sale',
                            platform_event: '',
                          },
                        ],
                      })
                    }
                  >
                    <Plus className="size-3.5" aria-hidden />
                    {t('analytics.sources.conversion.addMapping')}
                  </Button>
                </Field>
              </>
            ) : null}
            {mode === 'postback' ? (
              <Field
                label={t('analytics.sources.conversion.postbackUrl')}
                hint={t('analytics.sources.conversion.postbackHint')}
              >
                <Input
                  className="h-8 font-mono text-xs"
                  placeholder="https://network.example/postback?click={external}&payout={payout}&tx={txid}"
                  value={conversion.postback_url ?? ''}
                  maxLength={2048}
                  aria-invalid={errors.has('conversion.postback_url')}
                  onChange={(e) => setConversion({ postback_url: e.target.value })}
                />
                <ErrorLine message={errors.get('conversion.postback_url')} />
              </Field>
            ) : null}
            {mode === 'none' ? (
              <p className="text-xs text-muted-foreground">
                {t('analytics.sources.conversion.noneHint')}
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === 'advanced' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('analytics.sources.costType')}>
              <select
                className={selectClass}
                value={draft.cost_type}
                onChange={(e) => edit({ ...draft, cost_type: e.target.value as CostType })}
              >
                {COST_TYPES.map((c) => (
                  <option key={c} value={c}>
                    {t(`analytics.sources.costType.${c}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('analytics.sources.defaultCost')} hint={t('analytics.sources.defaultCostHint')}>
              <OptionalNumber
                label={t('analytics.sources.defaultCost')}
                value={
                  draft.default_cost_minor === null
                    ? null
                    : draft.default_cost_minor / 10 ** digits
                }
                suffix={site.currency}
                invalid={errors.has('default_cost_minor')}
                onChange={(major) =>
                  edit({
                    ...draft,
                    default_cost_minor: major === null ? null : Math.round(major * 10 ** digits),
                  })
                }
              />
              <ErrorLine message={errors.get('default_cost_minor')} />
            </Field>
            <Field label={t('analytics.sources.costModifier')} hint={t('analytics.sources.costModifierHint')}>
              <OptionalNumber
                label={t('analytics.sources.costModifier')}
                value={draft.cost_modifier_pct}
                suffix="%"
                invalid={errors.has('cost_modifier_pct')}
                onChange={(cost_modifier_pct) => edit({ ...draft, cost_modifier_pct })}
              />
              <ErrorLine message={errors.get('cost_modifier_pct')} />
            </Field>
            <Field
              label={t('analytics.sources.revenueModifier')}
              hint={t('analytics.sources.revenueModifierHint')}
            >
              <OptionalNumber
                label={t('analytics.sources.revenueModifier')}
                value={draft.revenue_modifier_pct}
                suffix="%"
                invalid={errors.has('revenue_modifier_pct')}
                onChange={(revenue_modifier_pct) => edit({ ...draft, revenue_modifier_pct })}
              />
              <ErrorLine message={errors.get('revenue_modifier_pct')} />
            </Field>
            <Field label={t('analytics.sources.throttle')} hint={t('analytics.sources.throttleHint')}>
              <OptionalNumber
                label={t('analytics.sources.throttle')}
                value={draft.postback_throttle_pct}
                suffix="%"
                invalid={errors.has('postback_throttle_pct')}
                onChange={(postback_throttle_pct) => edit({ ...draft, postback_throttle_pct })}
              />
              <ErrorLine message={errors.get('postback_throttle_pct')} />
            </Field>
            <div className="self-start pt-5">
              <SwitchRow
                label={t('analytics.sources.skipZero')}
                hint={t('analytics.sources.skipZeroHint')}
                checked={draft.skip_zero_revenue_postbacks}
                onChange={(skip_zero_revenue_postbacks) =>
                  edit({ ...draft, skip_zero_revenue_postbacks })
                }
              />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <DashboardButton variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </DashboardButton>
          <DashboardButton variant="primary" disabled={save.isPending} onClick={submit}>
            {source ? t('analytics.sources.save') : t('analytics.sources.create')}
          </DashboardButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
