import { Button } from '@amable/ui/ui/button';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { commerceKeys, useCommerce, useDates, useMoney, usePermissions } from '../api/hooks';
import { OrderStatusPill, SectionCard, SubscriptionStatusPill, intervalText } from './common';

export interface ContactOrdersPanelProps {
  readonly contactId: string;
  /** Max orders listed (newest first). Default 5. */
  readonly limit?: number;
  readonly className?: string;
}

/**
 * "Orders" section of the contact page: recent orders, active subscriptions,
 * lifetime paid per currency, shortcuts to the filtered list and to a new
 * manual order. Renders nothing without `orders:read`.
 */
export function ContactOrdersPanel({ contactId, limit = 5, className }: ContactOrdersPanelProps) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { can, ready } = usePermissions();
  const navigate = useNavigate();
  const money = useMoney();
  const { date } = useDates();
  const readable = ready && can('orders:read');

  const orders = useQuery({
    queryKey: [...commerceKeys.orders(slug), 'byContact', contactId],
    enabled: readable,
    queryFn: async () => (await api.orders.list({ contact_id: contactId, limit: 200 })).data,
  });
  const subscriptions = useQuery({
    queryKey: [...commerceKeys.subscriptions(slug), 'byContact', contactId],
    enabled: ready && can('subscriptions:read'),
    queryFn: async () => (await api.subscriptions.list({ contact_id: contactId, limit: 50 })).data,
  });

  if (!readable) return null;
  const rows = orders.data ?? [];
  const paid = new Map<string, number>();
  for (const order of rows) {
    const net = order.paid_minor - order.refunded_minor;
    if (net !== 0) paid.set(order.currency, (paid.get(order.currency) ?? 0) + net);
  }
  const liveSubs = (subscriptions.data ?? []).filter((s) => s.status !== 'cancelled');

  return (
    <SectionCard
      className={className}
      title={t('commerce.contactPanel.title')}
      actions={
        can('orders:write') ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({
                to: '/t/$tenant/orders/new',
                params: { tenant: slug },
                search: { contact: contactId },
              })
            }
          >
            <Plus aria-hidden /> {t('commerce.orders.new')}
          </Button>
        ) : null
      }
    >
      {orders.isPending ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('commerce.contactPanel.empty')}</p>
      ) : (
        <>
          <p className="mb-2 text-sm">
            <span className="text-muted-foreground">{t('commerce.contactPanel.lifetime')} </span>
            <span className="font-medium tabular-nums">
              {[...paid.entries()].map(([currency, minor]) => money(minor, currency)).join(' · ') ||
                '—'}
            </span>
            <span className="text-muted-foreground">
              {' · '}
              {t('commerce.contactPanel.count', { count: rows.length })}
            </span>
          </p>
          <ul className="divide-y text-sm">
            {rows.slice(0, limit).map((order) => (
              <li key={order.id}>
                <Link
                  to="/t/$tenant/orders/$orderId"
                  params={{ tenant: slug, orderId: order.id }}
                  className="flex items-center gap-3 py-2 hover:bg-muted/50"
                >
                  <span className="w-24 shrink-0 font-medium tabular-nums">{order.number}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {date(order.order_date)}
                  </span>
                  <OrderStatusPill status={order.status} />
                  <span className="w-24 shrink-0 text-right tabular-nums">
                    {money(order.total_minor, order.currency)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {rows.length > limit ? (
            <Link
              to="/t/$tenant/orders"
              params={{ tenant: slug }}
              search={{ contact: contactId }}
              className="mt-2 inline-block text-sm font-medium hover:underline"
            >
              {t('commerce.contactPanel.viewAll')}
            </Link>
          ) : null}
        </>
      )}
      {liveSubs.length > 0 ? (
        <div className="mt-3 border-t pt-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground uppercase">
            {t('nav.subscriptions')}
          </p>
          <ul className="grid gap-1 text-sm">
            {liveSubs.map((s) => (
              <li key={s.id}>
                <Link
                  to="/t/$tenant/subscriptions/$subscriptionId"
                  params={{ tenant: slug, subscriptionId: s.id }}
                  className="flex items-center gap-3 hover:underline"
                >
                  <SubscriptionStatusPill status={s.status} />
                  <span className="flex-1 tabular-nums">
                    {money(s.amount_minor, s.currency)} /{' '}
                    {intervalText(t, s.interval, s.interval_count)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.next_bill_at ? date(s.next_bill_at) : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}
