import { describe, expect, it } from 'vitest';
import { addInterval, allocate, computeTotals, mulDivRound, taxOf } from '../../src/commerce/money';

describe('integer money math', () => {
  it('rounds half up without floating point drift', () => {
    expect(mulDivRound(1005, 1, 10)).toBe(101); // 100.5 -> 101
    expect(mulDivRound(1004, 1, 10)).toBe(100);
    expect(taxOf(999, 2200)).toBe(220); // 219.78
    expect(taxOf(1, 2200)).toBe(0); // 0.22
    expect(taxOf(3, 2200)).toBe(1); // 0.66
    // Large values stay exact (BigInt products).
    expect(taxOf(99_999_999_999, 2200)).toBe(22_000_000_000);
  });

  it('allocates exactly with the largest remainder, ties to the earliest line', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [0, 5, 5])).toEqual([0, 5, 5]);
    expect(allocate(7, [3333, 3333, 3334])).toEqual([2, 2, 3]);
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    for (const total of [1, 99, 1001, 123_457]) {
      const shares = allocate(total, [17, 4, 33, 1]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('computes line and order totals: discount allocated, tax per line, shipping untaxed', () => {
    const totals = computeTotals(
      [
        { quantity: 2, unitPriceMinor: 1999, taxRateBps: 2200, discountable: true },
        { quantity: 1, unitPriceMinor: 1000, taxRateBps: 1000, discountable: true },
        { quantity: 3, unitPriceMinor: 333, taxRateBps: 0, discountable: false },
      ],
      { kind: 'percent', percentBps: 1000, amountMinor: null },
      590,
    );
    // eligible = 3998 + 1000 = 4998 -> 10% = 499.8 -> 500
    expect(totals.subtotalMinor).toBe(3998 + 1000 + 999);
    expect(totals.eligibleMinor).toBe(4998);
    expect(totals.discountMinor).toBe(500);
    expect(totals.lines.map((l) => l.discountMinor)).toEqual([400, 100, 0]);
    // tax: (3998-400)*22% = 791.56 -> 792; (1000-100)*10% = 90; 0
    expect(totals.lines.map((l) => l.taxMinor)).toEqual([792, 90, 0]);
    expect(totals.taxMinor).toBe(882);
    expect(totals.totalMinor).toBe(5997 - 500 + 882 + 590);
    expect(totals.lines.reduce((a, l) => a + l.totalMinor, 0) + 590).toBe(totals.totalMinor);
  });

  it('caps fixed discounts at the eligible subtotal', () => {
    const totals = computeTotals(
      [{ quantity: 1, unitPriceMinor: 1500, taxRateBps: 2200, discountable: true }],
      { kind: 'fixed', percentBps: null, amountMinor: 2000 },
      0,
    );
    expect(totals.discountMinor).toBe(1500);
    expect(totals.taxMinor).toBe(0);
    expect(totals.totalMinor).toBe(0);
  });

  it('adds calendar months clamped to the month end', () => {
    const jan31 = Date.UTC(2026, 0, 31, 10);
    expect(new Date(addInterval(jan31, 'month', 1)).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    // Anchored arithmetic: anchor + 2 months lands on Mar 31, not Mar 28.
    expect(new Date(addInterval(jan31, 'month', 2)).toISOString()).toBe('2026-03-31T10:00:00.000Z');
    expect(new Date(addInterval(Date.UTC(2024, 1, 29), 'year', 1)).toISOString()).toBe(
      '2025-02-28T00:00:00.000Z',
    );
    expect(addInterval(0, 'week', 2)).toBe(14 * 86_400_000);
  });
});
