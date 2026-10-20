import type { StepOf } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect } from '../../../crm/components/inputs';
import { useReferences } from '../../api/hooks';
import { clean } from '../../lib/clean';
import { Field, NumberInput } from '../form-bits';
import type { FormProps } from './shared';

export function CreateOrderForm({ step, onChange, disabled }: FormProps<'create_order'>) {
  const { t } = useI18n();
  const products = useReferences('/products');
  const choices = (products.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  const setItem = (index: number, item: StepOf<'create_order'>['items'][number]) =>
    onChange({ ...step, items: step.items.map((it, i) => (i === index ? item : it)) });
  return (
    <div className="grid gap-3">
      <p className="text-[11px] text-muted-foreground">{t('auto.step.orderHint')}</p>
      <p className="text-xs font-medium text-muted-foreground">{t('auto.step.items')}</p>
      {step.items.map((item, index) => (
        <div key={index} className="grid gap-2 rounded-md border p-2">
          <div className="flex items-center gap-1.5">
            {products.data === null || products.isError ? (
              <Input
                value={item.product_id}
                placeholder={t('auto.step.product')}
                disabled={disabled}
                className="h-8"
                onChange={(e) => setItem(index, { ...item, product_id: e.target.value.trim() })}
              />
            ) : (
              <ChoiceSelect
                value={item.product_id}
                allowEmpty={false}
                disabled={disabled}
                className="flex-1"
                ariaLabel={t('auto.step.product')}
                choices={choices}
                onChange={(product_id) => setItem(index, { ...item, product_id })}
              />
            )}
            {!disabled ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={t('auto.remove')}
                onClick={() =>
                  onChange({ ...step, items: step.items.filter((_, i) => i !== index) })
                }
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('auto.step.quantity')}>
              <NumberInput
                value={item.quantity}
                min={1}
                disabled={disabled}
                onChange={(n) => setItem(index, { ...item, quantity: Math.max(1, n ?? 1) })}
              />
            </Field>
            <Field label={t('auto.step.unitPrice')}>
              <NumberInput
                value={item.unit_price_minor}
                min={0}
                disabled={disabled}
                onChange={(n) =>
                  setItem(index, clean({ ...item, unit_price_minor: n ?? undefined }))
                }
              />
            </Field>
          </div>
        </div>
      ))}
      {!disabled ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 justify-self-start"
          onClick={() =>
            onChange({
              ...step,
              items: [...step.items, { product_id: choices[0]?.value ?? '', quantity: 1 }],
            })
          }
        >
          <Plus className="size-3.5" aria-hidden /> {t('auto.step.addItem')}
        </Button>
      ) : null}
      <Field label={t('auto.step.currency')}>
        <Input
          value={step.currency ?? ''}
          maxLength={3}
          disabled={disabled}
          className="h-8 w-24 uppercase"
          onChange={(e) =>
            onChange(clean({ ...step, currency: e.target.value.toUpperCase() || undefined }))
          }
        />
      </Field>
    </div>
  );
}
