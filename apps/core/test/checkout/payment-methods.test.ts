import { paymentMethodTypesFor } from '@amable/checkout';
import { describe, expect, it } from 'vitest';
import { settledPaymentDomains } from '../../src/commerce/stripe/account';
import { sameMethods } from '../../src/commerce/stripe/client';
import { walletHost } from '../../src/commerce/stripe/payment-domains';
import { createTestTenant } from '../crm/helpers';

describe('payment methods of a checkout', () => {
  it('automatic mode leaves the choice to Stripe', () => {
    expect(
      paymentMethodTypesFor({ mode: 'automatic', types: ['card', 'klarna'], wallets: true }, false),
    ).toBeNull();
  });

  it('custom mode always offers the card, in a fixed order, and only reusable methods when saving', () => {
    const choice = {
      mode: 'custom' as const,
      types: ['klarna' as const, 'sepa_debit' as const, 'link' as const],
      wallets: false,
    };
    expect(paymentMethodTypesFor(choice, false)).toEqual(['card', 'link', 'klarna', 'sepa_debit']);
    expect(paymentMethodTypesFor(choice, true)).toEqual(['card', 'link', 'sepa_debit']);
  });

  it('an intent is reused only when it offers the same methods', () => {
    expect(sameMethods({ automatic_payment_methods: { enabled: true } }, null)).toBe(true);
    expect(sameMethods({}, null)).toBe(true);
    expect(sameMethods({ automatic_payment_methods: { enabled: true } }, ['card'])).toBe(false);
    expect(
      sameMethods({ automatic_payment_methods: null, payment_method_types: ['link', 'card'] }, [
        'card',
        'link',
      ]),
    ).toBe(true);
    expect(
      sameMethods({ automatic_payment_methods: null, payment_method_types: ['card'] }, [
        'card',
        'link',
      ]),
    ).toBe(false);
    expect(
      sameMethods({ automatic_payment_methods: null, payment_method_types: ['card'] }, null),
    ).toBe(false);
  });
});

describe('wallet domains', () => {
  it('keeps public hostnames only', () => {
    expect(walletHost('https://Shop.Example.com/buy?x=1')).toBe('shop.example.com');
    expect(walletHost('shop.example.com')).toBe('shop.example.com');
    for (const raw of [
      null,
      '',
      'http://localhost:5173/',
      'https://app.localhost',
      'http://192.168.1.10/',
      'https://printer.local',
      'https://[::1]/',
    ]) {
      expect(walletHost(raw)).toBeNull();
    }
  });

  it('remembers registered hosts per Stripe account and retries failures the next day', () => {
    const t = createTestTenant();
    const key = 'pk_test_0123456789abcdef';
    t.op('stripe.saveAccount', {
      tenantId: 'tenant_test',
      publishableKey: key,
      secret: { enc: 'enc:sk_test_0123456789abcdef', hint: 'cdef' },
      webhook: null,
    });
    t.op('stripe.paymentDomainResult', { publishableKey: key, host: 'shop.example.com', ok: true });
    t.op('stripe.paymentDomainResult', {
      publishableKey: key,
      host: 'broken.example.com',
      ok: false,
    });
    const ctx = { db: t.db, now: () => t.clock.now } as never;
    expect(settledPaymentDomains(ctx, key).sort()).toEqual([
      'broken.example.com',
      'shop.example.com',
    ]);
    // Another account: nothing is registered there yet.
    expect(settledPaymentDomains(ctx, 'pk_test_other000000000')).toEqual([]);
    t.clock.now += 25 * 3_600_000;
    expect(settledPaymentDomains(ctx, key)).toEqual(['shop.example.com']);
  });
});
