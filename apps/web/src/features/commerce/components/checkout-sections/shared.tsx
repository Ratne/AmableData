import type { Product } from '@amable/api-types';
import type { CheckoutDefinition } from '@amable/checkout';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../../i18n';
import { useMoney } from '../../api/hooks';
import { FormField, MoneyInput } from '../common';

type Edit = (next: CheckoutDefinition) => void;

export interface SectionProps {
  definition: CheckoutDefinition;
  edit: Edit;
  products: readonly Product[];
  currency: string;
  disabled: boolean;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export function moved<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item === undefined) return next;
  next.splice(index + delta, 0, item);
  return next;
}

export function RowShell({
  title,
  index,
  count,
  disabled,
  onMove,
  onRemove,
  children,
}: {
  title: ReactNode;
  index: number;
  count: number;
  disabled: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <li className="grid gap-3 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || index === 0}
          aria-label={t('checkout.action.moveUp')}
          onClick={() => onMove(-1)}
        >
          <ArrowUp aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || index === count - 1}
          aria-label={t('checkout.action.moveDown')}
          onClick={() => onMove(1)}
        >
          <ArrowDown aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          aria-label={t('commerce.common.remove')}
          onClick={onRemove}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      {children}
    </li>
  );
}

export function refChoices(products: readonly Product[], kind: 'product' | 'plan') {
  return kind === 'product'
    ? products.map((p) => ({ value: p.id, label: p.name }))
    : products.flatMap((p) =>
        p.plans.map((plan) => ({ value: plan.id, label: `${p.name} — ${plan.name}` })),
      );
}

export function catalogPrice(
  products: readonly Product[],
  kind: 'product' | 'plan',
  refId: string,
): number | null {
  for (const p of products) {
    if (kind === 'product' && p.id === refId) return p.price_minor;
    const plan = p.plans.find((x) => x.id === refId);
    if (kind === 'plan' && plan !== undefined) return plan.price_minor;
  }
  return null;
}

export function PriceOverride({
  value,
  catalog,
  currency,
  disabled,
  onChange,
}: {
  value: number | null;
  catalog: number | null;
  currency: string;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const { t } = useI18n();
  const money = useMoney();
  return (
    <FormField
      label={t('checkout.field.price')}
      hint={
        catalog === null
          ? null
          : t('checkout.field.catalogPrice', { price: money(catalog, currency) })
      }
    >
      {(id) => (
        <MoneyInput
          id={id}
          value={value}
          onChange={onChange}
          currency={currency}
          disabled={disabled}
          placeholder={t('checkout.field.priceCatalog')}
        />
      )}
    </FormField>
  );
}

export function QuantityInput({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const { t } = useI18n();
  return (
    <FormField label={t('commerce.field.quantity')}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={1}
          max={999}
          value={value}
          disabled={disabled}
          onChange={(e) =>
            onChange(Math.max(1, Math.min(999, Math.trunc(Number(e.target.value)) || 1)))
          }
        />
      )}
    </FormField>
  );
}
