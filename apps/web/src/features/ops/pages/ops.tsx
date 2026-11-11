import type { OpsStatus } from '@amable/api-types';
import { formatDateTime } from '@amable/i18n/client';
import { DashboardButton, PageBody, usePageChrome } from '@amable/ui';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { Pill, SectionCard, type Tone } from '../../../components/feature-kit';
import { PageState } from '../../crm/components/states';
import { useI18n } from '../../../i18n';
import { apiErrorMessage, useApiMutation } from '../../../lib/feature-hooks';
import { opsApi, opsKeys } from '../api';

/** Tracking silent this long reads as a warning (sites with traffic send events every minute). */
const SILENT_MS = 60 * 60_000;

export function OpsPage() {
  const { t } = useI18n();
  usePageChrome({ title: t('ops.title') });
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  const status = useQuery({
    queryKey: opsKeys.status(slug),
    queryFn: () => opsApi.status(slug),
    refetchInterval: 60_000,
  });
  return (
    <PageBody className="grid gap-4 pt-4">
      <p className="text-sm text-muted-foreground">{t('ops.intro')}</p>
      <PageState isPending={status.isPending} error={status.error}>
        {() => <OpsView slug={slug} status={status.data!} />}
      </PageState>
    </PageBody>
  );
}

function OpsView({ slug, status }: { slug: string; status: OpsStatus }) {
  const { t, locale } = useI18n();
  const when = (ts: number | null) => (ts === null ? t('ops.never') : formatDateTime(locale, ts));
  const replay = useApiMutation(
    {
      mutationFn: () => opsApi.replayRegistry(slug),
      success: (r) =>
        [
          t(r.remaining ? 'ops.registry.replayedMore' : 'ops.registry.replayed', { n: r.replayed }),
          ...(r.failed > 0 ? [t('ops.registry.failedAgain', { n: r.failed })] : []),
        ].join(' · '),
    },
    opsKeys.status(slug),
    (tr, error) =>
      apiErrorMessage(tr, error, {
        forbidden: 'ops.forbidden',
        notFound: 'ops.forbidden',
        validation: 'common.error',
      }),
  );
  const { registry } = status;
  const now = Date.now();

  return (
    <>
      <SectionCard
        title={t('ops.registry.title')}
        actions={
          registry.parked > 0 ? (
            <DashboardButton
              size="sm"
              variant="primary"
              disabled={replay.isPending}
              onClick={() => replay.mutate(undefined)}
            >
              <RefreshCw className="size-4" />
              {t('ops.registry.replay')}
            </DashboardButton>
          ) : undefined
        }
      >
        {registry.parked === 0 ? (
          <Pill tone="success">{t('ops.registry.empty')}</Pill>
        ) : (
          <div className="grid gap-2 text-sm">
            <Pill tone="warning">
              {t(registry.truncated ? 'ops.registry.parkedMore' : 'ops.registry.parked', {
                n: registry.parked,
              })}
            </Pill>
            <p className="text-muted-foreground">
              {t('ops.registry.hint', { at: when(registry.oldest_at) })}
            </p>
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('ops.sites.title')}>
        {status.sites.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.sites.empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('ops.sites.site')}</TableHead>
                <TableHead>{t('ops.sites.lastEvent')}</TableHead>
                <TableHead>{t('ops.sites.pending')}</TableHead>
                <TableHead>{t('ops.sites.stale')}</TableHead>
                <TableHead>{t('ops.sites.poison')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.sites.map((s) => {
                const silent = s.last_event_at === null || s.last_event_at < now - SILENT_MS;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>
                      <Pill tone={silent ? 'warning' : 'success'}>{when(s.last_event_at)}</Pill>
                    </TableCell>
                    <TableCell>{s.pending_segments}</TableCell>
                    <TableCell>
                      <Count n={s.stale_segments} tone="warning" />
                    </TableCell>
                    <TableCell>
                      <Count n={s.poison_objects} tone="danger" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {status.sites.some((s) => s.stale_segments + s.poison_objects > 0) && (
          <p className="mt-2 text-sm text-muted-foreground">{t('ops.sites.manual')}</p>
        )}
      </SectionCard>

      <div className="grid gap-4 md:grid-cols-3">
        <SectionCard title={t('ops.backups.title')}>
          <p className="text-sm">
            {status.backups.last_at === null
              ? t('ops.backups.none')
              : t('ops.backups.last', {
                  at: formatDateTime(locale, new Date(status.backups.last_at)),
                  n: status.backups.count,
                })}
          </p>
        </SectionCard>
      </div>
    </>
  );
}

function Count({ n, tone }: { n: number; tone: Tone }) {
  return n === 0 ? <span>0</span> : <Pill tone={tone}>{n}</Pill>;
}
