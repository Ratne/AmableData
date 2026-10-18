import { describe, expect, it } from 'vitest';
import { formatTotals, totalsByCurrency } from '../src/features/crm/components/cells';

describe('board column totals', () => {
  it('sums each currency on its own', () => {
    const deals = [
      { value_minor: 10_000, currency: 'EUR' },
      { value_minor: 5_000, currency: 'USD' },
      { value_minor: 2_500, currency: 'EUR' },
    ];
    expect(totalsByCurrency(deals)).toEqual([
      { currency: 'EUR', minor: 12_500 },
      { currency: 'USD', minor: 5_000 },
    ]);
    expect(formatTotals('en-US', deals, 'EUR')).toBe('€125.00 + $50.00');
  });

  it('shows zero in the fallback currency for an empty column', () => {
    expect(formatTotals('en-US', [], 'EUR')).toBe('€0.00');
  });
});
