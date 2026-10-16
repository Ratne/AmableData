import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, csvStream, formatMinor } from '../../src/reports/csv';
import { monthlyMinor, mrrAt, windowStats, type SubscriptionFact } from '../../src/reports/mrr';
import {
  buildBuckets,
  compareRange,
  parseDate,
  rangeMs,
  resolvePreset,
  startOfLocalDay,
} from '../../src/reports/time';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function sub(partial: Partial<SubscriptionFact> & Pick<SubscriptionFact, 'id'>): SubscriptionFact {
  return {
    plan_id: 'plan',
    product_id: 'prod',
    status: 'active',
    quantity: 1,
    unit_price_minor: 1000,
    interval: 'month',
    interval_count: 1,
    started_at: T0,
    trial_ends_at: null,
    paused_at: null,
    ended_at: null,
    ...partial,
  };
}

describe('MRR normalization', () => {
  it('normalizes every billing interval to a month, half-up, in integer minor units', () => {
    expect(
      monthlyMinor({ quantity: 2, unit_price_minor: 4_900, interval: 'month', interval_count: 1 }),
    ).toBe(9_800);
    expect(
      monthlyMinor({ quantity: 1, unit_price_minor: 49_000, interval: 'year', interval_count: 1 }),
    ).toBe(4_083);
    expect(
      monthlyMinor({ quantity: 1, unit_price_minor: 10_000, interval: 'month', interval_count: 3 }),
    ).toBe(3_333);
    expect(
      monthlyMinor({ quantity: 1, unit_price_minor: 1_000, interval: 'week', interval_count: 1 }),
    ).toBe(4_333);
    expect(
      monthlyMinor({ quantity: 1, unit_price_minor: 100, interval: 'day', interval_count: 1 }),
    ).toBe(3_042);
    // 15 / 2 = 7.5 → 8 (half-up)
    expect(
      monthlyMinor({ quantity: 1, unit_price_minor: 15, interval: 'month', interval_count: 2 }),
    ).toBe(8);
    expect(
      monthlyMinor({ quantity: 1, unit_price_minor: 0, interval: 'month', interval_count: 1 }),
    ).toBe(0);
  });

  it('counts a subscription from the end of its trial until it ends or is paused', () => {
    const trial = sub({ id: 't', trial_ends_at: T0 + 14 * DAY });
    const ended = sub({ id: 'e', ended_at: T0 + 40 * DAY });
    const paused = sub({ id: 'p', status: 'paused', paused_at: T0 + 20 * DAY });
    const all = [trial, ended, paused];
    expect(mrrAt(all, T0 + DAY)).toEqual({ mrr: 2_000, active: 2 });
    expect(mrrAt(all, T0 + 15 * DAY)).toEqual({ mrr: 3_000, active: 3 });
    expect(mrrAt(all, T0 + 25 * DAY)).toEqual({ mrr: 2_000, active: 2 });
    expect(mrrAt(all, T0 + 45 * DAY)).toEqual({ mrr: 1_000, active: 1 });
  });
});

describe('churn math', () => {
  it('computes new, churned, churn rate inputs and revenue churn of a window', () => {
    const subs = [
      sub({ id: 'a' }),
      sub({ id: 'b', unit_price_minor: 3_000 }),
      sub({ id: 'c', ended_at: T0 + 35 * DAY }),
      sub({ id: 'd', started_at: T0 + 40 * DAY }),
      // Trial cancelled before converting: not churn, not new.
      sub({
        id: 'e',
        started_at: T0 + 32 * DAY,
        trial_ends_at: T0 + 46 * DAY,
        ended_at: T0 + 45 * DAY,
      }),
    ];
    const feb = windowStats(subs, T0 + 31 * DAY, T0 + 59 * DAY);
    expect(feb).toEqual({
      mrr: 5_000,
      active: 3,
      active_start: 3,
      mrr_start: 5_000,
      new: 1,
      new_mrr: 1_000,
      churned: 1,
      churned_mrr: 1_000,
    });
    // churn rate = 1 / 3, revenue churn = 1000 / 5000 (derived by the engine).
  });
});

describe('report calendar', () => {
  it('resolves presets around a local day and the comparison periods', () => {
    const today = parseDate('2026-10-15');
    expect(resolvePreset('last_7_days', today)).toEqual({
      from: parseDate('2026-10-09'),
      to: today,
    });
    expect(resolvePreset('last_month', today)).toEqual({
      from: parseDate('2026-09-01'),
      to: parseDate('2026-09-30'),
    });
    expect(resolvePreset('last_12_months', today).from).toEqual(parseDate('2025-11-01'));
    expect(resolvePreset('this_quarter', today).from).toEqual(parseDate('2026-10-01'));
    const range = { from: parseDate('2026-03-01'), to: parseDate('2026-03-31') };
    expect(compareRange(range, 'previous_period')).toEqual({
      from: parseDate('2026-01-29'),
      to: parseDate('2026-02-28'),
    });
    expect(
      compareRange({ from: parseDate('2024-02-29'), to: parseDate('2024-02-29') }, 'previous_year'),
    ).toEqual({
      from: parseDate('2023-02-28'),
      to: parseDate('2023-02-28'),
    });
    expect(compareRange(range, 'none')).toBeNull();
  });

  it('builds day, Monday-week and month buckets on local midnights of the time zone', () => {
    const range = { from: parseDate('2026-03-27'), to: parseDate('2026-04-02') };
    const days = buildBuckets(range, 'day', 'Europe/Rome');
    expect(days.keys).toHaveLength(7);
    // DST starts on 2026-03-29 in Rome: that local day lasts 23 hours.
    const dst = days.keys.indexOf('2026-03-29');
    expect((days.bounds[dst + 1] ?? 0) - (days.bounds[dst] ?? 0)).toBe(23 * 3_600_000);
    expect(days.bounds[0]).toBe(Date.UTC(2026, 2, 26, 23));
    const weeks = buildBuckets(range, 'week', 'UTC');
    expect(weeks.keys).toEqual(['2026-03-27', '2026-03-30']);
    const months = buildBuckets(
      { from: parseDate('2026-01-15'), to: parseDate('2026-03-10') },
      'month',
      'UTC',
    );
    expect(months.keys).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(months.bounds[1]).toBe(Date.UTC(2026, 1, 1));
    expect(months.bounds[3]).toBe(Date.UTC(2026, 2, 11));
    expect(rangeMs(range, 'UTC')).toEqual({
      from: Date.UTC(2026, 2, 27),
      to: Date.UTC(2026, 3, 3),
    });
    expect(startOfLocalDay(parseDate('2026-07-01'), 'America/New_York')).toBe(
      Date.UTC(2026, 6, 1, 4),
    );
    expect(() =>
      buildBuckets({ from: parseDate('2020-01-01'), to: parseDate('2026-01-01') }, 'day', 'UTC'),
    ).toThrow(/buckets/);
  });
});

describe('CSV export', () => {
  it('quotes, neutralizes formulas and formats minor units exactly', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(csvLine(['x', 1, null])).toBe('x,1,\r\n');
    expect(formatMinor(123_456, 'EUR')).toBe('1234.56');
    expect(formatMinor(-5, 'EUR')).toBe('-0.05');
    expect(formatMinor(1_500, 'JPY')).toBe('1500');
  });

  it('streams the header then each page lazily, and stops pulling when cancelled', async () => {
    let pulled = 0;
    async function* pages(): AsyncGenerator<Array<Array<string | number | null>>> {
      for (let i = 0; i < 3; i += 1) {
        pulled += 1;
        yield [[`row ${String(i)}`, i]];
      }
    }
    const reader = csvStream(['label', 'value'], pages()).getReader();
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: false });
    const chunks: string[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    expect(chunks).toEqual(['\uFEFFlabel,value\r\n', 'row 0,0\r\n', 'row 1,1\r\n', 'row 2,2\r\n']);
    expect(pulled).toBe(3);

    pulled = 0;
    const partial = csvStream(['h'], pages()).getReader();
    await partial.read();
    await partial.read();
    await partial.cancel();
    expect(pulled).toBe(1);
  });
});
