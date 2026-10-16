import {
  SUBSCRIPTION_STATUSES,
  type Subscription,
  type SubscriptionStatus,
} from '@amable/api-types';
import { ListTable, PageBody, PageToolbar, usePageChrome, type ListTableColumn } from '@amable/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import {
  commerceKeys,
  useCatalog,
  useCommerce,
  useContactNames,
  useDates,
  useMoney,
} from '../api/hooks';
import {
  ChoiceSelect,
  ErrorNotice,
  ListFooter,
  SubscriptionStatusPill,
  intervalText,
} from '../components/common';

export function SubscriptionsPage() {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const navigate = useNavigate();
  const money = useMoney();
  const { date } = useDates();
  const catalog = useCatalog();
  usePageChrome({ title: t('nav.subscriptions') });
  const [status, setStatus] = useState('');
  const [productId, setProductId] = useState('');

  const query = useInfiniteQuery({
    queryKey: [...commerceKeys.subscriptions(slug), 'list', status, productId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.subscriptions.list({
        limit: 50,
        cursor: pageParam,
        status: status ? (status as SubscriptionStatus) : undefined,
        product_id: productId || undefined,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.data), [query.data]);
  const contactIds = useMemo(() => rows.map((s) => s.contact_id), [rows]);
  const contacts = useContactNames(contactIds);

  const planLabel = (s: Subscription) => {
    const entry = catalog.planById.get(s.plan_id);
    return entry ? `${entry.product.name} — ${entry.plan.name}` : '—';
  };

  const columns: ListTableColumn<Subscription>[] = [
    {
      id: 'contact',
      header: t('commerce.field.contact'),
      cell: (s) => <span className="truncate font-medium">{contacts.nameOf(s.contact_id)}</span>,
      sortable: true,
      sortValue: (s) => contacts.nameOf(s.contact_id),
    },
    {
      id: 'plan',
      header: t('commerce.field.plan'),
      cell: (s) => <span className="truncate">{planLabel(s)}</span>,
      sortable: true,
      sortValue: planLabel,
      hideBelow: 'md',
    },
    {
      id: 'status',
      header: t('commerce.field.status'),
      cell: (s) => <SubscriptionStatusPill status={s.status} />,
      sortable: true,
      sortValue: (s) => s.status,
    },
    {
      id: 'next',
      header: t('commerce.sub.nextBill'),
      cell: (s) =>
        s.cancel_at_period_end
          ? t('commerce.sub.endsOn', { date: date(s.current_period_end) })
          : date(s.next_bill_at),
      sortable: true,
      sortValue: (s) => s.next_bill_at ?? '',
      hideBelow: 'lg',
    },
    {
      id: 'amount',
      header: t('commerce.field.amount'),
      cell: (s) => (
        <span className="tabular-nums">
          {money(s.amount_minor, s.currency)}{' '}
          <span className="text-xs text-muted-foreground">
            / {intervalText(t, s.interval, s.interval_count)}
          </span>
        </span>
      ),
      align: 'right',
      sortable: true,
      sortValue: (s) => s.amount_minor,
      firstDirection: 'desc',
    },
  ];

  return (
    <>
      <PageToolbar
        filters={
          <>
            <ChoiceSelect
              value={status}
              onChange={setStatus}
              emptyLabel={t('commerce.common.allStatuses')}
              ariaLabel={t('commerce.field.status')}
              choices={SUBSCRIPTION_STATUSES.map((value) => ({
                value,
                label: t(`commerce.subStatus.${value}`),
              }))}
            />
            <ChoiceSelect
              value={productId}
              onChange={setProductId}
              emptyLabel={t('commerce.products.allProducts')}
              ariaLabel={t('commerce.field.product')}
              choices={catalog.products
                .filter((p) => p.plans.length > 0)
                .map((p) => ({ value: p.id, label: p.name }))}
            />
          </>
        }
      />
      {query.error ? (
        <PageBody>
          <ErrorNotice error={query.error} />
        </PageBody>
      ) : (
        <ListTable<Subscription>
          className="px-4"
          rows={rows}
          getRowId={(s) => s.id}
          getRowLabel={(s) => contacts.nameOf(s.contact_id)}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          loading={query.isPending}
          onRowOpen={(s) =>
            void navigate({
              to: '/t/$tenant/subscriptions/$subscriptionId',
              params: { tenant: slug, subscriptionId: s.id },
            })
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.sub.empty')}
            </p>
          }
          footer={
            <ListFooter
              hasMore={query.hasNextPage}
              loading={query.isFetchingNextPage}
              onMore={() => void query.fetchNextPage()}
            />
          }
        />
      )}
    </>
  );
}
