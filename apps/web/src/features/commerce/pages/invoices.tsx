import { INVOICE_STATUSES, type Invoice } from '@amable/api-types';
import { ListTable, PageBody, PageToolbar, usePageChrome, type ListTableColumn } from '@amable/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { commerceKeys, useCommerce, useContactNames, useDates, useMoney } from '../api/hooks';
import { ChoiceSelect, ErrorNotice, InvoiceStatusPill, ListFooter } from '../components/common';

type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export function InvoicesPage() {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const navigate = useNavigate();
  const money = useMoney();
  const { date } = useDates();
  usePageChrome({ title: t('nav.invoices') });
  const [status, setStatus] = useState('');
  const [year, setYear] = useState('');
  const currentYear = new Date().getFullYear();

  const query = useInfiniteQuery({
    queryKey: [...commerceKeys.invoices(slug), 'list', status, year],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.invoices.list({
        limit: 50,
        cursor: pageParam,
        status: status ? (status as InvoiceStatus) : undefined,
        year: year ? Number(year) : undefined,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.data), [query.data]);
  const contacts = useContactNames(useMemo(() => rows.map((i) => i.contact_id), [rows]));

  const columns: ListTableColumn<Invoice>[] = [
    {
      id: 'number',
      header: t('commerce.field.number'),
      cell: (i) => <span className="font-medium tabular-nums">{i.number}</span>,
      sortable: true,
      sortValue: (i) => i.year * 1_000_000 + i.sequence,
      firstDirection: 'desc',
    },
    {
      id: 'issued',
      header: t('commerce.invoice.issued'),
      cell: (i) => date(i.issued_at),
      sortable: true,
      sortValue: (i) => i.issued_at,
      firstDirection: 'desc',
    },
    {
      id: 'contact',
      header: t('commerce.field.contact'),
      cell: (i) => <span className="truncate">{contacts.nameOf(i.contact_id)}</span>,
      sortable: true,
      sortValue: (i) => contacts.nameOf(i.contact_id),
    },
    {
      id: 'due',
      header: t('commerce.field.dueAt'),
      cell: (i) => date(i.due_at),
      hideBelow: 'lg',
    },
    {
      id: 'status',
      header: t('commerce.field.status'),
      cell: (i) => <InvoiceStatusPill status={i.status} />,
      sortable: true,
      sortValue: (i) => i.status,
    },
    {
      id: 'total',
      header: t('commerce.field.total'),
      cell: (i) => (
        <span className="font-medium tabular-nums">{money(i.total_minor, i.currency)}</span>
      ),
      align: 'right',
      sortable: true,
      sortValue: (i) => i.total_minor,
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
              choices={INVOICE_STATUSES.map((value) => ({
                value,
                label: t(`commerce.invoiceStatus.${value}`),
              }))}
            />
            <ChoiceSelect
              value={year}
              onChange={setYear}
              emptyLabel={t('commerce.invoice.allYears')}
              ariaLabel={t('commerce.invoice.year')}
              choices={[0, 1, 2, 3].map((offset) => {
                const value = String(currentYear - offset);
                return { value, label: value };
              })}
            />
          </>
        }
      />
      {query.error ? (
        <PageBody>
          <ErrorNotice error={query.error} />
        </PageBody>
      ) : (
        <ListTable<Invoice>
          className="px-4"
          rows={rows}
          getRowId={(i) => i.id}
          getRowLabel={(i) => i.number}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          loading={query.isPending}
          onRowOpen={(i) =>
            void navigate({
              to: '/t/$tenant/invoices/$invoiceId',
              params: { tenant: slug, invoiceId: i.id },
            })
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.invoice.empty')}
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
