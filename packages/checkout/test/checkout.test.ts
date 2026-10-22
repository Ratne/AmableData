import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_STRINGS,
  checkoutDefinitionSchema,
  defaultCheckoutDefinition,
  resolveCheckoutLocale,
  sessionPayloadSchema,
  type CheckoutDefinitionInput,
} from '../src/index';
import { buildBundle, renderModule } from '../scripts/build.mjs';

const issues = (input: CheckoutDefinitionInput) => {
  const result = checkoutDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('checkout definition', () => {
  it('defaults to an empty, valid checkout', () => {
    const d = defaultCheckoutDefinition();
    expect(d.items).toEqual([]);
    expect(d.settings).toMatchObject({ promo_codes: true, promo_param: 'promo', first_offer: '', hosted_enabled: true });
    expect(d.contact).toMatchObject({ name: 'required', address: 'hidden', address_autocomplete: true });
  });

  it('checks the offer chain and the unique ids', () => {
    expect(
      issues({
        offers: [
          { key: 'up', ref_id: 'p1', title: 'Up', on_decline: 'down' },
          { key: 'down', ref_id: 'p1', title: 'Down' },
        ],
        settings: { first_offer: 'up' },
      }),
    ).toEqual([]);
    expect(issues({ settings: { first_offer: 'missing' } })).toEqual(['settings.first_offer: unknown offer']);
    expect(issues({ offers: [{ key: 'up', ref_id: 'p1', title: 'Up', on_accept: 'up' }] })).toEqual(['offers.0.on_accept: unknown offer']);
    expect(
      issues({
        items: [
          { id: 'a', kind: 'product', ref_id: 'p1' },
          { id: 'a', kind: 'product', ref_id: 'p2' },
        ],
      }),
    ).toEqual(['items.1.id: duplicate item id']);
  });

  it('allows one plan per purchase unless the buyer picks one', () => {
    const plans = [
      { id: 'm', kind: 'plan' as const, ref_id: 'monthly' },
      { id: 'y', kind: 'plan' as const, ref_id: 'yearly' },
    ];
    expect(issues({ items: plans })).toHaveLength(1);
    expect(issues({ items: plans, settings: { item_selection: 'one' } })).toEqual([]);
  });

  it('keeps custom fields off the buyer field keys', () => {
    expect(issues({ fields: [{ id: 'f1', kind: 'text', key: 'email', label: 'Email' }] })).toEqual([
      'fields.0.key: reserved for the buyer fields',
    ]);
  });

  it('rejects CSS injection in the style', () => {
    expect(issues({ style: { primary_color: 'red;} body{display:none' } })).not.toEqual([]);
  });
});

describe('session payload', () => {
  it('fills the defaults of a minimal submit', () => {
    const payload = sessionPayloadSchema.parse({ buyer: { email: 'a@example.com' } });
    expect(payload).toMatchObject({
      selection: { items: [], quantities: {}, bumps: [] },
      promo_code: '',
      terms_accepted: false,
      session_token: '',
      buyer: { address: { country: '' } },
    });
  });
});

describe('strings', () => {
  it('covers the same keys in every language', () => {
    expect(Object.keys(CHECKOUT_STRINGS.it).sort()).toEqual(Object.keys(CHECKOUT_STRINGS.en).sort());
  });

  it('picks the locale from the setting or the browser', () => {
    expect(resolveCheckoutLocale('auto', ['de-DE', 'it'])).toBe('it');
    expect(resolveCheckoutLocale('en', ['it'])).toBe('en');
    expect(resolveCheckoutLocale('auto', [])).toBe('en');
  });
});

describe('widget bundle', () => {
  it('is committed up to date, small and free of zod', async () => {
    const bundle = await buildBundle();
    const generated = readFileSync(join(import.meta.dirname, '../generated/bundle.ts'), 'utf8');
    expect(generated).toBe(renderModule(bundle));
    // Larger than the forms widget: it embeds the form fields plus the cart, bumps and offers.
    expect(bundle.length).toBeLessThan(80_000);
    expect(bundle).not.toContain('ZodError');
    expect(bundle).toContain('data-amable-checkout');
    expect(bundle).toContain('data-amable-offer');
  });
});
