import type { BroadcastSummary } from '@amable/api-types';
import { DashboardButton, ListTable, PageToolbar, usePageChrome, type ListTableColumn } from '@amable/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { emailKeys, useEmailApi, useEmailMutation, usePermissions } from '../../email/api';
import { BroadcastStatusBadge, formatDateTime, percent } from '../../email/components';

const BLANK_DOC = {
  type: 'doc' as const,
  content: [
    { type: 'paragraph' },
    { type: 'emailFooter', attrs: { unsubscribeLabel: 'Unsubscribe' }, content: [{ type: 'paragraph' }] },
  ],
};

export function BroadcastsListPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const navigate = useNavigate();
  usePageChrome({ title: t('broadcasts.title') });
  const list = useQuery({ queryKey: emailKeys.broadcasts(slug), queryFn: () => api.broadcasts.list(), refetchInterval: 15_000 });
  const open = (id: string) => void navigate({ to: '/t/$tenant/broadcasts/$broadcastId', params: { tenant: slug, broadcastId: id } });
  const create = useEmailMutation({
    mutationFn: () => api.broadcasts.create({ name: t('broadcasts.untitled'), body: BLANK_DOC }),
    invalidate: [emailKeys.broadcasts(slug)],
    onSuccess: (b) => open(b.id),
  });
  const remove = useEmailMutation({
    mutationFn: async (rows: BroadcastSummary[]) => {
      for (const row of rows) await api.broadcasts.remove(row.id);
    },
    invalidate: [emailKeys.broadcasts(slug)],
  });
  const rate = (n: number, d: number) => (d === 0 ? '—' : `${percent(n / d)}%`);
  const columns: ListTableColumn<BroadcastSummary>[] = [
    { id: 'name', header: t('email.common.name'), cell: (row) => <span className="font-medium">{row.name}</span>, sortable: true, sortValue: (r) => r.name },
    { id: 'status', header: t('email.common.status'), cell: (row) => <BroadcastStatusBadge status={row.status} /> },
    { id: 'recipients', header: t('broadcasts.recipients'), align: 'right', cell: (row) => row.progress.recipients || '—', hideBelow: 'md' },
    { id: 'sent', header: t('broadcasts.sent'), align: 'right', cell: (row) => row.stats.sent, sortable: true, sortValue: (r) => r.stats.sent },
    { id: 'opened', header: t('broadcasts.opened'), align: 'right', cell: (row) => rate(row.stats.opened, row.stats.sent), hideBelow: 'lg' },
    { id: 'clicked', header: t('broadcasts.clicked'), align: 'right', cell: (row) => rate(row.stats.clicked, row.stats.sent), hideBelow: 'lg' },
    { id: 'created', header: t('email.common.created'), cell: (row) => formatDateTime(locale, row.created_at), sortable: true, sortValue: (r) => r.created_at, hideBelow: 'xl' },
  ];
  return (
    <>
      <PageToolbar
        actions={
          can('broadcasts:write') ? (
            <DashboardButton variant="primary" onClick={() => create.mutate(undefined)} disabled={create.isPending}>
              <Plus className="size-4" />
              {t('broadcasts.new')}
            </DashboardButton>
          ) : null
        }
      />
      <ListTable<BroadcastSummary>
        rows={list.data?.data ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        columns={columns}
        labels={listTableLabels(t)}
        loading={list.isPending}
        defaultSort={{ columnId: 'created', direction: 'desc' }}
        onRowOpen={(row) => open(row.id)}
        {...(can('broadcasts:write')
          ? { deletion: { onDelete: (rows: BroadcastSummary[]) => remove.mutateAsync(rows), confirm: true } }
          : {})}
        emptyState={<p className="py-10 text-center text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('broadcasts.empty')}</p>}
      />
    </>
  );
}
