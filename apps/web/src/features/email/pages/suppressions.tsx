import type { Suppression, SuppressionReason } from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import { DashboardButton, ListTable, PageToolbar, usePageChrome, type ListTableColumn } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { emailKeys, useEmailApi, useEmailMutation, usePermissions } from '../api';
import { formatDateTime } from '../components';

const REASON_KEYS: Readonly<Record<SuppressionReason, MessageKey>> = {
  unsubscribe: 'email.suppressions.reason.unsubscribe',
  bounce: 'email.suppressions.reason.bounce',
  complaint: 'email.suppressions.reason.complaint',
  manual: 'email.suppressions.reason.manual',
};

function AddDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const [email, setEmail] = useState('');
  const add = useEmailMutation({
    mutationFn: () => api.suppressions.add({ email: email.trim(), reason: 'manual' }),
    invalidate: [emailKeys.all(slug)],
    success: t('email.common.saved'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (email.includes('@')) add.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('email.suppressions.add')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="supp-email">{t('email.suppressions.email')}</Label>
            <Input id="supp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('email.common.cancel')}
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {t('email.common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SuppressionsPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  usePageChrome({ title: t('email.suppressions.title') });
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);
  const pages = useInfiniteQuery({
    queryKey: emailKeys.suppressions(slug, debounced),
    queryFn: ({ pageParam }) => api.suppressions.list(debounced, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const remove = useEmailMutation({
    mutationFn: async (rows: Suppression[]) => {
      for (const row of rows) await api.suppressions.remove(row.email);
    },
    invalidate: [emailKeys.all(slug)],
  });
  const rows = pages.data?.pages.flatMap((p) => p.data) ?? [];
  const columns: ListTableColumn<Suppression>[] = [
    { id: 'email', header: t('email.suppressions.email'), cell: (row) => <span className="font-medium">{row.email}</span>, sortable: true, sortValue: (r) => r.email },
    { id: 'reason', header: t('email.suppressions.reason'), cell: (row) => <Badge variant={row.reason === 'manual' ? 'outline' : 'secondary'}>{t(REASON_KEYS[row.reason])}</Badge> },
    { id: 'source', header: t('email.suppressions.source'), cell: (row) => row.source ?? '—', hideBelow: 'md' },
    { id: 'created', header: t('email.common.created'), cell: (row) => formatDateTime(locale, row.created_at), sortable: true, sortValue: (r) => r.created_at, hideBelow: 'lg' },
  ];
  return (
    <>
      <PageToolbar
        filters={<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('email.suppressions.search')} className="h-8 w-64" />}
        actions={
          can('suppressions:write') ? (
            <DashboardButton variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              {t('email.suppressions.add')}
            </DashboardButton>
          ) : null
        }
      />
      <ListTable<Suppression>
        rows={rows}
        getRowId={(row) => row.email}
        getRowLabel={(row) => row.email}
        columns={columns}
        labels={listTableLabels(t)}
        loading={pages.isPending}
        defaultSort={{ columnId: 'created', direction: 'desc' }}
        {...(can('suppressions:write') ? { deletion: { onDelete: (r: Suppression[]) => remove.mutateAsync(r), confirm: true } } : {})}
        emptyState={<p className="py-10 text-center text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('email.suppressions.empty')}</p>}
        footer={
          pages.hasNextPage ? (
            <div className="flex justify-center p-3">
              <Button variant="outline" size="sm" onClick={() => void pages.fetchNextPage()}>
                {t('email.common.loadMore')}
              </Button>
            </div>
          ) : null
        }
      />
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
