import type { Site, TrafficSource } from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import { useParams } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Megaphone, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useAnalyticsMutation } from '../api';
import { funnelKeys, funnelsApi, useTrafficSources } from '../api-funnels';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, ListSkeleton, Panel, Segmented, StatusPill } from '../components/ui';
import { useAnalyticsPermissions } from '../lib/permissions';
import { SourceEditorDialog } from '../sources/source-editor';
import { TemplateGalleryDialog } from '../sources/template-gallery';
import { toDraft, type SourceDraft } from '../sources/tracking-fields';

type Editing = { source?: TrafficSource; draft: SourceDraft } | null;

function SourceRow({
  tenant,
  site,
  source,
  canConfigure,
  onEdit,
}: {
  tenant: string;
  site: Site;
  source: TrafficSource;
  canConfigure: boolean;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const api = funnelsApi(tenant);
  const active = source.status === 'active';
  const toggle = useAnalyticsMutation(
    tenant,
    () => (active ? api.sources.archive(site.id, source.id) : api.sources.restore(site.id, source.id)),
    {
      invalidate: [funnelKeys.sources(tenant, site.id)],
      success: active ? 'analytics.sources.archived' : 'analytics.sources.restored',
    },
  );
  const delivery = source.conversion.ad_connection_id
    ? t('analytics.sources.conversion.mode.integration')
    : source.conversion.postback_url
      ? t('analytics.sources.conversion.mode.postback')
      : t('analytics.sources.conversion.mode.none');
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5" data-testid={`traffic-source-${source.id}`}>
      <Megaphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="truncate font-medium">{source.name}</span>
          {source.category ? <StatusPill tone="neutral">{source.category}</StatusPill> : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('analytics.sources.meta', {
            fields: source.fields.length,
            cost: t(`analytics.sources.costType.${source.cost_type}`),
            delivery,
          })}
          <code className="ml-2 font-mono text-[10.5px]">{source.id}</code>
        </span>
      </div>
      {canConfigure ? (
        <>
          <DashboardButton variant="secondary" size="sm" onClick={onEdit}>
            <Pencil aria-hidden />
            {t('analytics.common.edit')}
          </DashboardButton>
          <DashboardButton
            variant="ghost"
            size="sm"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(undefined)}
          >
            {active ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
            {active ? t('analytics.sources.archive') : t('analytics.sources.restore')}
          </DashboardButton>
        </>
      ) : null}
    </li>
  );
}

function SourceList({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const permissions = useAnalyticsPermissions(tenant);
  const [status, setStatus] = useState<TrafficSource['status']>('active');
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const sources = useTrafficSources(tenant, site.id, status);
  return (
    <Panel
      title={t('analytics.sources.title')}
      actions={
        <>
          <Segmented
            label={t('analytics.sources.status')}
            options={[
              { value: 'active', label: t('analytics.sources.status.active') },
              { value: 'archived', label: t('analytics.sources.status.archived') },
            ]}
            value={status}
            onChange={setStatus}
          />
          {permissions.configure ? (
            <DashboardButton variant="primary" onClick={() => setPicking(true)}>
              <Plus aria-hidden />
              {t('analytics.sources.new')}
            </DashboardButton>
          ) : null}
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">{t('analytics.sources.hint')}</p>
      {sources.error ? (
        <ErrorState error={sources.error} />
      ) : !sources.data ? (
        <ListSkeleton rows={3} />
      ) : sources.data.length === 0 ? (
        <EmptyNote>
          {status === 'active' ? t('analytics.sources.empty') : t('analytics.sources.emptyArchived')}
        </EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {sources.data.map((source) => (
            <SourceRow
              key={source.id}
              tenant={tenant}
              site={site}
              source={source}
              canConfigure={permissions.configure}
              onEdit={() => setEditing({ source, draft: toDraft(source) })}
            />
          ))}
        </ul>
      )}
      {picking ? (
        <TemplateGalleryDialog
          tenant={tenant}
          onClose={() => setPicking(false)}
          onPick={(template) => {
            setPicking(false);
            setEditing({ draft: toDraft(template.source) });
          }}
        />
      ) : null}
      {editing ? (
        <SourceEditorDialog
          tenant={tenant}
          site={site}
          {...(editing.source ? { source: editing.source } : {})}
          initial={editing.draft}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Panel>
  );
}

/** `/t/$tenant/analytics/sources` — traffic sources: templates, tracking fields, conversions. */
export function AnalyticsSourcesPage() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab={null}
      title={t('analytics.sources.title')}
      hideRange
      showFilters={false}
      showSegments={false}
    >
      {({ site }) => <SourceList key={site.id} tenant={tenant} site={site} />}
    </AnalyticsFrame>
  );
}
