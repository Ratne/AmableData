import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  decimalToMinor,
  hashEmail,
  hashPhone,
  hmacSha256Hex,
  microsToMinor,
  minorToMajor,
  normalizeEmail,
  normalizePhone,
  sha256Hex,
} from '../src';
import { HASH } from './helpers';

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 vectors', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hmacSha256Hex matches RFC 4231 test case 2', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  John.Smith@Example.COM ')).toBe('john.smith@example.com');
  });

  it('keeps dots and aliases unless gmail canonicalization is requested', () => {
    expect(normalizeEmail('John.Smith+promo@gmail.com')).toBe('john.smith+promo@gmail.com');
    expect(normalizeEmail('John.Smith+promo@gmail.com', { canonicalizeGmail: true })).toBe(
      'johnsmith@gmail.com',
    );
    expect(normalizeEmail('j.o.h.n.smith@googlemail.com', { canonicalizeGmail: true })).toBe(
      'johnsmith@googlemail.com',
    );
  });

  it('canonicalizes only gmail.com / googlemail.com', () => {
    expect(normalizeEmail('john.smith+x@example.com', { canonicalizeGmail: true })).toBe(
      'john.smith+x@example.com',
    );
    expect(normalizeEmail('john.smith+x@gmail.co', { canonicalizeGmail: true })).toBe(
      'john.smith+x@gmail.co',
    );
  });

  it('rejects implausible addresses', () => {
    for (const bad of ['', 'nope', '@example.com', 'a@', 'a@b@c.com', 'a b@c.com', 'a@localhost']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
    expect(normalizeEmail('+tag@gmail.com', { canonicalizeGmail: true })).toBeNull();
  });
});

describe('normalizePhone', () => {
  it('accepts + and 00 international prefixes with separators', () => {
    expect(normalizePhone('+39 333 123 4567')).toBe('393331234567');
    expect(normalizePhone('0039 (333) 123-4567')).toBe('393331234567');
    expect(normalizePhone('+1 (555) 123-4567')).toBe('15551234567');
  });

  it('applies the default calling code to national numbers', () => {
    expect(normalizePhone('333 1234567', { defaultCallingCode: '39' })).toBe('393331234567');
    // Italy keeps the leading 0 of landlines.
    expect(normalizePhone('06 1234 5678', { defaultCallingCode: '39' })).toBe('390612345678');
    // Elsewhere the national trunk 0 is dropped.
    expect(normalizePhone('020 7946 0958', { defaultCallingCode: '+44' })).toBe('442079460958');
    expect(normalizePhone('+39 3331234567', { defaultCallingCode: '1' })).toBe('393331234567');
  });

  it('rejects letters and out-of-range lengths', () => {
    expect(normalizePhone('call me')).toBeNull();
    expect(normalizePhone('+39 333 12a 4567')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1234567890123456')).toBeNull();
    expect(normalizePhone('0612345678')).toBeNull();
  });
});

describe('hashEmail / hashPhone', () => {
  it('hashes the normalized email', async () => {
    expect(await hashEmail('  TEST@Example.com')).toBe(HASH.testExample);
    expect(await hashEmail('John.Smith@Example.com', { canonicalizeGmail: true })).toBe(
      HASH.johnDotSmithExample,
    );
  });

  it('gmail dots and alias collapse to the same hash', async () => {
    const variants = [
      'johnsmith@gmail.com',
      'John.Smith@gmail.com',
      'j.o.h.n.s.m.i.t.h+ads@GMAIL.com ',
    ];
    for (const v of variants)
      expect(await hashEmail(v, { canonicalizeGmail: true })).toBe(HASH.johnsmithGmail);
  });

  it('hashes phones with or without the plus', async () => {
    expect(await hashPhone('+39 333 123 4567')).toBe(HASH.phoneIt);
    expect(await hashPhone('333-123-4567', { defaultCallingCode: '39', withPlus: true })).toBe(
      HASH.phoneItPlus,
    );
    expect(await hashPhone('001 555 123 4567')).toBe(HASH.phoneUs);
    expect(await hashPhone('(555) 123-4567', { defaultCallingCode: '1', withPlus: true })).toBe(
      HASH.phoneUsPlus,
    );
  });

  it('returns null for invalid input', async () => {
    expect(await hashEmail('not-an-email')).toBeNull();
    expect(await hashPhone('abc')).toBeNull();
  });
});

describe('money', () => {
  it('knows minor unit exponents', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('converts decimal major amounts half-up without float drift', () => {
    expect(decimalToMinor('12.34', 'EUR')).toBe(1234);
    expect(decimalToMinor('12.345', 'EUR')).toBe(1235);
    expect(decimalToMinor('12.344', 'EUR')).toBe(1234);
    expect(decimalToMinor('7', 'EUR')).toBe(700);
    expect(decimalToMinor(1.005, 'EUR')).toBe(101);
    expect(decimalToMinor(0.1 + 0.2, 'EUR')).toBe(30);
    expect(decimalToMinor('1500.6', 'JPY')).toBe(1501);
    expect(decimalToMinor('1.2345', 'KWD')).toBe(1235);
    expect(decimalToMinor(null, 'EUR')).toBe(0);
    expect(decimalToMinor('n/a', 'EUR')).toBe(0);
  });

  it('converts Google micros to minor units', () => {
    expect(microsToMinor('12340000', 'EUR')).toBe(1234);
    expect(microsToMinor('12345000', 'EUR')).toBe(1235);
    expect(microsToMinor('12344999', 'EUR')).toBe(1234);
    expect(microsToMinor('1500000000', 'JPY')).toBe(1500);
    expect(microsToMinor('1234500', 'KWD')).toBe(1235);
    expect(microsToMinor('987654321987654321', 'USD')).toBe(98765432198765);
    expect(microsToMinor(undefined, 'USD')).toBe(0);
  });

  it('converts minor units back to major values', () => {
    expect(minorToMajor(4999, 'EUR')).toBe(49.99);
    expect(minorToMajor(1500, 'JPY')).toBe(1500);
    expect(minorToMajor(1235, 'KWD')).toBe(1.235);
  });
});
