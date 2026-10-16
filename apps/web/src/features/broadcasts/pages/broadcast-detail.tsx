import type { Broadcast, BroadcastStats } from '@amable/api-types';
import {
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  PageToolbar,
  usePageChrome,
} from '@amable/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Progress } from '@amable/ui/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@amable/ui/ui/table';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, Pause, Play, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { emailKeys, useEmailApi, useEmailMutation, usePermissions } from '../../email/api';
import { blockText, BroadcastStatusBadge, formatDateTime, percent } from '../../email/components';
import { BroadcastWizard } from './broadcast-wizard';

export function BroadcastDetailPage() {
  const { broadcastId } = useParams({ strict: false });
  const id = broadcastId ?? '';
  const { slug, api } = useEmailApi();
  const broadcast = useQuery({
    queryKey: emailKeys.broadcast(slug, id),
    queryFn: () => api.broadcasts.get(id),
    refetchInterval: (query) => (query.state.data?.status === 'sending' || query.state.data?.status === 'scheduled' ? 5_000 : false),
  });
  const { t } = useI18n();
  usePageChrome({ title: broadcast.data?.name ?? t('broadcasts.title') });
  if (broadcast.data === undefined) return null;
  return broadcast.data.status === 'draft' ? (
    <BroadcastWizard key={broadcast.data.id} broadcast={broadcast.data} />
  ) : (
    <Report broadcast={broadcast.data} />
  );
}

function BackLink() {
  const { t } = useI18n();
  const { slug } = useEmailApi();
  return (
    <Link to="/t/$tenant/broadcasts" params={{ tenant: slug }} className="inline-flex items-center gap-1 text-sm">
      <ArrowLeft className="size-4" />
      {t('email.common.back')}
    </Link>
  );
}

// -------------------------------------------------------------------- report

function Stat({ label, value, rate }: { label: string; value: number; rate?: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {rate !== undefined ? <p className="text-xs tabular-nums">{percent(rate)}%</p> : null}
    </div>
  );
}

function Report({ broadcast }: { broadcast: Broadcast }) {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const [cancelOpen, setCancelOpen] = useState(false);
  const live = broadcast.status === 'sending' || broadcast.status === 'scheduled';
  const stats = useQuery<BroadcastStats>({
    queryKey: emailKeys.stats(slug, broadcast.id),
    queryFn: () => api.broadcasts.stats(broadcast.id),
    refetchInterval: live ? 5_000 : 30_000,
  });
  const action = useEmailMutation({
    mutationFn: (which: 'pause' | 'resume' | 'cancel') => api.broadcasts.action(broadcast.id, which),
    invalidate: [emailKeys.broadcast(slug, broadcast.id), emailKeys.broadcasts(slug), emailKeys.stats(slug, broadcast.id)],
    errorText: (code) => t('email.common.error', { message: blockText(t, code) }),
  });
  const s = stats.data;
  const p = broadcast.progress;
  const canSend = can('broadcasts:send');
  return (
    <>
      <PageToolbar
        filters={
          <span className="flex items-center gap-3">
            <BackLink />
            <BroadcastStatusBadge status={broadcast.status} />
          </span>
        }
        actions={
          canSend ? (
            <>
              {live ? (
                <DashboardButton onClick={() => action.mutate('pause')}>
                  <Pause className="size-4" />
                  {t('broadcasts.report.pause')}
                </DashboardButton>
              ) : null}
              {broadcast.status === 'paused' ? (
                <DashboardButton onClick={() => action.mutate('resume')}>
                  <Play className="size-4" />
                  {t('broadcasts.report.resume')}
                </DashboardButton>
              ) : null}
              {live || broadcast.status === 'paused' ? (
                <DashboardButton onClick={() => setCancelOpen(true)}>
                  <XCircle className="size-4" />
                  {t('broadcasts.report.cancel')}
                </DashboardButton>
              ) : null}
            </>
          ) : null
        }
      />
      <PageBody className="grid gap-4 pt-4">
        <Card>
          <CardContent className="grid gap-2 pt-6 text-sm">
            <p>{t('broadcasts.report.progress', { enqueued: p.enqueued, total: p.recipients })}</p>
            <Progress value={p.recipients === 0 ? 0 : (p.enqueued / p.recipients) * 100} />
            {broadcast.next_send_at !== null && live ? (
              <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
                {t('broadcasts.report.nextSend', { time: formatDateTime(locale, broadcast.next_send_at) })}
              </p>
            ) : null}
          </CardContent>
        </Card>
        {s ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label={t('broadcasts.sent')} value={s.totals.sent} />
            <Stat label={t('broadcasts.report.delivered')} value={s.totals.delivered} rate={s.rates.delivery} />
            <Stat label={t('broadcasts.opened')} value={s.totals.opened} rate={s.rates.open} />
            <Stat label={t('broadcasts.clicked')} value={s.totals.clicked} rate={s.rates.click} />
            <Stat label={t('broadcasts.report.bounced')} value={s.totals.bounced} rate={s.rates.bounce} />
            <Stat label={t('broadcasts.report.unsubscribed')} value={s.totals.unsubscribed} rate={s.rates.unsubscribe} />
            <Stat label={t('broadcasts.report.complained')} value={s.totals.complained} />
            <Stat label={t('broadcasts.report.skipped')} value={s.totals.skipped + s.totals.failed} />
          </div>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.report.links')}</CardTitle>
          </CardHeader>
          <CardContent>
            {s && s.links.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('broadcasts.report.url')}</TableHead>
                    <TableHead className="text-right">{t('broadcasts.report.clicks')}</TableHead>
                    <TableHead className="text-right">{t('broadcasts.report.uniqueClicks')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.links.map((link) => (
                    <TableRow key={link.url}>
                      <TableCell className="max-w-md truncate font-mono text-xs">{link.url}</TableCell>
                      <TableCell className="text-right tabular-nums">{link.clicks}</TableCell>
                      <TableCell className="text-right tabular-nums">{link.unique_clicks}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('broadcasts.report.noLinks')}</p>
            )}
          </CardContent>
        </Card>
      </PageBody>
      <DashboardConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('broadcasts.report.cancel')}
        description={t('broadcasts.report.cancelConfirm')}
        confirmLabel={t('broadcasts.report.cancel')}
        cancelLabel={t('email.common.cancel')}
        onConfirm={() => action.mutate('cancel')}
      />
    </>
  );
}
