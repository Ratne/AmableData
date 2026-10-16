import { cn } from '@amable/ui';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { useMoney } from '../api/hooks';
import { formatBps } from '../lib/money';
import { previewFromOrder, type PricedDocument } from '../lib/order-draft';

/** Lines + subtotal, discount, tax per rate, shipping and total of a priced document. */
export function TotalsTable({ order, className }: { order: PricedDocument; className?: string }) {
  const { t, locale } = useI18n();
  const money = useMoney();
  const preview = useMemo(() => previewFromOrder(order), [order]);
  const m = (minor: number) => money(minor, preview.currency);
  const hasDiscount = preview.discountMinor > 0;

  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">{t('commerce.field.item')}</th>
            <th className="py-2 pr-3 text-right font-medium">{t('commerce.field.quantity')}</th>
            <th className="py-2 pr-3 text-right font-medium">{t('commerce.field.unitPrice')}</th>
            {hasDiscount ? (
              <th className="py-2 pr-3 text-right font-medium">{t('commerce.field.discount')}</th>
            ) : null}
            <th className="py-2 pr-3 text-right font-medium">{t('commerce.field.tax')}</th>
            <th className="py-2 text-right font-medium">{t('commerce.field.lineTotal')}</th>
          </tr>
        </thead>
        <tbody>
          {preview.lines.map((line) => (
            <tr key={line.id} className="border-b align-top last:border-b-0">
              <td className="py-2 pr-3">
                <span className="font-medium">{line.name}</span>
                {line.sku ? (
                  <span className="block text-xs text-muted-foreground">{line.sku}</span>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{line.quantity}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{m(line.unitPriceMinor)}</td>
              {hasDiscount ? (
                <td className="py-2 pr-3 text-right tabular-nums">
                  {line.discountMinor > 0 ? `−${m(line.discountMinor)}` : '—'}
                </td>
              ) : null}
              <td className="py-2 pr-3 text-right tabular-nums">
                {formatBps(line.taxRateBps, locale)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {m(line.subtotalMinor - line.discountMinor)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-3 ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('commerce.field.subtotal')}</dt>
        <dd className="text-right tabular-nums">{m(preview.subtotalMinor)}</dd>
        {hasDiscount ? (
          <>
            <dt className="text-muted-foreground">
              {preview.promoCode
                ? t('commerce.totals.discountCode', { code: preview.promoCode })
                : t('commerce.field.discount')}
            </dt>
            <dd className="text-right tabular-nums">−{m(preview.discountMinor)}</dd>
          </>
        ) : null}
        {preview.taxes.map((bucket) => (
          <div key={bucket.rateBps} className="contents">
            <dt className="text-muted-foreground">
              {t('commerce.totals.taxAt', {
                rate: formatBps(bucket.rateBps, locale),
                base: m(bucket.baseMinor),
              })}
            </dt>
            <dd className="text-right tabular-nums">{m(bucket.taxMinor)}</dd>
          </div>
        ))}
        {preview.taxes.length === 0 ? (
          <>
            <dt className="text-muted-foreground">{t('commerce.field.tax')}</dt>
            <dd className="text-right tabular-nums">{m(preview.taxMinor)}</dd>
          </>
        ) : null}
        {preview.shippingMinor > 0 ? (
          <>
            <dt className="text-muted-foreground">{t('commerce.field.shipping')}</dt>
            <dd className="text-right tabular-nums">{m(preview.shippingMinor)}</dd>
          </>
        ) : null}
        <dt className="border-t pt-1.5 font-medium">{t('commerce.field.total')}</dt>
        <dd className="border-t pt-1.5 text-right font-semibold tabular-nums">
          {m(preview.totalMinor)}
        </dd>
      </dl>
    </div>
  );
}
