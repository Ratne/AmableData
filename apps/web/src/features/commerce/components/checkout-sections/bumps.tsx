import { BUMP_POSITIONS, BUMP_SKINS, type Bump } from '@amable/checkout';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
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

// ------------------------------------------------------------------ bumps

export function BumpsSection({ definition, edit, products, currency, disabled }: SectionProps) {
  const { t } = useI18n();
  const bumps = definition.bumps;
  const setBumps = (next: Bump[]) => edit({ ...definition, bumps: next });
  const patch = (id: string, value: Partial<Bump>) =>
    setBumps(bumps.map((b) => (b.id === id ? { ...b, ...value } : b)));
  const add = () => {
    const first = products[0];
    if (first === undefined) return;
    setBumps([
      ...bumps,
      {
        id: newId('b'),
        product_id: first.id,
        quantity: 1,
        price_minor: null,
        title: t('checkout.bumps.defaultTitle'),
        description: '',
        image_url: '',
        skin: 'highlight',
        position: 'above_payment',
        color: '',
        checked: false,
      },
    ]);
  };
  return (
    <SectionCard
      title={t('checkout.tab.bumps')}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || bumps.length >= 5 || products.length === 0}
          onClick={add}
        >
          <Plus aria-hidden /> {t('checkout.bumps.add')}
        </Button>
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t('checkout.bumps.intro')}</p>
        <ol className="grid gap-3">
          {bumps.map((bump, index) => (
            <RowShell
              key={bump.id}
              title={bump.title}
              index={index}
              count={bumps.length}
              disabled={disabled}
              onMove={(delta) => setBumps(moved(bumps, index, delta))}
              onRemove={() => setBumps(bumps.filter((b) => b.id !== bump.id))}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label={t('commerce.field.product')} className="sm:col-span-2">
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={bump.product_id}
                      disabled={disabled}
                      onChange={(product_id) => patch(bump.id, { product_id })}
                      choices={refChoices(products, 'product')}
                      className="w-full"
                    />
                  )}
                </FormField>
                <QuantityInput
                  value={bump.quantity}
                  disabled={disabled}
                  onChange={(quantity) => patch(bump.id, { quantity })}
                />
                <FormField label={t('checkout.bumps.title')} className="sm:col-span-2">
                  {(id) => (
                    <Input
                      id={id}
                      value={bump.title}
                      maxLength={200}
                      disabled={disabled}
                      onChange={(e) => patch(bump.id, { title: e.target.value })}
                    />
                  )}
                </FormField>
                <PriceOverride
                  value={bump.price_minor}
                  catalog={catalogPrice(products, 'product', bump.product_id)}
                  currency={currency}
                  disabled={disabled}
                  onChange={(price_minor) => patch(bump.id, { price_minor })}
                />
                <FormField label={t('commerce.field.description')} className="sm:col-span-3">
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={2}
                      value={bump.description}
                      maxLength={2000}
                      disabled={disabled}
                      onChange={(e) => patch(bump.id, { description: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.bumps.skin')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={bump.skin}
                      disabled={disabled}
                      onChange={(value) =>
                        patch(bump.id, {
                          skin: (BUMP_SKINS as readonly string[]).includes(value)
                            ? (value as Bump['skin'])
                            : 'classic',
                        })
                      }
                      choices={BUMP_SKINS.map((value) => ({
                        value,
                        label: t(`checkout.bumps.skin.${value}`),
                      }))}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.bumps.position')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={bump.position}
                      disabled={disabled}
                      onChange={(value) =>
                        patch(bump.id, {
                          position: (BUMP_POSITIONS as readonly string[]).includes(value)
                            ? (value as Bump['position'])
                            : 'above_payment',
                        })
                      }
                      choices={BUMP_POSITIONS.map((value) => ({
                        value,
                        label: t(`checkout.bumps.position.${value}`),
                      }))}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.bumps.color')} hint={t('checkout.bumps.colorHint')}>
                  {(id) => (
                    <div className="flex gap-2">
                      <input
                        type="color"
                        aria-label={t('checkout.bumps.color')}
                        className="h-9 w-10 cursor-pointer rounded border bg-transparent"
                        disabled={disabled}
                        value={/^#[0-9a-f]{6}$/i.test(bump.color) ? bump.color : '#f59e0b'}
                        onChange={(e) => patch(bump.id, { color: e.target.value })}
                      />
                      <Input
                        id={id}
                        value={bump.color}
                        disabled={disabled}
                        onChange={(e) => patch(bump.id, { color: e.target.value })}
                      />
                    </div>
                  )}
                </FormField>
                <FormField label={t('checkout.field.imageUrl')} className="sm:col-span-2">
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      value={bump.image_url}
                      disabled={disabled}
                      onChange={(e) => patch(bump.id, { image_url: e.target.value.trim() })}
                    />
                  )}
                </FormField>
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <Switch
                    checked={bump.checked}
                    disabled={disabled}
                    onCheckedChange={(checked) => patch(bump.id, { checked })}
                  />
                  {t('checkout.bumps.checked')}
                </label>
              </div>
            </RowShell>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}
