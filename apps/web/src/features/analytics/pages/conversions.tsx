import {
  CONVERSION_DIMENSIONS,
  type ConversionDimension,
  type ConversionReport,
  type ConversionRule,
  type CreateConversionRuleInput,
} from '@amable/api-types';
import { cn, DashboardButton, DashboardConfirmDialog, DashboardFilterMenu } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link, useParams } from '@tanstack/react-router';
import { Pencil, Plus, Target, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { currencyExponent } from '../../../lib/money';
import { tenantRoute } from '../../../routes/tenant';
import {
  analyticsApi,
  analyticsKeys,
  useAnalyticsMutation,
  useConversionReport,
  useConversionRules,
} from '../api';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, ListSkeleton, Panel, panelClass } from '../components/ui';
import { useFormatters } from '../lib/format';
import { dimensionLabel } from '../lib/labels';
import { useAnalyticsPermissions } from '../lib/permissions';
import type { AnalyticsState } from '../lib/query-state';

const select =
  'h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

function useRuleSummary() {
  const { t } = useI18n();
  return (rule: ConversionRule) => {
    const target =
      rule.trigger === 'goal'
        ? t('analytics.conversions.summary.goal', { value: rule.value })
        : t(`analytics.conversions.summary.${rule.match}`, {
            value: rule.hostname ? `${rule.hostname}${rule.value}` : rule.value,
          });
    return `${target} · ${t(`analytics.conversions.count.${rule.count}`)}`;
  };
}

function RuleEditor({
  tenant,
  siteId,
  currency,
  rule,
  onClose,
  onSaved,
}: {
  tenant: string;
  siteId: string;
  currency: string;
  rule: ConversionRule | null;
  onClose: () => void;
  onSaved: (rule: ConversionRule) => void;
}) {
  const { t } = useI18n();
  const api = analyticsApi(tenant);
  const digits = currencyExponent(currency);
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState(rule?.trigger ?? 'pageview');
  const [value, setValue] = useState(rule?.value ?? '');
  const [match, setMatch] = useState(rule?.match ?? 'exact');
  const [hostname, setHostname] = useState(rule?.hostname ?? '');
  const [count, setCount] = useState(rule?.count ?? 'once');
  const [amount, setAmount] = useState(
    !rule || rule.value_minor === null ? '' : (rule.value_minor / 10 ** digits).toFixed(digits),
  );
  const [backfill, setBackfill] = useState(true);

  const parsedAmount = amount.trim() === '' ? null : Number(amount.replace(',', '.'));
  const amountValid = parsedAmount === null || (Number.isFinite(parsedAmount) && parsedAmount >= 0);
  const valid = name.trim().length > 0 && value.trim().length > 0 && amountValid;

  const save = useAnalyticsMutation(
    tenant,
    () => {
      const input = {
        name: name.trim(),
        trigger,
        value: value.trim(),
        match: trigger === 'pageview' ? match : ('exact' as const),
        hostname: trigger === 'pageview' && hostname.trim() ? hostname.trim() : null,
        count,
        value_minor: parsedAmount === null ? null : Math.round(parsedAmount * 10 ** digits),
      } satisfies CreateConversionRuleInput;
      return rule
        ? api.conversions.update(siteId, rule.id, input)
        : api.conversions.create(siteId, { ...input, backfill });
    },
    {
      invalidate: [analyticsKeys.site(tenant, siteId, 'conversions')],
      success: rule ? 'analytics.conversions.updated' : 'analytics.conversions.created',
      onSuccess: (saved) => onSaved(saved),
    },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {rule ? t('analytics.conversions.editTitle') : t('analytics.conversions.newTitle')}
            </DialogTitle>
            <DialogDescription>{t('analytics.conversions.editorHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amb-conversion-name">{t('analytics.common.name')}</Label>
            <Input
              id="amb-conversion-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('analytics.conversions.namePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t('analytics.conversions.when')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={select}
                value={trigger}
                aria-label={t('analytics.conversions.trigger')}
                onChange={(event) =>
                  setTrigger(event.target.value === 'goal' ? 'goal' : 'pageview')
                }
              >
                <option value="pageview">{t('analytics.conversions.trigger.pageview')}</option>
                <option value="goal">{t('analytics.conversions.trigger.goal')}</option>
              </select>
              {trigger === 'pageview' ? (
                <select
                  className={select}
                  value={match}
                  aria-label={t('analytics.funnels.match')}
                  onChange={(event) =>
                    setMatch(
                      event.target.value === 'contains'
                        ? 'contains'
                        : event.target.value === 'starts_with'
                          ? 'starts_with'
                          : 'exact',
                    )
                  }
                >
                  <option value="exact">{t('analytics.conversions.match.exact')}</option>
                  <option value="starts_with">
                    {t('analytics.conversions.match.starts_with')}
                  </option>
                  <option value="contains">{t('analytics.conversions.match.contains')}</option>
                </select>
              ) : null}
              <Input
                className="h-8 min-w-48 flex-1 font-mono text-xs"
                value={value}
                maxLength={2048}
                aria-label={t('analytics.conversions.value')}
                placeholder={trigger === 'pageview' ? '/grazie' : 'signup'}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            <p className="text-[11.5px] text-muted-foreground">
              {trigger === 'pageview'
                ? t('analytics.conversions.pageHint')
                : t('analytics.conversions.goalHint')}
            </p>
          </div>
          {trigger === 'pageview' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-conversion-host">{t('analytics.conversions.hostname')}</Label>
              <Input
                id="amb-conversion-host"
                className="font-mono text-xs"
                value={hostname}
                maxLength={253}
                placeholder={t('analytics.conversions.hostnamePlaceholder')}
                onChange={(event) => setHostname(event.target.value)}
              />
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-conversion-count">{t('analytics.conversions.countLabel')}</Label>
              <select
                id="amb-conversion-count"
                className={cn(select, 'h-9')}
                value={count}
                onChange={(event) => setCount(event.target.value === 'every' ? 'every' : 'once')}
              >
                <option value="once">{t('analytics.conversions.count.once')}</option>
                <option value="every">{t('analytics.conversions.count.every')}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amb-conversion-value">
                {t('analytics.conversions.amount', { currency })}
              </Label>
              <Input
                id="amb-conversion-value"
                inputMode="decimal"
                value={amount}
                aria-invalid={!amountValid}
                placeholder={t('analytics.conversions.amountPlaceholder')}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
          </div>
          {rule ? null : (
            <label className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={backfill}
                onChange={(event) => setBackfill(event.target.checked)}
              />
              <span>
                {t('analytics.conversions.backfill')}
                <span className="block text-[11.5px] text-muted-foreground">
                  {t('analytics.conversions.backfillHint')}
                </span>
              </span>
            </label>
          )}
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton type="submit" variant="primary" disabled={!valid || save.isPending}>
              {t('common.save')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Kpis({ report }: { report: ConversionReport }) {
  const { t } = useI18n();
  const f = useFormatters();
  const items = [
    {
      label: t('analytics.conversions.kpi.conversions'),
      value: f.number(report.totals.conversions),
    },
    { label: t('analytics.conversions.kpi.persons'), value: f.number(report.totals.persons) },
    {
      label: t('analytics.kpi.conversionRate'),
      value: f.percent(report.totals.conversion_rate, 1),
    },
    {
      label: t('analytics.conversions.kpi.value'),
      value: f.money(report.totals.value_minor, report.currency),
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg bg-foreground/[0.035] px-3 py-2">
          <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
          <dd className="text-xl font-medium tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Breakdown({ report }: { report: ConversionReport }) {
  const { t } = useI18n();
  const f = useFormatters();
  const max = Math.max(1e-9, ...report.breakdown.map((row) => row.conversions));
  if (report.breakdown.length === 0)
    return <EmptyNote>{t('analytics.conversions.noData')}</EmptyNote>;
  return (
    <ul className="flex flex-col gap-1">
      {report.breakdown.map((row) => (
        <li
          key={row.value ?? '∅'}
          className="relative overflow-hidden rounded-md px-2 py-1.5 text-[13px]"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-md bg-primary/10"
            style={{ width: `${(row.conversions / max) * 100}%` }}
          />
          <div className="relative flex items-center justify-between gap-3">
            <span className="min-w-0 truncate" title={row.value ?? undefined}>
              {row.value === null ? (
                <span className="text-muted-foreground">{t('analytics.conversions.noSource')}</span>
              ) : (
                (row.label ?? row.value)
              )}
            </span>
            <span className="flex shrink-0 gap-3 tabular-nums text-muted-foreground">
              {row.value_minor > 0 ? (
                <span>{f.money(row.value_minor, report.currency)}</span>
              ) : null}
              <b className="font-medium text-foreground">
                {f.number(row.conversions, Number.isInteger(row.conversions) ? 0 : 1)}
              </b>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Recent({
  report,
  tenant,
  siteId,
}: {
  report: ConversionReport;
  tenant: string;
  siteId: string;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  if (report.recent.length === 0)
    return <EmptyNote>{t('analytics.conversions.noRecent')}</EmptyNote>;
  const cell = 'px-2 py-1.5 text-left align-top';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[12.5px]">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            <th className={cn(cell, 'font-normal')}>{t('analytics.conversions.col.when')}</th>
            <th className={cn(cell, 'font-normal')}>{t('analytics.conversions.col.rule')}</th>
            <th className={cn(cell, 'font-normal')}>{t('analytics.conversions.col.entry')}</th>
            <th className={cn(cell, 'font-normal')}>{t('analytics.conversions.col.source')}</th>
            <th className={cn(cell, 'font-normal')}>{t('analytics.conversions.col.ad')}</th>
            <th className={cn(cell, 'font-normal')}>{t('analytics.conversions.col.visitor')}</th>
          </tr>
        </thead>
        <tbody>
          {report.recent.map((row, index) => {
            const touch = row.last_non_direct_touch ?? row.first_touch;
            return (
              <tr key={`${row.ts}-${index}`} className="border-t border-foreground/[0.06]">
                <td className={cn(cell, 'whitespace-nowrap tabular-nums')}>{f.dateTime(row.ts)}</td>
                <td className={cell}>
                  <span className="font-medium">{row.rule_name}</span>
                  {row.trigger ? (
                    <span className="block font-mono text-[11px] text-muted-foreground">
                      {row.trigger}
                    </span>
                  ) : null}
                </td>
                <td className={cn(cell, 'font-mono text-[11.5px]')}>{row.entry_page ?? '—'}</td>
                <td className={cell}>
                  {touch ? (
                    <>
                      {touch.channel}
                      {touch.source || touch.campaign ? (
                        <span className="block text-[11px] text-muted-foreground">
                          {[touch.source, touch.campaign].filter(Boolean).join(' · ')}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={cn(cell, 'font-mono text-[11.5px]')}>
                  {row.ad_campaign ? (
                    <>
                      {row.ad_campaign}
                      {row.ad ? (
                        <span className="block text-muted-foreground">{row.ad}</span>
                      ) : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={cell}>
                  {row.visitor_id ? (
                    <Link
                      to="/t/$tenant/analytics/visitors/$visitorId"
                      params={{ tenant, visitorId: row.visitor_id }}
                      search={{ site: siteId }}
                      className="rounded bg-foreground/[0.05] px-1.5 py-0.5 font-mono text-[11px] hover:bg-primary/10 hover:text-primary"
                    >
                      {row.visitor_id.slice(0, 8)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConversionResults({
  state,
  rule,
  rules,
}: {
  state: AnalyticsState & { site: { id: string } };
  rule: ConversionRule | null;
  rules: readonly ConversionRule[];
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const [dimension, setDimension] = useState<ConversionDimension>('channel');
  const report = useConversionReport(state.tenant, state.site.id, state.query, {
    rule_id: rule?.id ?? null,
    dimension,
    model: state.model,
  });
  const data = report.data;
  return (
    <div className="flex min-w-0 flex-col gap-[7px]">
      <Panel title={rule?.name ?? t('analytics.conversions.all')}>
        {report.error ? (
          <ErrorState error={report.error} />
        ) : !data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            <Kpis report={data} />
            {rule === null && rules.length > 1 ? (
              <ul className="flex flex-wrap gap-1.5 text-[12px]">
                {data.rules.map((r) => (
                  <li key={r.rule_id} className="rounded-md bg-foreground/[0.04] px-2 py-1">
                    {r.name} <b className="font-medium tabular-nums">{f.number(r.conversions)}</b>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </Panel>
      <Panel
        title={t('analytics.conversions.byDimension')}
        actions={
          <DashboardFilterMenu
            label={t('analytics.conversions.dimension')}
            value={dimension}
            options={CONVERSION_DIMENSIONS.map((value) => ({
              value,
              label: dimensionLabel(t, value),
            }))}
            onValueChange={(value) => setDimension(value as ConversionDimension)}
          />
        }
      >
        {data ? <Breakdown report={data} /> : <ListSkeleton rows={4} />}
      </Panel>
      <Panel title={t('analytics.conversions.recent')}>
        {data ? (
          <Recent report={data} tenant={state.tenant} siteId={state.site.id} />
        ) : (
          <ListSkeleton rows={4} />
        )}
      </Panel>
    </div>
  );
}

function ConversionsBody({
  state,
}: {
  state: AnalyticsState & { site: { id: string; currency: string } };
}) {
  const { t } = useI18n();
  const { tenant } = state;
  const siteId = state.site.id;
  const permissions = useAnalyticsPermissions(tenant);
  const summary = useRuleSummary();
  const rules = useConversionRules(tenant, siteId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ConversionRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ConversionRule | null>(null);
  const api = analyticsApi(tenant);
  const remove = useAnalyticsMutation(tenant, (id: string) => api.conversions.remove(siteId, id), {
    invalidate: [analyticsKeys.site(tenant, siteId, 'conversions')],
    success: 'analytics.conversions.deleted',
  });

  if (rules.error) return <ErrorState error={rules.error} />;
  const list = rules.data?.data ?? [];
  const selected = list.find((rule) => rule.id === selectedId) ?? null;
  const item = (active: boolean) =>
    cn(
      'group flex items-center gap-2 rounded-lg px-2 py-1.5',
      active ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]',
    );

  return (
    <div className="grid grid-cols-1 gap-[7px] lg:grid-cols-[300px_minmax(0,1fr)]">
      <Panel
        title={t('analytics.conversions.title')}
        actions={
          permissions.editReports ? (
            <DashboardButton variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('analytics.conversions.new')}
            </DashboardButton>
          ) : null
        }
      >
        {!rules.data ? (
          <ListSkeleton rows={4} />
        ) : list.length === 0 ? (
          <EmptyNote>{t('analytics.conversions.empty')}</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-0.5">
            <li>
              <button
                type="button"
                className={cn(item(selected === null), 'w-full text-left text-[13px] font-medium')}
                onClick={() => setSelectedId(null)}
              >
                {t('analytics.conversions.all')}
              </button>
            </li>
            {list.map((rule) => (
              <li key={rule.id}>
                <div className={item(selected?.id === rule.id)}>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col text-left"
                    onClick={() => setSelectedId(rule.id)}
                  >
                    <span
                      className={cn(
                        'truncate text-[13px] font-medium',
                        !rule.enabled && 'text-muted-foreground line-through',
                      )}
                    >
                      {rule.name}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {summary(rule)}
                    </span>
                  </button>
                  {permissions.editReports ? (
                    <span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <DashboardButton
                        variant="ghost"
                        size="icon"
                        aria-label={t('analytics.common.edit')}
                        onClick={() => setEditing(rule)}
                      >
                        <Pencil aria-hidden />
                      </DashboardButton>
                      <DashboardButton
                        variant="ghost"
                        size="icon"
                        aria-label={t('analytics.common.delete')}
                        onClick={() => setDeleting(rule)}
                      >
                        <Trash2 aria-hidden />
                      </DashboardButton>
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {list.length > 0 ? (
        <ConversionResults state={state} rule={selected} rules={list} />
      ) : (
        <div
          className={cn(
            panelClass,
            'flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground',
          )}
        >
          <Target className="size-5" aria-hidden />
          <span className="max-w-md">{t('analytics.conversions.intro')}</span>
        </div>
      )}
      {editing ? (
        <RuleEditor
          tenant={tenant}
          siteId={siteId}
          currency={state.site.currency}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setSelectedId(saved.id);
          }}
        />
      ) : null}
      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('analytics.conversions.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('analytics.conversions.deleteBody')}
        confirmLabel={t('analytics.common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (deleting) {
            remove.mutate(deleting.id);
            if (selectedId === deleting.id) setSelectedId(null);
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * `/t/$tenant/analytics/conversions` — custom conversions ("reached page Y",
 * "completed goal Z"), credited to the landing page, channel, campaign and ad
 * of the sessions before them.
 */
export function AnalyticsConversionsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  return (
    <AnalyticsFrame tenant={tenant} tab="conversions" showModel showInterval={false}>
      {(state) => <ConversionsBody state={state} />}
    </AnalyticsFrame>
  );
}
