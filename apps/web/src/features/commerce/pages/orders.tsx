import { ORDER_SOURCES, ORDER_STATUSES, type FilterLeaf, type OrderStatus } from '@amable/api-types';
import {
  DashboardButton,
  ListTable,
  PageToolbar,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import {
  commerceKeys,
  useCommerce,
  useContactNames,
  useDates,
  useMoney,
  usePermissions,
} from '../api/hooks';
import {
  ChoiceSelect,
  ErrorNotice,
  ListFooter,
  OrderStatusPill,
  SearchInput,
  useDebounced,
} from '../components/common';

interface OrderRow {
  readonly id: string;
  readonly number: string;
  readonly status: OrderStatus;
  readonly contactId: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly refundedMinor: number;
  readonly orderDate: string;
  readonly source: (typeof ORDER_SOURCES)[number];
  readonly itemCount: number;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

const COLUMNS = [
  'number',
  'status',
  'contact_id',
  'contact_name',
  'contact_email',
  'currency',
  'total_minor',
  'paid_minor',
  'refunded_minor',
  'order_date',
  'source',
  'item_count',
];

function toRow(row: Record<string, unknown>): OrderRow {
  return {
    id: str(row['id']),
    number: str(row['number']),
    status: str(row['status']) as OrderStatus,
    contactId: str(row['contact_id']),
    contactName: str(row['contact_name']),
    contactEmail: str(row['contact_email']),
    currency: str(row['currency']),
    totalMinor: num(row['total_minor']),
    paidMinor: num(row['paid_minor']),
    refundedMinor: num(row['refunded_minor']),
    orderDate: str(row['order_date']),
    source: ORDER_SOURCES.find((s) => s === row['source']) ?? 'manual',
    itemCount: num(row['item_count']),
  };
}

/** Sum of amounts per currency, e.g. "€ 1.200,00 · $ 80.00". */
function sumByCurrency(
  rows: readonly OrderRow[],
  pick: (row: OrderRow) => number,
  money: (minor: number, currency: string) => string,
): string {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + pick(row));
  return [...totals.entries()].map(([currency, minor]) => money(minor, currency)).join(' · ');
}

export function OrdersPage() {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const money = useMoney();
  const { date } = useDates();
  const search: { contact?: string; status?: string } = useSearch({ strict: false });
  usePageChrome({ title: t('nav.orders') });

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>(
    search.status && (ORDER_STATUSES as readonly string[]).includes(search.status)
      ? search.status
      : '',
  );
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const contactId = search.contact ?? '';
  const debouncedQ = useDebounced(q.trim());
  const contactNames = useContactNames(contactId ? [contactId] : []);

  const filter = useMemo(() => {
    const conditions: FilterLeaf[] = [];
    if (status)
      conditions.push({ type: 'field', field: 'status', operator: 'equals', value: status });
    if (contactId)
      conditions.push({ type: 'field', field: 'contact_id', operator: 'equals', value: contactId });
    if (from) conditions.push({ type: 'field', field: 'order_date', operator: 'gte', value: from });
    if (to) conditions.push({ type: 'field', field: 'order_date', operator: 'lte', value: to });
    return conditions;
  }, [status, contactId, from, to]);

  const query = useInfiniteQuery({
    queryKey: [...commerceKeys.orders(slug), 'search', debouncedQ, filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.search({
        entity: 'order',
        ...(debouncedQ ? { q: debouncedQ } : {}),
        ...(filter.length > 0 ? { filter: { type: 'group', op: 'and', conditions: filter } } : {}),
        columns: COLUMNS,
        sort: { field: 'order_date', direction: 'desc' },
        limit: 50,
        include_total: pageParam === undefined,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const rows = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data.map(toRow)),
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? null;

  const columns: ListTableColumn<OrderRow>[] = [
    {
      id: 'number',
      header: t('commerce.field.number'),
      cell: (row) => (
        <span className="font-medium whitespace-nowrap tabular-nums">{row.number}</span>
      ),
      sortable: true,
      sortValue: (row) => row.number,
    },
    {
      id: 'date',
      header: t('commerce.field.date'),
      cell: (row) => <span className="whitespace-nowrap">{date(row.orderDate)}</span>,
      sortable: true,
      sortValue: (row) => row.orderDate,
      firstDirection: 'desc',
    },
    {
      id: 'contact',
      header: t('commerce.field.contact'),
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{row.contactName || row.contactEmail || '—'}</span>
          {row.contactName && row.contactEmail ? (
            <span className="truncate text-xs text-muted-foreground">{row.contactEmail}</span>
          ) : null}
        </span>
      ),
      sortable: true,
      sortValue: (row) => row.contactName || row.contactEmail,
    },
    {
      id: 'status',
      header: t('commerce.field.status'),
      cell: (row) => <OrderStatusPill status={row.status} />,
      sortable: true,
      sortValue: (row) => row.status,
    },
    {
      id: 'source',
      header: t('commerce.field.source'),
      cell: (row) => t(`commerce.source.${row.source}`),
      hideBelow: '2xl',
    },
    {
      id: 'items',
      header: t('commerce.field.items'),
      cell: (row) => row.itemCount,
      align: 'right',
      hideBelow: 'xl',
    },
    {
      id: 'paid',
      header: t('commerce.field.paid'),
      cell: (row) => (
        <span className="tabular-nums text-muted-foreground">
          {money(row.paidMinor - row.refundedMinor, row.currency)}
        </span>
      ),
      align: 'right',
      hideBelow: 'md',
    },
    {
      id: 'total',
      header: t('commerce.field.total'),
      cell: (row) => (
        <span className="font-medium tabular-nums">{money(row.totalMinor, row.currency)}</span>
      ),
      align: 'right',
      sortable: true,
      sortValue: (row) => row.totalMinor,
      firstDirection: 'desc',
    },
  ];

  const statusChoices = ORDER_STATUSES.map((value) => ({
    value,
    label: t(`commerce.orderStatus.${value}`),
  }));

  return (
    <>
      <PageToolbar
        filters={
          <>
            <SearchInput value={q} onChange={setQ} placeholder={t('commerce.orders.search')} />
            <ChoiceSelect
              value={status}
              onChange={setStatus}
              choices={statusChoices}
              emptyLabel={t('commerce.common.allStatuses')}
              ariaLabel={t('commerce.field.status')}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t('commerce.common.from')}
              <Input
                type="date"
                value={from}
                className="h-8 w-36"
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {t('commerce.common.to')}
              <Input
                type="date"
                value={to}
                className="h-8 w-36"
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
            {contactId ? (
              <DashboardButton
                variant="muted"
                onClick={() =>
                  void navigate({ to: '/t/$tenant/orders', params: { tenant: slug }, search: {} })
                }
              >
                {t('commerce.orders.contactFilter', { name: contactNames.nameOf(contactId) })}
                <X aria-hidden />
              </DashboardButton>
            ) : null}
          </>
        }
        actions={
          can('orders:write') ? (
            <DashboardButton
              variant="primary"
              onClick={() =>
                void navigate({
                  to: '/t/$tenant/orders/new',
                  params: { tenant: slug },
                  search: contactId ? { contact: contactId } : {},
                })
              }
            >
              <Plus aria-hidden /> {t('commerce.orders.new')}
            </DashboardButton>
          ) : null
        }
      />
      {query.error ? (
        <div className="px-4">
          <ErrorNotice error={query.error} />
        </div>
      ) : (
        <ListTable<OrderRow>
          className="px-4"
          rows={rows}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.number}
          columns={columns}
          labels={listTableLabels(t)}
          selectable={false}
          loading={query.isPending}
          onRowOpen={(row) =>
            void navigate({
              to: '/t/$tenant/orders/$orderId',
              params: { tenant: slug, orderId: row.id },
            })
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t('commerce.orders.empty')}
            </p>
          }
          footer={
            <ListFooter
              summary={
                rows.length > 0
                  ? t('commerce.orders.summary', {
                      shown: rows.length,
                      total: total ?? rows.length,
                      amount: sumByCurrency(rows, (row) => row.totalMinor, money),
                      paid: sumByCurrency(rows, (row) => row.paidMinor - row.refundedMinor, money),
                    })
                  : null
              }
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
