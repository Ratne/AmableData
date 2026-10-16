import { describe, expect, it } from 'vitest';
import {
  bpsToInput,
  currencyExponent,
  formatBps,
  formatMoney,
  minorToDecimal,
  minorToInput,
  parseBpsInput,
  parseMoneyInput,
} from '../../src/features/commerce/lib/money';

/** Intl uses (narrow) no-break spaces; compare with plain spaces. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('money formatting', () => {
  it('knows the minor-unit exponent of each currency', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('converts minor units to exact decimals', () => {
    expect(minorToDecimal(123456, 'EUR')).toBe('1234.56');
    expect(minorToDecimal(5, 'EUR')).toBe('0.05');
    expect(minorToDecimal(-250, 'EUR')).toBe('-2.50');
    expect(minorToDecimal(1500, 'JPY')).toBe('1500');
    expect(minorToDecimal(1234, 'KWD')).toBe('1.234');
    // Beyond float precision of a naive minor / 100.
    expect(minorToDecimal(99_999_999_999, 'EUR')).toBe('999999999.99');
  });

  it('formats per locale with Intl', () => {
    expect(plain(formatMoney(12_345_678, 'EUR', 'it'))).toBe('123.456,78 €');
    // Italian CLDR groups only from five integer digits.
    expect(plain(formatMoney(123456, 'EUR', 'it'))).toBe('1234,56 €');
    expect(formatMoney(123456, 'EUR', 'en')).toBe('€1,234.56');
    expect(formatMoney(199, 'USD', 'en')).toBe('$1.99');
    expect(plain(formatMoney(150_000, 'JPY', 'it'))).toBe('150.000 JPY');
    expect(formatMoney(0, 'EUR', 'en')).toBe('€0.00');
  });

  it('falls back to "<amount> <code>" for unknown currencies', () => {
    expect(formatMoney(1050, 'X1', 'en')).toBe('10.50 X1');
  });

  it('renders editable values in the locale notation', () => {
    expect(minorToInput(1250, 'EUR', 'it')).toBe('12,50');
    expect(minorToInput(1250, 'EUR', 'en')).toBe('12.50');
    expect(minorToInput(700, 'JPY', 'it')).toBe('700');
  });
});

describe('money input parsing', () => {
  it('parses decimals with either separator', () => {
    expect(parseMoneyInput('12,50', 'EUR', 'it')).toBe(1250);
    expect(parseMoneyInput('12.50', 'EUR', 'it')).toBe(1250);
    expect(parseMoneyInput('12.5', 'EUR', 'en')).toBe(1250);
    expect(parseMoneyInput('12', 'EUR', 'en')).toBe(1200);
    expect(parseMoneyInput(',5', 'EUR', 'it')).toBe(50);
  });

  it('understands grouping', () => {
    expect(parseMoneyInput('1.234,56', 'EUR', 'it')).toBe(123456);
    expect(parseMoneyInput('1,234.56', 'EUR', 'en')).toBe(123456);
    expect(parseMoneyInput('1.000.000', 'EUR', 'it')).toBe(100_000_000);
    expect(parseMoneyInput('1,000', 'EUR', 'en')).toBe(100_000);
    expect(parseMoneyInput('1 234,5', 'EUR', 'it')).toBe(123450);
  });

  it('rejects malformed or over-precise input', () => {
    expect(parseMoneyInput('', 'EUR', 'en')).toBeNull();
    expect(parseMoneyInput('abc', 'EUR', 'en')).toBeNull();
    expect(parseMoneyInput('-5', 'EUR', 'en')).toBeNull();
    expect(parseMoneyInput('1.234', 'EUR', 'en')).toBeNull();
    expect(parseMoneyInput('12.5', 'JPY', 'en')).toBeNull();
    expect(parseMoneyInput('1,2,3', 'EUR', 'it')).toBeNull();
  });

  it('round-trips through the editable form', () => {
    for (const minor of [0, 1, 99, 1250, 123456, 99_999_999_999]) {
      for (const locale of ['en', 'it']) {
        expect(parseMoneyInput(minorToInput(minor, 'EUR', locale), 'EUR', locale)).toBe(minor);
      }
    }
  });
});

describe('tax rates in basis points', () => {
  it('formats and parses percentages', () => {
    expect(formatBps(2200, 'en')).toBe('22%');
    expect(plain(formatBps(550, 'it'))).toBe('5,5%');
    expect(bpsToInput(2250, 'it')).toBe('22,5');
    expect(bpsToInput(400, 'en')).toBe('4');
    expect(bpsToInput(1005, 'en')).toBe('10.05');
    expect(parseBpsInput('22', 'it')).toBe(2200);
    expect(parseBpsInput('5,5', 'it')).toBe(550);
    expect(parseBpsInput('10.05%', 'en')).toBe(1005);
    expect(parseBpsInput('101', 'en')).toBeNull();
    expect(parseBpsInput('1.234', 'en')).toBeNull();
  });
});
