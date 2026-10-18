import type { FunnelGraphSummary, FunnelStatus, Site } from '@amable/api-types';
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
import { Label } from '@amable/ui/ui/label';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Copy, Pencil, Plus, Workflow } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { useAnalyticsMutation } from '../api';
import { funnelKeys, funnelsApi, useFunnelGraphs } from '../api-funnels';
import { AnalyticsFrame } from '../components/analytics-layout';
import { EmptyNote, ErrorState, ListSkeleton, Panel, Segmented } from '../components/ui';
import { blankFunnelInput } from '../funnel-builder/state';
import { useFormatters, useNow } from '../lib/format';
import { useAnalyticsPermissions } from '../lib/permissions';

function CreateFunnelDialog({
  tenant,
  site,
  onClose,
}: {
  tenant: string;
  site: Site;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const create = useAnalyticsMutation(
    tenant,
    () =>
      funnelsApi(tenant).funnels.create(
        site.id,
        blankFunnelInput(
          name.trim(),
          site.hostnames[0] ? `https://${site.hostnames[0]}/` : 'https://example.com/',
        ),
      ),
    {
      invalidate: [funnelKeys.graphs(tenant, site.id)],
      success: 'analytics.funnelsV2.created',
      onSuccess: (graph) =>
        void navigate({
          to: '/t/$tenant/analytics/funnels/$funnelId/builder',
          params: { tenant, funnelId: graph.id },
          search: { site: site.id },
        }),
    },
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('analytics.funnelsV2.newTitle')}</DialogTitle>
            <DialogDescription>{t('analytics.funnelsV2.newHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amb-funnel-v2-name">{t('analytics.common.name')}</Label>
            <Input
              id="amb-funnel-v2-name"
              value={name}
              maxLength={200}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton
              type="submit"
              variant="primary"
              disabled={!name.trim() || create.isPending}
            >
              {t('analytics.funnelsV2.create')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FunnelRow({
  tenant,
  site,
  funnel,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  funnel: FunnelGraphSummary;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const api = funnelsApi(tenant);
  const invalidate = [funnelKeys.graphs(tenant, site.id)];
  const duplicate = useAnalyticsMutation(tenant, () => api.funnels.duplicate(site.id, funnel.id), {
    invalidate,
    success: 'analytics.funnelsV2.duplicated',
  });
  const toggle = useAnalyticsMutation(
    tenant,
    () =>
      funnel.status === 'active'
        ? api.funnels.archive(site.id, funnel.id)
        : api.funnels.restore(site.id, funnel.id),
    {
      invalidate,
      success: funnel.status === 'active' ? 'analytics.funnelsV2.archived' : 'analytics.funnelsV2.restored',
    },
  );
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5" data-testid={`funnel-v2-${funnel.id}`}>
      <Workflow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to="/t/$tenant/analytics/funnels/$funnelId/builder"
          params={{ tenant, funnelId: funnel.id }}
          search={{ site: site.id }}
          className="truncate text-sm font-medium hover:underline"
        >
          {funnel.name}
        </Link>
        <span className="text-xs text-muted-foreground">
          {t('analytics.funnelsV2.meta', {
            nodes: funnel.node_count,
            version: funnel.version,
            when: f.relative(new Date(funnel.updated_at).toISOString(), now),
          })}
        </span>
      </div>
      <Button asChild variant="outline" size="sm" className="h-7 text-xs">
        <Link
          to="/t/$tenant/analytics/funnels/$funnelId/builder"
          params={{ tenant, funnelId: funnel.id }}
          search={{ site: site.id }}
        >
          <Pencil className="size-3.5" aria-hidden />
          {t('analytics.funnelsV2.open')}
        </Link>
      </Button>
      {canConfigure ? (
        <>
          <DashboardButton
            variant="ghost"
            size="sm"
            disabled={duplicate.isPending}
            onClick={() => duplicate.mutate(undefined)}
          >
            <Copy aria-hidden />
            {t('analytics.funnelsV2.duplicate')}
          </DashboardButton>
          <DashboardButton
            variant="ghost"
            size="sm"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(undefined)}
          >
            {funnel.status === 'active' ? <Archive aria-hidden /> : <ArchiveRestore aria-hidden />}
            {funnel.status === 'active'
              ? t('analytics.funnelsV2.archive')
              : t('analytics.funnelsV2.restore')}
          </DashboardButton>
        </>
      ) : null}
    </li>
  );
}

function FunnelList({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const permissions = useAnalyticsPermissions(tenant);
  const [status, setStatus] = useState<FunnelStatus>('active');
  const [creating, setCreating] = useState(false);
  const list = useFunnelGraphs(tenant, site.id, status);
  return (
    <Panel
      title={t('analytics.funnelsV2.title')}
      actions={
        <>
          <Segmented
            label={t('analytics.funnelsV2.status')}
            options={[
              { value: 'active', label: t('analytics.funnelsV2.status.active') },
              { value: 'archived', label: t('analytics.funnelsV2.status.archived') },
            ]}
            value={status}
            onChange={setStatus}
          />
          {permissions.configure ? (
            <DashboardButton variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('analytics.funnelsV2.new')}
            </DashboardButton>
          ) : null}
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">{t('analytics.funnelsV2.hint')}</p>
      {list.error ? (
        <ErrorState error={list.error} />
      ) : !list.data ? (
        <ListSkeleton rows={3} />
      ) : list.data.data.length === 0 ? (
        <EmptyNote>
          {status === 'active' ? t('analytics.funnelsV2.empty') : t('analytics.funnelsV2.emptyArchived')}
        </EmptyNote>
      ) : (
        <ul className="flex flex-col divide-y divide-foreground/[0.06]">
          {list.data.data.map((funnel) => (
            <FunnelRow
              key={funnel.id}
              tenant={tenant}
              site={site}
              funnel={funnel}
              canConfigure={permissions.configure}
            />
          ))}
        </ul>
      )}
      {creating ? (
        <CreateFunnelDialog tenant={tenant} site={site} onClose={() => setCreating(false)} />
      ) : null}
    </Panel>
  );
}

/** `/t/$tenant/analytics/funnels-v2` — visual funnels (traffic routing graphs) of a site. */
export function AnalyticsFunnelsV2Page() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  return (
    <AnalyticsFrame
      tenant={tenant}
      tab={null}
      title={t('analytics.funnelsV2.title')}
      hideRange
      showFilters={false}
      showSegments={false}
    >
      {({ site }) => <FunnelList key={site.id} tenant={tenant} site={site} />}
    </AnalyticsFrame>
  );
}
