import type { Funnel, FunnelResult } from '@amable/api-types';
import { cn, DashboardButton, DashboardConfirmDialog } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useParams, useSearch } from '@tanstack/react-router';
import { Filter, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import {
  analyticsApi,
  analyticsKeys,
  useAnalyticsMutation,
  useFunnelResult,
  useFunnels,
} from '../api';
import { AnalyticsFrame } from '../components/analytics-layout';
import { FunnelEditor } from '../components/funnel-editor';
import { useReportScope } from '../components/scope';
import { EmptyNote, ErrorState, ListSkeleton, Panel, panelClass } from '../components/ui';
import { useFormatters } from '../lib/format';
import { useAnalyticsPermissions } from '../lib/permissions';

function FunnelChart({ result }: { result: FunnelResult }) {
  const { t } = useI18n();
  const f = useFormatters();
  const first = Math.max(1, result.steps[0]?.visitors ?? result.entered);
  return (
    <ol className="flex flex-col gap-3">
      {result.steps.map((step, index) => (
        <li key={step.index} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/12 text-[11px] font-medium text-primary">
                {index + 1}
              </span>
              <span className="truncate font-medium">{step.label}</span>
            </span>
            <span className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
              <span>
                <b className="font-medium text-foreground">{f.number(step.visitors)}</b>{' '}
                {t('analytics.funnels.visitorsShort')}
              </span>
              <span>{f.percent(step.conversion_rate, 1)}</span>
            </span>
          </div>
          <div className="relative h-9 overflow-hidden rounded-lg bg-foreground/[0.04]">
            <div
              className="absolute inset-y-0 left-0 rounded-lg bg-gradient-to-r from-primary/80 to-primary transition-[width] duration-700 ease-out"
              style={{ width: `${Math.max(0.8, (step.visitors / first) * 100)}%` }}
            />
            {index > 0 ? (
              <div
                className="absolute inset-y-0 rounded-r-lg bg-destructive/10"
                style={{
                  left: `${(step.visitors / first) * 100}%`,
                  width: `${(step.dropoff / first) * 100}%`,
                }}
              />
            ) : null}
          </div>
          {index > 0 ? (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px] text-muted-foreground">
              <span>
                {t('analytics.funnels.stepConversion', {
                  value: f.percent(step.step_conversion_rate, 1),
                })}
              </span>
              <span className="text-destructive/90">
                {t('analytics.funnels.dropoff', { count: f.number(step.dropoff) })}
              </span>
              {step.median_ms_from_previous !== null ? (
                <span>
                  {t('analytics.funnels.medianTime', {
                    value: f.duration(step.median_ms_from_previous),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function FunnelResults({
  tenant,
  siteId,
  funnel,
}: {
  tenant: string;
  siteId: string;
  funnel: Funnel;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const { query } = useReportScope();
  const result = useFunnelResult(tenant, siteId, funnel.id, query);
  return (
    <Panel title={funnel.name}>
      {result.error ? (
        <ErrorState error={result.error} />
      ) : !result.data ? (
        <div className="flex flex-col gap-3">
          {funnel.steps.map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-3 gap-2">
            {[
              { label: t('analytics.funnels.entered'), value: f.number(result.data.entered) },
              { label: t('analytics.funnels.completed'), value: f.number(result.data.completed) },
              {
                label: t('analytics.kpi.conversionRate'),
                value: f.percent(result.data.conversion_rate, 1),
              },
            ].map((item) => (
              <div key={item.label} className="rounded-lg bg-foreground/[0.035] px-3 py-2">
                <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
                <dd className="text-xl font-medium tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
          {result.data.entered === 0 ? (
            <EmptyNote>{t('analytics.funnels.noEntries')}</EmptyNote>
          ) : (
            <FunnelChart result={result.data} />
          )}
        </div>
      )}
    </Panel>
  );
}

function FunnelsBody({ tenant, siteId }: { tenant: string; siteId: string }) {
  const { t } = useI18n();
  const permissions = useAnalyticsPermissions(tenant);
  const search: { funnel?: string } = useSearch({ strict: false });
  const funnels = useFunnels(tenant, siteId);
  const [selectedId, setSelectedId] = useState<string | null>(search.funnel ?? null);
  const [editing, setEditing] = useState<Funnel | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Funnel | null>(null);
  const api = analyticsApi(tenant);
  const remove = useAnalyticsMutation(tenant, (id: string) => api.funnels.remove(siteId, id), {
    invalidate: [analyticsKeys.site(tenant, siteId, 'funnels')],
    success: 'analytics.funnels.deleted',
  });

  if (funnels.error) return <ErrorState error={funnels.error} />;
  const list = funnels.data?.data ?? [];
  const selected = list.find((funnel) => funnel.id === selectedId) ?? list[0] ?? null;

  return (
    <div className="grid grid-cols-1 gap-[7px] lg:grid-cols-[300px_minmax(0,1fr)]">
      <Panel
        title={t('analytics.funnels.title')}
        actions={
          permissions.editReports ? (
            <DashboardButton variant="primary" size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('analytics.funnels.new')}
            </DashboardButton>
          ) : null
        }
      >
        {!funnels.data ? (
          <ListSkeleton rows={4} />
        ) : list.length === 0 ? (
          <EmptyNote>{t('analytics.funnels.empty')}</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {list.map((funnel) => (
              <li key={funnel.id}>
                <div
                  className={cn(
                    'group flex items-center gap-2 rounded-lg px-2 py-1.5',
                    selected?.id === funnel.id ? 'bg-primary/10' : 'hover:bg-foreground/[0.04]',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col text-left"
                    onClick={() => setSelectedId(funnel.id)}
                  >
                    <span className="truncate text-[13px] font-medium">{funnel.name}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t('analytics.funnels.stepsCount', { count: funnel.steps.length })}
                    </span>
                  </button>
                  {permissions.editReports ? (
                    <span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <DashboardButton
                        variant="ghost"
                        size="icon"
                        aria-label={t('analytics.common.edit')}
                        onClick={() => setEditing(funnel)}
                      >
                        <Pencil aria-hidden />
                      </DashboardButton>
                      <DashboardButton
                        variant="ghost"
                        size="icon"
                        aria-label={t('analytics.common.delete')}
                        onClick={() => setDeleting(funnel)}
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
      {selected ? (
        <FunnelResults tenant={tenant} siteId={siteId} funnel={selected} />
      ) : (
        <div
          className={cn(
            panelClass,
            'flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground',
          )}
        >
          <Filter className="size-5" aria-hidden />
          {t('analytics.funnels.pick')}
        </div>
      )}
      {editing ? (
        <FunnelEditor
          tenant={tenant}
          siteId={siteId}
          funnel={editing === 'new' ? null : editing}
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
        title={t('analytics.funnels.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('analytics.funnels.deleteBody')}
        confirmLabel={t('analytics.common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

export function AnalyticsFunnelsPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  return (
    <AnalyticsFrame tenant={tenant} tab="funnels" showInterval={false}>
      {(state) => <FunnelsBody tenant={tenant} siteId={state.site.id} />}
    </AnalyticsFrame>
  );
}
