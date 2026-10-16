import { describe, expect, it } from 'vitest';
import { previousRange, relativeChange } from '../src/features/analytics/lib/range';

describe('analytics KPI comparison', () => {
  it('takes the period of the same length right before the range', () => {
    expect(previousRange({ from: '2026-10-01', to: '2026-10-30' })).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(previousRange({ from: '2026-10-16', to: '2026-10-16' })).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(previousRange({ from: '2026-03-01', to: '2026-03-07' })).toEqual({ from: '2026-02-22', to: '2026-02-28' });
  });

  it('computes the relative change, or null without a baseline', () => {
    expect(relativeChange(150, 100)).toBeCloseTo(0.5);
    expect(relativeChange(50, 100)).toBeCloseTo(-0.5);
    expect(relativeChange(10, 0)).toBeNull();
    expect(relativeChange(Number.NaN, 1)).toBeNull();
  });
});

describe('analytics search params', () => {
  it('keeps values the router parsed as numbers', async () => {
    const { searchString } = await import('../src/features/analytics/lib/search');
    expect(searchString(1)).toBe('1');
    expect(searchString('abc')).toBe('abc');
    expect(searchString('')).toBeUndefined();
    expect(searchString(Number.NaN)).toBeUndefined();
    expect(searchString({})).toBeUndefined();
  });
});
