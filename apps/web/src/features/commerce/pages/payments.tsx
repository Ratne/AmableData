import type { Payment } from '@amable/api-types';
import { ListTable, PageBody, PageToolbar, usePageChrome, type ListTableColumn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { commerceKeys, useCommerce, useContactNames, useDates, useMoney } from '../api/hooks';
import { ChoiceSelect, ErrorNotice, ListFooter, Pill } from '../components/common';

export function PaymentsPage() {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const navigate = useNavigate();
  const money = useMoney();
  const { dateTime } = useDates();
  usePageChrome({ title: t('nav.payments') });
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const query = useInfiniteQuery({
    queryKey: [...commerceKeys.payments(slug), 'list', status, from, to],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.payments.list({
        limit: 50,
        cursor: pageParam,
        status: status === 'succeeded' || status === 'failed' ? status : undefined,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.data), [query.data]);
  const contacts = useContactNames(useMemo(() => rows.map((p) => p.contact_id), [rows]));

  const columns: ListTableColumn<Payment>[] = [
    {
      id: 'date',
      header: t('commerce.field.paidAt'),
      cell: (p) => dateTime(p.paid_at),
      sortable: true,
      sortValue: (p) => p.paid_at,
      firstDirection: 'desc',
    },
    {
      id: 'contact',
      header: t('commerce.field.contact'),
      cell: (p) => <span className="truncate">{contacts.nameOf(p.contact_id)}</span>,
      sortable: true,
      sortValue: (p) => contacts.nameOf(p.contact_id),
    },
    {
      id: 'method',
      header: t('commerce.field.method'),
      cell: (p) => t(`commerce.method.${p.method}`),
      hideBelow: 'md',
    },
    {
      id: 'status',
      header: t('commerce.field.status'),
      cell: (p) =>
        p.status === 'failed' ? (
          <Pill tone="danger">{t('commerce.payment.failed')}</Pill>
        ) : p.refunded_minor > 0 ? (
          <Pill tone="warning">
            {t('commerce.payment.refundedPart', { amount: money(p.refunded_minor, p.currency) })}
          </Pill>
        ) : (
          <Pill tone="success">{t('commerce.payment.succeeded')}</Pill>
        ),
    },
    {
      id: 'tx',
      header: t('commerce.field.transactionId'),
      cell: (p) => <span className="truncate font-mono text-xs">{p.transaction_id ?? '—'}</span>,
      hideBelow: 'xl',
    },
    {
      id: 'amount',
      header: t('commerce.field.amount'),
      cell: (p) => (
        <span className="font-medium tabular-nums">{money(p.amount_minor, p.currency)}</span>
      ),
      align: 'right',
      sortable: true,
      sortValue: (p) => p.amount_minor,
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
              choices={[
                { value: 'succeeded', label: t('commerce.payment.succeeded') },
                { value: 'failed', label: t('commerce.payment.failed') },
              ]}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t('commerce.common.from')}
              <Input
                type="date"
                value={from}
                className="h-8 w-36"
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t('commerce.common.to')}
              <Input
                type="date"
                value={to}
                className="h-8 w-36"
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </>
        }
      />
      {query.error ? (
        <PageBody>
          <ErrorNotice error={query.error} />
        </PageBody>
      ) : (
        <ListTable<Payment>
          className="px-4"
          rows={rows}
          getRowId={(p) => p.id}
          getRowLabel={(p) => p.transaction_id ?? p.id}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          loading={query.isPending}
          onRowOpen={(p) =>
            void navigate({
              to: '/t/$tenant/orders/$orderId',
              params: { tenant: slug, orderId: p.order_id },
            })
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.payment.empty')}
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
