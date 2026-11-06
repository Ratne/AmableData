import { OFFER_KEY_RE, type Offer } from '@amable/checkout';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { Plus } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect, FormField, SectionCard } from '../common';
import {
  catalogPrice,
  moved,
  PriceOverride,
  QuantityInput,
  refChoices,
  RowShell,
  type SectionProps,
} from './shared';

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
      offers: next.map((o) => ({
        ...o,
        on_accept: valid(o.on_accept),
        on_decline: valid(o.on_decline),
      })),
      settings: { ...settings, first_offer: valid(first) },
    });
  };
  const patch = (key: string, value: Partial<Offer>) =>
    setOffers(offers.map((o) => (o.key === key ? { ...o, ...value } : o)));
  const add = (kind: Offer['kind']) => {
    const first = products[0];
    if (first === undefined) return;
    const title =
      kind === 'upsell' ? t('checkout.offers.defaultUpsell') : t('checkout.offers.defaultDownsell');
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
      image_url: '',
      page_url: '',
      on_accept: '',
      on_decline: '',
    };
    setOffers([...offers, next], settings.first_offer === '' ? key : settings.first_offer);
  };
  const offerChoices = (except: string) =>
    offers
      .filter((o) => o.key !== except)
      .map((o) => ({ value: o.key, label: `${o.title} (${t(`checkout.offers.kind.${o.kind}`)})` }));

  return (
    <SectionCard
      title={t('checkout.tab.offers')}
      actions={
        <span className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || offers.length >= 10 || products.length === 0}
            onClick={() => add('upsell')}
          >
            <Plus aria-hidden /> {t('checkout.offers.addUpsell')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || offers.length >= 10 || products.length === 0}
            onClick={() => add('downsell')}
          >
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
                  edit({
                    ...definition,
                    settings: {
                      ...settings,
                      offer_window_minutes: Math.max(
                        5,
                        Math.min(1440, Math.trunc(Number(e.target.value)) || 60),
                      ),
                    },
                  })
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
                  <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {offer.key}
                  </span>
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
                      onChange={(value) =>
                        patch(offer.key, { kind: value === 'downsell' ? 'downsell' : 'upsell' })
                      }
                      choices={(['upsell', 'downsell'] as const).map((value) => ({
                        value,
                        label: t(`checkout.offers.kind.${value}`),
                      }))}
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
                        patch(offer.key, {
                          item_kind,
                          ref_id: refChoices(products, item_kind)[0]?.value ?? offer.ref_id,
                        });
                      }}
                      choices={(['product', 'plan'] as const).map((value) => ({
                        value,
                        label: t(`checkout.items.kind.${value}`),
                      }))}
                      className="w-full"
                    />
                  )}
                </FormField>
                <FormField
                  label={
                    offer.item_kind === 'plan'
                      ? t('commerce.field.plan')
                      : t('commerce.field.product')
                  }
                >
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
                  {(id) => (
                    <Input
                      id={id}
                      value={offer.title}
                      maxLength={200}
                      disabled={disabled}
                      onChange={(e) => patch(offer.key, { title: e.target.value })}
                    />
                  )}
                </FormField>
                <QuantityInput
                  value={offer.quantity}
                  disabled={disabled}
                  onChange={(quantity) => patch(offer.key, { quantity })}
                />
                <PriceOverride
                  value={offer.price_minor}
                  catalog={catalogPrice(products, offer.item_kind, offer.ref_id)}
                  currency={currency}
                  disabled={disabled}
                  onChange={(price_minor) => patch(offer.key, { price_minor })}
                />
                <FormField
                  label={t('checkout.offers.pageUrl')}
                  hint={t('checkout.offers.pageUrlHint')}
                  className="sm:col-span-2"
                >
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      value={offer.page_url}
                      disabled={disabled}
                      onChange={(e) => patch(offer.key, { page_url: e.target.value.trim() })}
                    />
                  )}
                </FormField>
                <FormField label={t('checkout.field.imageUrl')} className="sm:col-span-3">
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      value={offer.image_url}
                      disabled={disabled}
                      onChange={(e) => patch(offer.key, { image_url: e.target.value.trim() })}
                    />
                  )}
                </FormField>
                <FormField label={t('commerce.field.description')} className="sm:col-span-3">
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={2}
                      value={offer.description}
                      maxLength={2000}
                      disabled={disabled}
                      onChange={(e) => patch(offer.key, { description: e.target.value })}
                    />
                  )}
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
