import { CURRENCY_CODES } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { allCurrencyOptions, currencyOptions, currencySymbol } from '../../src/features/commerce/lib/currencies';

describe('currency options', () => {
  it('lists every active code with a localized name and symbol', () => {
    const it = allCurrencyOptions('it');
    expect(it.map((o) => o.code)).toEqual(CURRENCY_CODES);
    const eur = it.find((o) => o.code === 'EUR');
    expect(eur).toEqual({ code: 'EUR', name: 'euro', symbol: '€' });
    expect(allCurrencyOptions('en').find((o) => o.code === 'USD')?.name).toBe('US Dollar');
    expect(currencySymbol('JPY', 'en')).toBe('¥');
  });

  it('puts the preferred codes first without duplicates', () => {
    const list = currencyOptions('en', ['CHF', 'EUR', 'CHF', 'NOPE']);
    expect(list.slice(0, 2).map((o) => o.code)).toEqual(['CHF', 'EUR']);
    expect(list).toHaveLength(CURRENCY_CODES.length);
  });

  it('keeps a stored legacy code selectable', () => {
    const list = currencyOptions('en', ['EUR'], 'HRK');
    expect(list[0]?.code).toBe('HRK');
    expect(list).toHaveLength(CURRENCY_CODES.length + 1);
  });
});
