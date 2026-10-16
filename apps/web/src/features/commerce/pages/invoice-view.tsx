import type { Contact } from '@amable/api-types';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Printer, ShoppingCart } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { commerceKeys, useCommerce, useDates, useTenantMe } from '../api/hooks';
import { InvoiceStatusPill, PageState } from '../components/common';
import { contactLabel } from '../components/contact-picker';
import { TotalsTable } from '../components/totals-table';
import { invoiceDetailRoute } from '../routes';

/** While printing only the invoice sheet is visible (the app shell is hidden). */
const PRINT_CSS = `
@media print {
  @page { margin: 16mm; }
  body * { visibility: hidden !important; }
  #invoice-sheet, #invoice-sheet * { visibility: visible !important; }
  #invoice-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; max-width: none !important; padding: 0 !important; border: 0 !important; box-shadow: none !important; }
}
`;

function addressLines(contact: Contact | undefined): string[] {
  const address = contact?.addresses[0];
  if (!address) return [];
  return [
    address.line1,
    address.line2,
    [address.locality, address.region].filter(Boolean).join(', '),
  ].filter((line): line is string => typeof line === 'string' && line.trim() !== '');
}

export function InvoiceViewPage() {
  const { invoiceId } = useParams({ from: invoiceDetailRoute.id });
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const navigate = useNavigate();
  const { date } = useDates();
  const me = useTenantMe();
  const invoice = useQuery({
    queryKey: commerceKeys.invoice(slug, invoiceId),
    queryFn: () => api.invoices.get(invoiceId),
  });
  const contact = useQuery({
    queryKey: [...commerceKeys.contacts(slug), 'one', invoice.data?.contact_id ?? ''],
    enabled: invoice.data !== undefined,
    queryFn: () => api.contacts.get(invoice.data?.contact_id ?? ''),
    retry: false,
  });
  usePageChrome({
    title: invoice.data
      ? t('commerce.invoice.title', { number: invoice.data.number })
      : t('nav.invoices'),
  });

  return (
    <PageState isPending={invoice.isPending} error={invoice.error}>
      {() => {
        const inv = invoice.data;
        if (!inv) return null;
        const customer = contact.data ? contactLabel(contact.data) : null;
        return (
          <>
            <style>{PRINT_CSS}</style>
            <PageToolbar
              filters={<InvoiceStatusPill status={inv.status} />}
              actions={
                <>
                  <DashboardButton
                    variant="ghost"
                    onClick={() =>
                      void navigate({
                        to: '/t/$tenant/orders/$orderId',
                        params: { tenant: slug, orderId: inv.order_id },
                      })
                    }
                  >
                    <ShoppingCart aria-hidden /> {t('commerce.invoice.order')}
                  </DashboardButton>
                  <DashboardButton variant="primary" onClick={() => window.print()}>
                    <Printer aria-hidden /> {t('commerce.invoice.print')}
                  </DashboardButton>
                </>
              }
            />
            <PageBody>
              <article
                id="invoice-sheet"
                className="mx-auto max-w-3xl rounded-xl border bg-white p-10 text-neutral-900 shadow-sm"
              >
                <header className="flex flex-wrap items-start justify-between gap-6">
                  <div>
                    <p className="text-lg font-semibold">{me.data?.tenant.name ?? slug}</p>
                  </div>
                  <div className="text-right">
                    <h2 className="text-2xl font-semibold tracking-tight">
                      {t('commerce.invoice.heading')}
                    </h2>
                    <p className="font-mono text-sm">{inv.number}</p>
                    {inv.status === 'void' ? (
                      <p className="mt-1 text-sm font-semibold text-red-600 uppercase">
                        {t('commerce.invoiceStatus.void')}
                      </p>
                    ) : inv.status === 'paid' ? (
                      <p className="mt-1 text-sm font-semibold text-emerald-700 uppercase">
                        {t('commerce.invoiceStatus.paid')}
                      </p>
                    ) : null}
                  </div>
                </header>
                <section className="mt-8 grid gap-6 text-sm sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-medium tracking-wide text-neutral-500 uppercase">
                      {t('commerce.invoice.billTo')}
                    </p>
                    <p className="font-medium">{customer?.name || customer?.email || '—'}</p>
                    {customer?.name && customer.email ? <p>{customer.email}</p> : null}
                    {addressLines(contact.data).map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 sm:justify-self-end">
                    <dt className="text-neutral-500">{t('commerce.invoice.issued')}</dt>
                    <dd className="text-right">{date(inv.issued_at)}</dd>
                    <dt className="text-neutral-500">{t('commerce.field.dueAt')}</dt>
                    <dd className="text-right">{date(inv.due_at)}</dd>
                    {inv.paid_at ? (
                      <>
                        <dt className="text-neutral-500">{t('commerce.field.paidAt')}</dt>
                        <dd className="text-right">{date(inv.paid_at)}</dd>
                      </>
                    ) : null}
                  </dl>
                </section>
                <TotalsTable order={inv} className="mt-8" />
              </article>
            </PageBody>
          </>
        );
      }}
    </PageState>
  );
}
