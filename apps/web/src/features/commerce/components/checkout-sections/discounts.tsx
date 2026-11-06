import type { AutoDiscount } from '@amable/checkout';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect, FormField, MoneyInput, SectionCard } from '../common';
import { moved, newId, RowShell, type SectionProps } from './shared';

// -------------------------------------------------------------- discounts

export function DiscountsSection({ definition, edit, products, currency, disabled }: SectionProps) {
  const { t } = useI18n();
  const rules = definition.discounts;
  const settings = definition.settings;
  const setRules = (next: AutoDiscount[]) => edit({ ...definition, discounts: next });
  const patch = (id: string, value: Partial<AutoDiscount>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...value } : r)));
  const itemChoices = definition.items
    .filter((i) => i.kind === 'product')
    .map((i) => ({
      value: i.id,
      label: i.label !== '' ? i.label : (products.find((p) => p.id === i.ref_id)?.name ?? i.ref_id),
    }));
  const add = () => {
    const first = itemChoices[0];
    if (first === undefined) return;
    setRules([
      ...rules,
      {
        id: newId('d'),
        label: t('checkout.discounts.defaultLabel'),
        conditions: [{ item_id: first.value, min_quantity: 1 }],
        kind: 'percent',
        percent_bps: 1000,
        amount_minor: null,
        scope: 'matching',
      },
    ]);
  };
  return (
    <SectionCard
      title={t('checkout.discounts.title')}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || rules.length >= 10 || itemChoices.length === 0}
          onClick={add}
        >
          <Plus aria-hidden /> {t('checkout.discounts.add')}
        </Button>
      }
    >
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">{t('checkout.discounts.intro')}</p>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={settings.discounts_stack_promo}
            disabled={disabled || !settings.promo_codes}
            onCheckedChange={(discounts_stack_promo) =>
              edit({ ...definition, settings: { ...settings, discounts_stack_promo } })
            }
          />
          {t('checkout.discounts.stackPromo')}
        </label>
        <ol className="grid gap-3">
          {rules.map((rule, index) => (
            <RowShell
              key={rule.id}
              title={rule.label}
              index={index}
              count={rules.length}
              disabled={disabled}
              onMove={(delta) => setRules(moved(rules, index, delta))}
              onRemove={() => setRules(rules.filter((r) => r.id !== rule.id))}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField
                  label={t('checkout.discounts.label')}
                  hint={t('checkout.discounts.labelHint')}
                >
                  {(id) => (
                    <Input
                      id={id}
                      value={rule.label}
                      maxLength={100}
                      disabled={disabled}
                      onChange={(e) => patch(rule.id, { label: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.discounts.kind')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={rule.kind}
                      disabled={disabled}
                      onChange={(value) =>
                        patch(
                          rule.id,
                          value === 'fixed'
                            ? {
                                kind: 'fixed',
                                percent_bps: null,
                                amount_minor: rule.amount_minor ?? 1000,
                              }
                            : {
                                kind: 'percent',
                                amount_minor: null,
                                percent_bps: rule.percent_bps ?? 1000,
                              },
                        )
                      }
                      choices={(['percent', 'fixed'] as const).map((value) => ({
                        value,
                        label: t(`checkout.discounts.kind.${value}`),
                      }))}
                      className="w-full"
                    />
                  )}
                </FormField>
                {rule.kind === 'percent' ? (
                  <FormField label={t('checkout.discounts.percent')}>
                    {(id) => (
                      <Input
                        id={id}
                        type="number"
                        min={0.01}
                        max={100}
                        step={0.01}
                        value={rule.percent_bps === null ? '' : rule.percent_bps / 100}
                        disabled={disabled}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          patch(rule.id, {
                            percent_bps:
                              e.target.value === '' || !Number.isFinite(n)
                                ? null
                                : Math.max(1, Math.min(10_000, Math.round(n * 100))),
                          });
                        }}
                      />
                    )}
                  </FormField>
                ) : (
                  <FormField label={t('checkout.discounts.amount')}>
                    {(id) => (
                      <MoneyInput
                        id={id}
                        value={rule.amount_minor}
                        onChange={(amount_minor) => patch(rule.id, { amount_minor })}
                        currency={currency}
                        disabled={disabled}
                      />
                    )}
                  </FormField>
                )}
                <FormField
                  label={t('checkout.discounts.scope')}
                  hint={t(`checkout.discounts.scope.${rule.scope}.hint`)}
                  className="sm:col-span-3"
                >
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={rule.scope}
                      disabled={disabled}
                      onChange={(value) =>
                        patch(rule.id, { scope: value === 'order' ? 'order' : 'matching' })
                      }
                      choices={(['matching', 'order'] as const).map((value) => ({
                        value,
                        label: t(`checkout.discounts.scope.${value}`),
                      }))}
                      className="w-full"
                    />
                  )}
                </FormField>
              </div>
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t('checkout.discounts.conditions')}</span>
                {rule.conditions.map((condition, ci) => (
                  <div key={`${rule.id}-${String(ci)}`} className="flex items-end gap-2">
                    <FormField label={t('commerce.field.product')} className="min-w-0 flex-1">
                      {(id) => (
                        <ChoiceSelect
                          id={id}
                          value={condition.item_id}
                          disabled={disabled}
                          onChange={(item_id) =>
                            patch(rule.id, {
                              conditions: rule.conditions.map((c, i) =>
                                i === ci ? { ...c, item_id } : c,
                              ),
                            })
                          }
                          choices={itemChoices}
                          className="w-full"
                        />
                      )}
                    </FormField>
                    <FormField label={t('checkout.discounts.minQuantity')} className="w-32">
                      {(id) => (
                        <Input
                          id={id}
                          type="number"
                          min={1}
                          max={999}
                          value={condition.min_quantity}
                          disabled={disabled}
                          onChange={(e) => {
                            const min_quantity = Math.max(
                              1,
                              Math.min(999, Math.trunc(Number(e.target.value)) || 1),
                            );
                            patch(rule.id, {
                              conditions: rule.conditions.map((c, i) =>
                                i === ci ? { ...c, min_quantity } : c,
                              ),
                            });
                          }}
                        />
                      )}
                    </FormField>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="mb-1"
                      disabled={disabled || rule.conditions.length === 1}
                      aria-label={t('commerce.common.remove')}
                      onClick={() =>
                        patch(rule.id, { conditions: rule.conditions.filter((_, i) => i !== ci) })
                      }
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || rule.conditions.length >= 10}
                    onClick={() => {
                      const free = itemChoices.find(
                        (c) => !rule.conditions.some((x) => x.item_id === c.value),
                      );
                      if (free !== undefined)
                        patch(rule.id, {
                          conditions: [
                            ...rule.conditions,
                            { item_id: free.value, min_quantity: 1 },
                          ],
                        });
                    }}
                  >
                    <Plus aria-hidden /> {t('checkout.discounts.addCondition')}
                  </Button>
                </div>
              </div>
            </RowShell>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}
