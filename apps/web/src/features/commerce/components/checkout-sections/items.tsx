import { ITEM_SELECTIONS, type CheckoutItem } from '@amable/checkout';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Plus } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect, FormField, SectionCard } from '../common';
import {
  catalogPrice,
  moved,
  newId,
  PriceOverride,
  QuantityInput,
  refChoices,
  RowShell,
  type SectionProps,
} from './shared';

// ------------------------------------------------------------------ items

export function ItemsSection({ definition, edit, products, currency, disabled }: SectionProps) {
  const { t } = useI18n();
  const items = definition.items;
  const settings = definition.settings;
  const setItems = (next: CheckoutItem[]) => edit({ ...definition, items: next });
  const patch = (id: string, value: Partial<CheckoutItem>) =>
    setItems(items.map((i) => (i.id === id ? { ...i, ...value } : i)));
  const add = (kind: 'product' | 'plan') => {
    const first = refChoices(products, kind)[0];
    if (first === undefined) return;
    setItems([
      ...items,
      {
        id: newId('i'),
        kind,
        ref_id: first.value,
        quantity: 1,
        price_minor: null,
        label: '',
        description: '',
        image_url: '',
        preselected: items.length === 0,
      },
    ]);
  };
  return (
    <SectionCard
      title={t('checkout.tab.products')}
      actions={
        <span className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || items.length >= 20 || products.length === 0}
            onClick={() => add('product')}
          >
            <Plus aria-hidden /> {t('checkout.items.addProduct')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || items.length >= 20 || refChoices(products, 'plan').length === 0}
            onClick={() => add('plan')}
          >
            <Plus aria-hidden /> {t('checkout.items.addPlan')}
          </Button>
        </span>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t('checkout.items.selection')}
            hint={t(`checkout.items.selection.${settings.item_selection}.hint`)}
          >
            {(id) => (
              <ChoiceSelect
                id={id}
                value={settings.item_selection}
                disabled={disabled}
                onChange={(value) =>
                  edit({
                    ...definition,
                    settings: {
                      ...settings,
                      item_selection: ITEM_SELECTIONS.find((s) => s === value) ?? 'all',
                    },
                  })
                }
                choices={ITEM_SELECTIONS.map((value) => ({
                  value,
                  label: t(`checkout.items.selection.${value}`),
                }))}
                className="w-full"
              />
            )}
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Switch
              checked={settings.allow_quantity}
              disabled={disabled}
              onCheckedChange={(allow_quantity) =>
                edit({ ...definition, settings: { ...settings, allow_quantity } })
              }
            />
            {t('checkout.items.allowQuantity')}
          </label>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('checkout.items.empty')}</p>
        ) : null}
        <ol className="grid gap-3">
          {items.map((item, index) => (
            <RowShell
              key={item.id}
              title={`${t(`checkout.items.kind.${item.kind}`)} · ${refChoices(products, item.kind).find((c) => c.value === item.ref_id)?.label ?? item.ref_id}`}
              index={index}
              count={items.length}
              disabled={disabled}
              onMove={(delta) => setItems(moved(items, index, delta))}
              onRemove={() =>
                edit({
                  ...definition,
                  items: items.filter((i) => i.id !== item.id),
                  discounts: definition.discounts
                    .map((r) => ({
                      ...r,
                      conditions: r.conditions.filter((c) => c.item_id !== item.id),
                    }))
                    .filter((r) => r.conditions.length > 0),
                })
              }
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField
                  label={
                    item.kind === 'plan' ? t('commerce.field.plan') : t('commerce.field.product')
                  }
                  className="sm:col-span-2"
                >
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={item.ref_id}
                      disabled={disabled}
                      onChange={(ref_id) => patch(item.id, { ref_id })}
                      choices={refChoices(products, item.kind)}
                      className="w-full"
                    />
                  )}
                </FormField>
                <QuantityInput
                  value={item.quantity}
                  disabled={disabled}
                  onChange={(quantity) => patch(item.id, { quantity })}
                />
                <PriceOverride
                  value={item.price_minor}
                  catalog={catalogPrice(products, item.kind, item.ref_id)}
                  currency={currency}
                  disabled={disabled}
                  onChange={(price_minor) => patch(item.id, { price_minor })}
                />
                <FormField label={t('checkout.field.label')} hint={t('checkout.field.labelHint')}>
                  {(id) => (
                    <Input
                      id={id}
                      value={item.label}
                      maxLength={200}
                      disabled={disabled}
                      onChange={(e) => patch(item.id, { label: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.field.imageUrl')}>
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      value={item.image_url}
                      disabled={disabled}
                      onChange={(e) => patch(item.id, { image_url: e.target.value.trim() })}
                    />
                  )}
                </FormField>
                <FormField label={t('commerce.field.description')} className="sm:col-span-3">
                  {(id) => (
                    <Input
                      id={id}
                      value={item.description}
                      maxLength={1000}
                      disabled={disabled}
                      onChange={(e) => patch(item.id, { description: e.target.value })}
                    />
                  )}
                </FormField>
              </div>
              {settings.item_selection === 'one' ? (
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={item.preselected}
                    disabled={disabled}
                    onCheckedChange={(on) =>
                      setItems(
                        items.map((i) => ({
                          ...i,
                          preselected: i.id === item.id ? on : on ? false : i.preselected,
                        })),
                      )
                    }
                  />
                  {t('checkout.items.preselected')}
                </label>
              ) : settings.item_selection === 'any' ? (
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={item.preselected}
                    disabled={disabled}
                    onCheckedChange={(preselected) => patch(item.id, { preselected })}
                  />
                  {t('checkout.items.checked')}
                </label>
              ) : null}
            </RowShell>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}
