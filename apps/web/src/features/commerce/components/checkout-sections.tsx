import type { Product } from '@amable/api-types';
import {
  BUMP_POSITIONS,
  BUMP_SKINS,
  OFFER_KEY_RE,
  type Bump,
  type CheckoutDefinition,
  type CheckoutItem,
  type Offer,
} from '@amable/checkout';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useMoney } from '../api/hooks';
import { ChoiceSelect, FormField, MoneyInput, SectionCard } from './common';

type Edit = (next: CheckoutDefinition) => void;

interface SectionProps {
  definition: CheckoutDefinition;
  edit: Edit;
  products: readonly Product[];
  currency: string;
  disabled: boolean;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

function moved<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const [item] = next.splice(index, 1);
  if (item === undefined) return next;
  next.splice(index + delta, 0, item);
  return next;
}

function RowShell({
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
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === 0} aria-label={t('checkout.action.moveUp')} onClick={() => onMove(-1)}>
          <ArrowUp aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === count - 1} aria-label={t('checkout.action.moveDown')} onClick={() => onMove(1)}>
          <ArrowDown aria-hidden />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('commerce.common.remove')} onClick={onRemove}>
          <Trash2 aria-hidden />
        </Button>
      </div>
      {children}
    </li>
  );
}

function refChoices(products: readonly Product[], kind: 'product' | 'plan') {
  return kind === 'product'
    ? products.map((p) => ({ value: p.id, label: p.name }))
    : products.flatMap((p) => p.plans.map((plan) => ({ value: plan.id, label: `${p.name} — ${plan.name}` })));
}

function catalogPrice(products: readonly Product[], kind: 'product' | 'plan', refId: string): number | null {
  for (const p of products) {
    if (kind === 'product' && p.id === refId) return p.price_minor;
    const plan = p.plans.find((x) => x.id === refId);
    if (kind === 'plan' && plan !== undefined) return plan.price_minor;
  }
  return null;
}

function PriceOverride({
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
    <FormField label={t('checkout.field.price')} hint={catalog === null ? null : t('checkout.field.catalogPrice', { price: money(catalog, currency) })}>
      {(id) => (
        <MoneyInput id={id} value={value} onChange={onChange} currency={currency} disabled={disabled} placeholder={t('checkout.field.priceCatalog')} />
      )}
    </FormField>
  );
}

function QuantityInput({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (n: number) => void }) {
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
          onChange={(e) => onChange(Math.max(1, Math.min(999, Math.trunc(Number(e.target.value)) || 1)))}
        />
      )}
    </FormField>
  );
}

// ------------------------------------------------------------------ items

export function ItemsSection({ definition, edit, products, currency, disabled }: SectionProps) {
  const { t } = useI18n();
  const items = definition.items;
  const settings = definition.settings;
  const setItems = (next: CheckoutItem[]) => edit({ ...definition, items: next });
  const patch = (id: string, value: Partial<CheckoutItem>) => setItems(items.map((i) => (i.id === id ? { ...i, ...value } : i)));
  const add = (kind: 'product' | 'plan') => {
    const first = refChoices(products, kind)[0];
    if (first === undefined) return;
    setItems([
      ...items,
      { id: newId('i'), kind, ref_id: first.value, quantity: 1, price_minor: null, label: '', description: '', image_url: '', preselected: items.length === 0 },
    ]);
  };
  return (
    <SectionCard
      title={t('checkout.tab.products')}
      actions={
        <span className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || items.length >= 20 || products.length === 0} onClick={() => add('product')}>
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
          <FormField label={t('checkout.items.selection')} hint={t(`checkout.items.selection.${settings.item_selection}.hint`)}>
            {(id) => (
              <ChoiceSelect
                id={id}
                value={settings.item_selection}
                disabled={disabled}
                onChange={(value) => edit({ ...definition, settings: { ...settings, item_selection: value === 'one' ? 'one' : 'all' } })}
                choices={(['all', 'one'] as const).map((value) => ({ value, label: t(`checkout.items.selection.${value}`) }))}
                className="w-full"
              />
            )}
          </FormField>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Switch
              checked={settings.allow_quantity}
              disabled={disabled}
              onCheckedChange={(allow_quantity) => edit({ ...definition, settings: { ...settings, allow_quantity } })}
            />
            {t('checkout.items.allowQuantity')}
          </label>
        </div>
        {items.length === 0 ? <p className="text-sm text-muted-foreground">{t('checkout.items.empty')}</p> : null}
        <ol className="grid gap-3">
          {items.map((item, index) => (
            <RowShell
              key={item.id}
              title={`${t(`checkout.items.kind.${item.kind}`)} · ${refChoices(products, item.kind).find((c) => c.value === item.ref_id)?.label ?? item.ref_id}`}
              index={index}
              count={items.length}
              disabled={disabled}
              onMove={(delta) => setItems(moved(items, index, delta))}
              onRemove={() => setItems(items.filter((i) => i.id !== item.id))}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label={item.kind === 'plan' ? t('commerce.field.plan') : t('commerce.field.product')} className="sm:col-span-2">
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
                <QuantityInput value={item.quantity} disabled={disabled} onChange={(quantity) => patch(item.id, { quantity })} />
                <PriceOverride
                  value={item.price_minor}
                  catalog={catalogPrice(products, item.kind, item.ref_id)}
                  currency={currency}
                  disabled={disabled}
                  onChange={(price_minor) => patch(item.id, { price_minor })}
                />
                <FormField label={t('checkout.field.label')} hint={t('checkout.field.labelHint')}>
                  {(id) => <Input id={id} value={item.label} maxLength={200} disabled={disabled} onChange={(e) => patch(item.id, { label: e.target.value })} />}
                </FormField>
                <FormField label={t('checkout.field.imageUrl')}>
                  {(id) => <Input id={id} type="url" value={item.image_url} disabled={disabled} onChange={(e) => patch(item.id, { image_url: e.target.value.trim() })} />}
                </FormField>
                <FormField label={t('commerce.field.description')} className="sm:col-span-3">
                  {(id) => <Input id={id} value={item.description} maxLength={1000} disabled={disabled} onChange={(e) => patch(item.id, { description: e.target.value })} />}
                </FormField>
              </div>
              {settings.item_selection === 'one' ? (
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={item.preselected}
                    disabled={disabled}
                    onCheckedChange={(on) => setItems(items.map((i) => ({ ...i, preselected: i.id === item.id ? on : on ? false : i.preselected })))}
                  />
                  {t('checkout.items.preselected')}
                </label>
              ) : null}
            </RowShell>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}

// ------------------------------------------------------------------ bumps

export function BumpsSection({ definition, edit, products, currency, disabled }: SectionProps) {
  const { t } = useI18n();
  const bumps = definition.bumps;
  const setBumps = (next: Bump[]) => edit({ ...definition, bumps: next });
  const patch = (id: string, value: Partial<Bump>) => setBumps(bumps.map((b) => (b.id === id ? { ...b, ...value } : b)));
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
        <Button type="button" variant="outline" size="sm" disabled={disabled || bumps.length >= 5 || products.length === 0} onClick={add}>
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
                <QuantityInput value={bump.quantity} disabled={disabled} onChange={(quantity) => patch(bump.id, { quantity })} />
                <FormField label={t('checkout.bumps.title')} className="sm:col-span-2">
                  {(id) => <Input id={id} value={bump.title} maxLength={200} disabled={disabled} onChange={(e) => patch(bump.id, { title: e.target.value })} />}
                </FormField>
                <PriceOverride
                  value={bump.price_minor}
                  catalog={catalogPrice(products, 'product', bump.product_id)}
                  currency={currency}
                  disabled={disabled}
                  onChange={(price_minor) => patch(bump.id, { price_minor })}
                />
                <FormField label={t('commerce.field.description')} className="sm:col-span-3">
                  {(id) => <Textarea id={id} rows={2} value={bump.description} maxLength={2000} disabled={disabled} onChange={(e) => patch(bump.id, { description: e.target.value })} />}
                </FormField>
                <FormField label={t('checkout.bumps.skin')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={bump.skin}
                      disabled={disabled}
                      onChange={(value) => patch(bump.id, { skin: (BUMP_SKINS as readonly string[]).includes(value) ? (value as Bump['skin']) : 'classic' })}
                      choices={BUMP_SKINS.map((value) => ({ value, label: t(`checkout.bumps.skin.${value}`) }))}
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
                        patch(bump.id, { position: (BUMP_POSITIONS as readonly string[]).includes(value) ? (value as Bump['position']) : 'above_payment' })
                      }
                      choices={BUMP_POSITIONS.map((value) => ({ value, label: t(`checkout.bumps.position.${value}`) }))}
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
                      <Input id={id} value={bump.color} disabled={disabled} onChange={(e) => patch(bump.id, { color: e.target.value })} />
                    </div>
                  )}
                </FormField>
                <FormField label={t('checkout.field.imageUrl')} className="sm:col-span-2">
                  {(id) => <Input id={id} type="url" value={bump.image_url} disabled={disabled} onChange={(e) => patch(bump.id, { image_url: e.target.value.trim() })} />}
                </FormField>
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <Switch checked={bump.checked} disabled={disabled} onCheckedChange={(checked) => patch(bump.id, { checked })} />
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

// ----------------------------------------------------------------- offers

function offerKey(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'offer';
  let key = OFFER_KEY_RE.test(base) ? base : `o-${base}`;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${String(n)}`;
  return key;
}

export function OffersSection({ definition, edit, products, currency, disabled }: SectionProps) {
  const { t } = useI18n();
  const offers = definition.offers;
  const settings = definition.settings;
  const setOffers = (next: Offer[], first = settings.first_offer) => {
    const keys = new Set(next.map((o) => o.key));
    const valid = (key: string) => (keys.has(key) ? key : '');
    edit({
      ...definition,
      offers: next.map((o) => ({ ...o, on_accept: valid(o.on_accept), on_decline: valid(o.on_decline) })),
      settings: { ...settings, first_offer: valid(first) },
    });
  };
  const patch = (key: string, value: Partial<Offer>) => setOffers(offers.map((o) => (o.key === key ? { ...o, ...value } : o)));
  const add = (kind: Offer['kind']) => {
    const first = products[0];
    if (first === undefined) return;
    const title = kind === 'upsell' ? t('checkout.offers.defaultUpsell') : t('checkout.offers.defaultDownsell');
    const key = offerKey(title, new Set(offers.map((o) => o.key)));
    const next: Offer = {
      key,
      kind,
      item_kind: 'product',
      ref_id: first.id,
      quantity: 1,
      price_minor: null,
      title,
      description: '',
      page_url: '',
      on_accept: '',
      on_decline: '',
    };
    setOffers([...offers, next], settings.first_offer === '' ? key : settings.first_offer);
  };
  const offerChoices = (except: string) =>
    offers.filter((o) => o.key !== except).map((o) => ({ value: o.key, label: `${o.title} (${t(`checkout.offers.kind.${o.kind}`)})` }));

  return (
    <SectionCard
      title={t('checkout.tab.offers')}
      actions={
        <span className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || offers.length >= 10 || products.length === 0} onClick={() => add('upsell')}>
            <Plus aria-hidden /> {t('checkout.offers.addUpsell')}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={disabled || offers.length >= 10 || products.length === 0} onClick={() => add('downsell')}>
            <Plus aria-hidden /> {t('checkout.offers.addDownsell')}
          </Button>
        </span>
      }
    >
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t('checkout.offers.intro')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={t('checkout.offers.first')} hint={t('checkout.offers.firstHint')}>
            {(id) => (
              <ChoiceSelect
                id={id}
                value={settings.first_offer}
                disabled={disabled}
                emptyLabel={t('checkout.offers.none')}
                onChange={(first) => setOffers(offers, first)}
                choices={offerChoices('')}
                className="w-full"
              />
            )}
          </FormField>
          <FormField label={t('checkout.offers.window')} hint={t('checkout.offers.windowHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={5}
                max={1440}
                value={settings.offer_window_minutes}
                disabled={disabled}
                onChange={(e) =>
                  edit({ ...definition, settings: { ...settings, offer_window_minutes: Math.max(5, Math.min(1440, Math.trunc(Number(e.target.value)) || 60)) } })
                }
              />
            )}
          </FormField>
        </div>
        <ol className="grid gap-3">
          {offers.map((offer, index) => (
            <RowShell
              key={offer.key}
              title={
                <>
                  <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{offer.key}</span>
                  {t(`checkout.offers.kind.${offer.kind}`)} · {offer.title}
                </>
              }
              index={index}
              count={offers.length}
              disabled={disabled}
              onMove={(delta) => setOffers(moved(offers, index, delta))}
              onRemove={() => setOffers(offers.filter((o) => o.key !== offer.key))}
            >
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label={t('checkout.offers.kind')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={offer.kind}
                      disabled={disabled}
                      onChange={(value) => patch(offer.key, { kind: value === 'downsell' ? 'downsell' : 'upsell' })}
                      choices={(['upsell', 'downsell'] as const).map((value) => ({ value, label: t(`checkout.offers.kind.${value}`) }))}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.offers.itemKind')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={offer.item_kind}
                      disabled={disabled}
                      onChange={(value) => {
                        const item_kind = value === 'plan' ? 'plan' : 'product';
                        patch(offer.key, { item_kind, ref_id: refChoices(products, item_kind)[0]?.value ?? offer.ref_id });
                      }}
                      choices={(['product', 'plan'] as const).map((value) => ({ value, label: t(`checkout.items.kind.${value}`) }))}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField label={offer.item_kind === 'plan' ? t('commerce.field.plan') : t('commerce.field.product')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={offer.ref_id}
                      disabled={disabled}
                      onChange={(ref_id) => patch(offer.key, { ref_id })}
                      choices={refChoices(products, offer.item_kind)}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.bumps.title')} className="sm:col-span-2">
                  {(id) => <Input id={id} value={offer.title} maxLength={200} disabled={disabled} onChange={(e) => patch(offer.key, { title: e.target.value })} />}
                </FormField>
                <QuantityInput value={offer.quantity} disabled={disabled} onChange={(quantity) => patch(offer.key, { quantity })} />
                <PriceOverride
                  value={offer.price_minor}
                  catalog={catalogPrice(products, offer.item_kind, offer.ref_id)}
                  currency={currency}
                  disabled={disabled}
                  onChange={(price_minor) => patch(offer.key, { price_minor })}
                />
                <FormField label={t('checkout.offers.pageUrl')} hint={t('checkout.offers.pageUrlHint')} className="sm:col-span-2">
                  {(id) => <Input id={id} type="url" value={offer.page_url} disabled={disabled} onChange={(e) => patch(offer.key, { page_url: e.target.value.trim() })} />}
                </FormField>
                <FormField label={t('commerce.field.description')} className="sm:col-span-3">
                  {(id) => <Textarea id={id} rows={2} value={offer.description} maxLength={2000} disabled={disabled} onChange={(e) => patch(offer.key, { description: e.target.value })} />}
                </FormField>
                <FormField label={t('checkout.offers.onAccept')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={offer.on_accept}
                      disabled={disabled}
                      emptyLabel={t('checkout.offers.thankYou')}
                      onChange={(on_accept) => patch(offer.key, { on_accept })}
                      choices={offerChoices(offer.key)}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.offers.onDecline')}>
                  {(id) => (
                    <ChoiceSelect
                      id={id}
                      value={offer.on_decline}
                      disabled={disabled}
                      emptyLabel={t('checkout.offers.thankYou')}
                      onChange={(on_decline) => patch(offer.key, { on_decline })}
                      choices={offerChoices(offer.key)}
                      className="w-full"
                    />
                  )}
                </FormField>
              </div>
            </RowShell>
          ))}
        </ol>
      </div>
    </SectionCard>
  );
}
