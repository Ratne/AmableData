import type { CheckoutSummary } from '@amable/api-types';
import { defaultCheckoutDefinition } from '@amable/checkout';
import {
  DashboardButton,
  DashboardFilterMenu,
  ListTable,
  PageBody,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
  type ListTableRowAction,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Copy, Pencil, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { commerceKeys, useCommerce, useCommerceMutation, useCommerceSettings, useDates, useMoney, usePermissions } from '../api/hooks';
import { ErrorNotice, FormField, Pill, type Tone } from '../components/common';

type StatusFilter = 'all' | 'draft' | 'active' | 'archived';

const STATUS_TONE: Record<CheckoutSummary['status'], Tone> = { draft: 'warning', active: 'success', archived: 'neutral' };

export function CheckoutsPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const money = useMoney();
  const settings = useCommerceSettings();
  const { dateTime } = useDates();
  usePageChrome({ title: t('nav.checkouts') });
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [creating, setCreating] = useState(false);
  const writable = can('checkouts:write');
  const currency = settings.data?.default_currency ?? 'EUR';

  const checkouts = useQuery({
    queryKey: [...commerceKeys.checkouts(slug), filter],
    queryFn: async () => (await api.checkouts.list({ limit: 200, ...(filter === 'all' ? {} : { status: filter }) })).data,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: commerceKeys.checkouts(slug) });
  const open = (checkout: { id: string }) =>
    void navigate({ to: '/t/$tenant/checkouts/$checkoutId', params: { tenant: slug, checkoutId: checkout.id } });

  const duplicate = useCommerceMutation({
    mutationFn: (id: string) => api.checkouts.duplicate(id),
    success: t('checkout.list.duplicated'),
  });

  const columns: ListTableColumn<CheckoutSummary>[] = [
    {
      id: 'name',
      header: t('commerce.field.name'),
      cell: (c) => <span className="truncate font-medium">{c.name}</span>,
      sortable: true,
      sortValue: (c) => c.name.toLowerCase(),
    },
    {
      id: 'status',
      header: t('commerce.field.status'),
      cell: (c) => <Pill tone={STATUS_TONE[c.status]}>{t(`checkout.status.${c.status}`)}</Pill>,
    },
    {
      id: 'paid',
      header: t('checkout.field.paid'),
      cell: (c) => `${c.stats.paid.toLocaleString(locale)} / ${c.stats.sessions.toLocaleString(locale)}`,
      align: 'right',
      sortable: true,
      sortValue: (c) => c.stats.paid,
    },
    {
      id: 'revenue',
      header: t('checkout.field.revenue'),
      cell: (c) => money(c.stats.revenue_minor, currency),
      align: 'right',
      sortable: true,
      sortValue: (c) => c.stats.revenue_minor,
    },
    {
      id: 'content',
      header: t('checkout.field.content'),
      cell: (c) =>
        t('checkout.list.content', { items: c.item_count, bumps: c.bump_count, offers: c.offer_count }),
      hideBelow: 'lg',
    },
    {
      id: 'updated',
      header: t('checkout.field.updated'),
      cell: (c) => dateTime(c.updated_at),
      sortable: true,
      sortValue: (c) => c.updated_at,
      hideBelow: 'md',
    },
  ];

  const rowActions = (checkout: CheckoutSummary): ListTableRowAction<CheckoutSummary>[] => [
    { id: 'edit', label: t('commerce.common.edit'), icon: Pencil, onSelect: () => open(checkout) },
    ...(writable
      ? [{ id: 'duplicate', label: t('checkout.action.duplicate'), icon: Copy, separatorBefore: true, onSelect: () => duplicate.mutate(checkout.id) }]
      : []),
  ];

  return (
    <>
      <PageToolbar
        filters={
          <DashboardFilterMenu
            label={t('commerce.field.status')}
            value={filter}
            onValueChange={(value) => setFilter(value as StatusFilter)}
            options={(['all', 'draft', 'active', 'archived'] as const).map((value) => ({
              value,
              label: value === 'all' ? t('checkout.status.notArchived') : t(`checkout.status.${value}`),
            }))}
          />
        }
        actions={
          writable ? (
            <DashboardButton variant="primary" onClick={() => setCreating(true)}>
              <Plus aria-hidden /> {t('checkout.list.new')}
            </DashboardButton>
          ) : null
        }
      />
      {checkouts.error ? (
        <PageBody>
          <ErrorNotice error={checkouts.error} />
        </PageBody>
      ) : (
        <ListTable<CheckoutSummary>
          className="px-4"
          rows={checkouts.data ?? []}
          getRowId={(c) => c.id}
          getRowLabel={(c) => c.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'updated', direction: 'desc' }}
          selectable={writable}
          loading={checkouts.isPending}
          onRowOpen={open}
          rowActions={rowActions}
          deletion={
            writable
              ? {
                  onDelete: async (rows) => {
                    await Promise.all(rows.map((c) => api.checkouts.remove(c.id)));
                    await refresh();
                  },
                  confirm: true,
                }
              : undefined
          }
          emptyState={<p className="py-10 text-center text-sm text-muted-foreground">{t('checkout.list.empty')}</p>}
        />
      )}
      {creating ? (
        <CreateCheckoutDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            open({ id });
          }}
        />
      ) : null}
    </>
  );
}

function CreateCheckoutDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const [name, setName] = useState('');
  const create = useCommerceMutation({
    mutationFn: () => api.checkouts.create({ name: name.trim(), definition: defaultCheckoutDefinition() }),
    onSuccess: (checkout) => onCreated(checkout.id),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('checkout.list.new')}</DialogTitle>
          </DialogHeader>
          <FormField label={t('commerce.field.name')} hint={t('checkout.list.nameHint')}>
            {(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || create.isPending}>
              {t('checkout.list.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
