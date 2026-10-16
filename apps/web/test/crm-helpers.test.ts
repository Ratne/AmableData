import type { Opportunity } from '@amable/api-types/crm';
import { describe, expect, it } from 'vitest';
import { buildQuery } from '../src/features/crm/api/client';
import { bucketByDay, dayKey, shiftAnchor, visibleRange } from '../src/features/crm/calendar-utils';
import {
  duplicateTargets,
  guessMapping,
  parseCsvPreview,
} from '../src/features/crm/import-mapping';
import { moveDeal } from '../src/features/crm/pages/deals';
import { reorder } from '../src/features/crm/reorder';

describe('API client', () => {
  it('builds query strings without empty values', () => {
    expect(buildQuery({ limit: 50, cursor: undefined, q: '', status: 'open', flag: false })).toBe(
      '?limit=50&status=open&flag=false',
    );
    expect(buildQuery({})).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });
});

describe('CSV import helpers', () => {
  it('parses the preview with quotes, semicolons and BOM', () => {
    const csv =
      '\uFEFFNome;Cognome;Email;Note\r\nAda;"Love; lace";ada@example.com;"say ""hi"""\n\nAlan;Turing;alan@example.com;\n';
    expect(parseCsvPreview(csv)).toEqual([
      ['Nome', 'Cognome', 'Email', 'Note'],
      ['Ada', 'Love; lace', 'ada@example.com', 'say "hi"'],
      ['Alan', 'Turing', 'alan@example.com', ''],
    ]);
  });

  it('guesses the mapping from en/it headers and custom fields, once per target', () => {
    const mapping = guessMapping(
      ['First Name', 'Cognome', 'E-mail', 'Email', 'Piano', 'Tags', 'Whatever'],
      [{ key: 'plan', label: 'Piano' }],
    );
    expect(mapping).toEqual({
      'First Name': 'given_name',
      Cognome: 'family_name',
      'E-mail': 'email',
      Email: 'ignore',
      Piano: 'custom.plan',
      Tags: 'tags',
      Whatever: 'ignore',
    });
    expect(duplicateTargets({ a: 'email', b: 'email', c: 'ignore', d: 'ignore' })).toEqual([
      'email',
    ]);
  });
});

describe('calendar', () => {
  it('shows six Monday-first weeks for a month and seven days for a week', () => {
    const anchor = new Date(2026, 9, 15);
    const month = visibleRange(anchor, 'month');
    expect(month.days).toHaveLength(42);
    expect(month.days[0]?.getDay()).toBe(1);
    expect(dayKey(month.days[0] ?? anchor)).toBe('2026-09-28');
    const week = visibleRange(anchor, 'week');
    expect(week.days.map(dayKey)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(dayKey(shiftAnchor(anchor, 'month', 1))).toBe('2026-11-01');
  });

  it('puts multi-day entries on every day they cover', () => {
    const range = visibleRange(new Date(2026, 9, 15), 'week');
    const start = new Date(2026, 9, 13, 22).getTime();
    const end = new Date(2026, 9, 15, 9).getTime();
    const buckets = bucketByDay([{ id: 'a' }], range, () => ({ start, end }));
    expect([...buckets.keys()]).toEqual(['2026-10-13', '2026-10-14', '2026-10-15']);
  });
});

describe('ordering and kanban', () => {
  it('rewrites only the positions that changed', async () => {
    const saved: Array<[string, number]> = [];
    const items = [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ];
    await reorder(items, 2, -1, async (item, position) => {
      saved.push([item.id, position]);
    });
    expect(saved).toEqual([
      ['c', 1],
      ['b', 2],
    ]);
  });

  it('moves a deal to the dropped stage optimistically', () => {
    const deal = { id: 'd1', stage_id: 's1', status: 'open' } as Opportunity;
    const other = { id: 'd2', stage_id: 's1', status: 'open' } as Opportunity;
    const moved = moveDeal([deal, other], 'd1', { id: 's3', kind: 'won' });
    expect(moved[0]).toMatchObject({ stage_id: 's3', status: 'won' });
    expect(moved[1]).toBe(other);
  });
});
