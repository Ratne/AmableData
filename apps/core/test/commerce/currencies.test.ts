import {
  createProductSchema,
  CURRENCY_CODES,
  currencyMinorUnits,
  currencySchema,
  isCurrencyCode,
  updateCommerceSettingsSchema,
} from '@amable/api-types';
import { describe, expect, it } from 'vitest';

describe('ISO 4217 currency list', () => {
  it('holds active codes only, sorted and unique', () => {
    expect(CURRENCY_CODES.length).toBeGreaterThan(140);
    expect([...CURRENCY_CODES].sort()).toEqual(CURRENCY_CODES);
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
    for (const code of ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'KWD', 'XOF', 'XCG', 'ZWG', 'SLE']) {
      expect(isCurrencyCode(code)).toBe(true);
    }
    for (const code of ['HRK', 'SLL', 'ZWL', 'CUC', 'XAU', 'XTS', 'XXX', 'eur', 'ABC']) {
      expect(isCurrencyCode(code)).toBe(false);
    }
  });

  it('knows the minor-unit exponent and agrees with Intl on the common ones', () => {
    expect(currencyMinorUnits('EUR')).toBe(2);
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(currencyMinorUnits('KRW')).toBe(0);
    expect(currencyMinorUnits('KWD')).toBe(3);
    expect(currencyMinorUnits('BHD')).toBe(3);
    expect(currencyMinorUnits('NOPE')).toBeNull();
    for (const code of ['EUR', 'USD', 'GBP', 'JPY', 'KWD', 'CHF', 'SEK', 'BHD', 'VND', 'CLP']) {
      const intl = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
        .maximumFractionDigits;
      expect(currencyMinorUnits(code), code).toBe(intl);
    }
  });

  it('validates commerce inputs against the list', () => {
    expect(currencySchema.safeParse('JPY').success).toBe(true);
    expect(currencySchema.safeParse('ABC').success).toBe(false);
    expect(currencySchema.safeParse('eur').success).toBe(false);
    const product = { name: 'Mug', price_minor: 1200 };
    expect(createProductSchema.safeParse({ ...product, currency: 'KWD' }).success).toBe(true);
    expect(createProductSchema.safeParse({ ...product, currency: 'QQQ' }).success).toBe(false);
    expect(updateCommerceSettingsSchema.safeParse({ default_currency: 'HRK' }).success).toBe(false);
    expect(updateCommerceSettingsSchema.safeParse({ default_currency: 'CHF' }).success).toBe(true);
  });
});
