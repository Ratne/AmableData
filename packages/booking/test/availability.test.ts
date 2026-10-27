import { describe, expect, it } from 'vitest';
import {
  checkSlot,
  computeSlots,
  groupSlotsByDay,
  pickRoundRobinHost,
  validateAnswers,
  validateInvitee,
  zonedToUtc,
  type EventTypeRules,
  type HostSchedule,
  type WeeklyRule,
} from '../src/index';

const ROME = 'Europe/Rome';
const iso = (ms: number) => new Date(ms).toISOString();
const rome = (y: number, m: number, d: number, hh: number, mm = 0) => zonedToUtc({ y, m, d }, hh * 60 + mm, ROME);

const RULES: EventTypeRules = {
  durationMinutes: 30,
  slotIntervalMinutes: null,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 60,
  maxPerDay: null,
};

const weekdays = (start: string, end: string): WeeklyRule[] =>
  ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, start, end }));

function host(overrides: Partial<HostSchedule> = {}): HostSchedule {
  return {
    calendarId: 'cal_a',
    timeZone: ROME,
    weeklyRules: weekdays('09:00', '12:00'),
    overrides: [],
    busy: [],
    bookedStarts: [],
    ...overrides,
  };
}

// Sunday 2026-10-18 08:00 UTC: the next Monday is 2026-10-19 (CEST, UTC+2).
const NOW = Date.UTC(2026, 9, 18, 8, 0);

function slotsOn(input: { hosts: HostSchedule[]; rules?: Partial<EventTypeRules>; now?: number; assignment?: 'round_robin' | 'collective' }, y: number, m: number, d: number) {
  return computeSlots({
    now: input.now ?? NOW,
    rules: { ...RULES, ...input.rules },
    assignment: input.assignment ?? 'round_robin',
    hosts: input.hosts,
    from: rome(y, m, d, 0),
    to: rome(y, m, d, 23, 59),
  });
}

describe('availability engine', () => {
  it('offers the weekly hours in the calendar time zone as UTC instants', () => {
    const slots = slotsOn({ hosts: [host()] }, 2026, 10, 19);
    expect(slots.map((s) => iso(s.start))).toEqual([
      '2026-10-19T07:00:00.000Z',
      '2026-10-19T07:30:00.000Z',
      '2026-10-19T08:00:00.000Z',
      '2026-10-19T08:30:00.000Z',
      '2026-10-19T09:00:00.000Z',
      '2026-10-19T09:30:00.000Z',
    ]);
    expect(slots[0]?.end).toBe(Date.UTC(2026, 9, 19, 7, 30));
    expect(slotsOn({ hosts: [host()] }, 2026, 10, 18)).toEqual([]);
  });

  it('follows DST: same wall-clock hours, different UTC offsets around the change', () => {
    const before = slotsOn({ hosts: [host()], now: Date.UTC(2026, 2, 20) }, 2026, 3, 27);
    const after = slotsOn({ hosts: [host()], now: Date.UTC(2026, 2, 20) }, 2026, 3, 30);
    expect(iso(before[0]?.start ?? 0)).toBe('2026-03-27T08:00:00.000Z');
    expect(iso(after[0]?.start ?? 0)).toBe('2026-03-30T07:00:00.000Z');
  });

  it('gives DST days their real length (23 h in spring, 25 h in autumn)', () => {
    const hourly = { durationMinutes: 60 };
    const spring = slotsOn(
      { hosts: [host({ overrides: [{ date: '2026-03-29', intervals: [{ start: '00:00', end: '04:00' }] }] })], rules: hourly, now: Date.UTC(2026, 2, 20) },
      2026,
      3,
      29,
    );
    expect(spring.map((s) => iso(s.start))).toEqual([
      '2026-03-28T23:00:00.000Z',
      '2026-03-29T00:00:00.000Z',
      '2026-03-29T01:00:00.000Z',
    ]);
    const autumn = slotsOn(
      { hosts: [host({ overrides: [{ date: '2026-10-25', intervals: [{ start: '00:00', end: '04:00' }] }] })], rules: hourly },
      2026,
      10,
      25,
    );
    expect(autumn).toHaveLength(5);
    expect(iso(autumn[0]?.start ?? 0)).toBe('2026-10-24T22:00:00.000Z');
    expect(iso(autumn[4]?.start ?? 0)).toBe('2026-10-25T02:00:00.000Z');
  });

  it('applies date overrides: closed days and custom hours', () => {
    const closed = host({ overrides: [{ date: '2026-10-19', intervals: [] }] });
    expect(slotsOn({ hosts: [closed] }, 2026, 10, 19)).toEqual([]);
    const custom = host({ overrides: [{ date: '2026-10-19', intervals: [{ start: '15:00', end: '16:00' }] }] });
    expect(slotsOn({ hosts: [custom] }, 2026, 10, 19).map((s) => iso(s.start))).toEqual([
      '2026-10-19T13:00:00.000Z',
      '2026-10-19T13:30:00.000Z',
    ]);
  });

  it('keeps buffers around busy time and existing bookings', () => {
    const busy = [{ start: rome(2026, 10, 19, 10), end: rome(2026, 10, 19, 10, 30) }];
    const slots = slotsOn({ hosts: [host({ busy })], rules: { bufferBeforeMinutes: 15, bufferAfterMinutes: 15 } }, 2026, 10, 19);
    expect(slots.map((s) => s.start)).toEqual([rome(2026, 10, 19, 9), rome(2026, 10, 19, 11), rome(2026, 10, 19, 11, 30)]);
  });

  it('removes slots overlapping a booking that is not aligned to the grid', () => {
    const busy = [{ start: rome(2026, 10, 19, 9, 15), end: rome(2026, 10, 19, 9, 45) }];
    const starts = slotsOn({ hosts: [host({ busy })] }, 2026, 10, 19).map((s) => s.start);
    expect(starts).not.toContain(rome(2026, 10, 19, 9));
    expect(starts).not.toContain(rome(2026, 10, 19, 9, 30));
    expect(starts).toContain(rome(2026, 10, 19, 10));
  });

  it('honours the slot interval, minimum notice and the booking horizon', () => {
    const interval = slotsOn({ hosts: [host()], rules: { slotIntervalMinutes: 60 } }, 2026, 10, 19);
    expect(interval).toHaveLength(3);
    const now = rome(2026, 10, 19, 9, 10);
    const notice = slotsOn({ hosts: [host()], rules: { minNoticeMinutes: 60 }, now }, 2026, 10, 19);
    expect(notice[0]?.start).toBe(rome(2026, 10, 19, 10, 30));
    const horizon = computeSlots({
      now: NOW,
      rules: { ...RULES, maxDaysAhead: 2 },
      assignment: 'round_robin',
      hosts: [host()],
      from: NOW,
      to: NOW + 10 * 86_400_000,
    });
    expect(iso(horizon[horizon.length - 1]?.start ?? 0)).toBe('2026-10-20T08:00:00.000Z');
    expect(horizon).toHaveLength(9);
  });

  it('enforces the daily cap per host and local day', () => {
    const booked = host({ bookedStarts: [rome(2026, 10, 19, 11)] });
    expect(slotsOn({ hosts: [booked], rules: { maxPerDay: 1 } }, 2026, 10, 19)).toEqual([]);
    expect(slotsOn({ hosts: [booked], rules: { maxPerDay: 1 } }, 2026, 10, 20)).toHaveLength(6);
    expect(slotsOn({ hosts: [booked], rules: { maxPerDay: 2 } }, 2026, 10, 19)).toHaveLength(6);
  });

  it('round robin: any free host makes the slot available', () => {
    const a = host({ calendarId: 'cal_a', busy: [{ start: rome(2026, 10, 19, 9), end: rome(2026, 10, 19, 10) }] });
    const b = host({ calendarId: 'cal_b' });
    const slots = slotsOn({ hosts: [a, b] }, 2026, 10, 19);
    expect(slots).toHaveLength(6);
    expect(slots[0]?.calendarIds).toEqual(['cal_b']);
    expect(slots[2]?.calendarIds).toEqual(['cal_a', 'cal_b']);
  });

  it('round robin picks the least loaded, then least recently assigned host', () => {
    const a = host({ calendarId: 'cal_a', load: { count: 3, lastAssignedAt: 1 } });
    const b = host({ calendarId: 'cal_b', load: { count: 1, lastAssignedAt: 50 } });
    const c = host({ calendarId: 'cal_c', load: { count: 1, lastAssignedAt: 10 } });
    expect(pickRoundRobinHost([a, b, c], ['cal_a', 'cal_b', 'cal_c'])).toBe('cal_c');
    expect(pickRoundRobinHost([a, b, c], ['cal_a', 'cal_b'])).toBe('cal_b');
    expect(pickRoundRobinHost([a, b, c], [])).toBeNull();
  });

  function simulate(shares: Array<number | undefined>, rounds: number, free?: (round: number) => string[]): Record<string, number> {
    const ids = shares.map((_, i) => `cal_${i}`);
    const counts: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    const last: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    for (let round = 1; round <= rounds; round += 1) {
      const hosts = ids.map((id, i) => {
        const share = shares[i];
        return host({ calendarId: id, load: { count: counts[id] ?? 0, lastAssignedAt: last[id] ?? 0 }, ...(share === undefined ? {} : { share }) });
      });
      const picked = pickRoundRobinHost(hosts, free?.(round) ?? ids);
      if (picked === null) continue;
      counts[picked] = (counts[picked] ?? 0) + 1;
      last[picked] = round;
    }
    return counts;
  }

  it('weighted round robin follows the shares exactly over a series of bookings', () => {
    expect(simulate([0.7, 0.3], 10)).toEqual({ cal_0: 7, cal_1: 3 });
    expect(simulate([0.7, 0.3], 100)).toEqual({ cal_0: 70, cal_1: 30 });
    expect(simulate([0.5, 0.3, 0.2], 20)).toEqual({ cal_0: 10, cal_1: 6, cal_2: 4 });
    expect(simulate([0.7, 0.3], 10)).toEqual(simulate([0.7, 0.3], 10));
  });

  it('weighted round robin without shares splits evenly', () => {
    expect(simulate([undefined, undefined, undefined], 9)).toEqual({ cal_0: 3, cal_1: 3, cal_2: 3 });
  });

  it('a 0% host only gets bookings nobody else can take', () => {
    expect(simulate([1, 0], 10)).toEqual({ cal_0: 10, cal_1: 0 });
    expect(simulate([1, 0], 10, (round) => (round % 5 === 0 ? ['cal_1'] : ['cal_0', 'cal_1']))).toEqual({ cal_0: 8, cal_1: 2 });
  });

  it('weighted round robin catches up the host that was busy', () => {
    const counts = simulate([0.5, 0.5], 20, (round) => (round <= 4 ? ['cal_0'] : ['cal_0', 'cal_1']));
    expect(counts).toEqual({ cal_0: 10, cal_1: 10 });
  });

  it('collective: every host must be free', () => {
    const a = host({ calendarId: 'cal_a', busy: [{ start: rome(2026, 10, 19, 9), end: rome(2026, 10, 19, 10) }] });
    const b = host({ calendarId: 'cal_b', weeklyRules: weekdays('10:30', '12:00') });
    const slots = slotsOn({ hosts: [a, b], assignment: 'collective' }, 2026, 10, 19);
    expect(slots.map((s) => s.start)).toEqual([rome(2026, 10, 19, 10, 30), rome(2026, 10, 19, 11), rome(2026, 10, 19, 11, 30)]);
    expect(slots[0]?.calendarIds).toEqual(['cal_a', 'cal_b']);
  });

  it('combines hosts in different time zones', () => {
    const ny = host({ calendarId: 'cal_ny', timeZone: 'America/New_York', weeklyRules: weekdays('09:00', '10:00') });
    const slots = slotsOn({ hosts: [host(), ny] }, 2026, 10, 19);
    expect(slots.map((s) => iso(s.start))).toContain('2026-10-19T13:00:00.000Z');
    expect(slots.find((s) => iso(s.start) === '2026-10-19T13:00:00.000Z')?.calendarIds).toEqual(['cal_ny']);
  });

  it('re-checks a single start with a precise reason', () => {
    const input = { now: NOW, rules: { ...RULES, maxPerDay: 1, minNoticeMinutes: 60 * 24 }, assignment: 'round_robin' as const };
    const busy = host({ busy: [{ start: rome(2026, 10, 20, 9), end: rome(2026, 10, 20, 9, 30) }], bookedStarts: [rome(2026, 10, 21, 9)] });
    expect(checkSlot({ ...input, hosts: [busy] }, rome(2026, 10, 19, 9))).toEqual({ ok: false, reason: 'too_soon' });
    expect(checkSlot({ ...input, hosts: [busy] }, rome(2026, 10, 20, 9, 7))).toEqual({ ok: false, reason: 'out_of_schedule' });
    expect(checkSlot({ ...input, hosts: [busy] }, rome(2026, 10, 20, 9))).toEqual({ ok: false, reason: 'slot_taken' });
    expect(checkSlot({ ...input, hosts: [busy] }, rome(2026, 10, 21, 10))).toEqual({ ok: false, reason: 'daily_limit' });
    expect(checkSlot({ ...input, hosts: [busy] }, rome(2026, 12, 21, 10))).toEqual({ ok: false, reason: 'too_far' });
    expect(checkSlot({ ...input, hosts: [] }, rome(2026, 10, 20, 10))).toEqual({ ok: false, reason: 'no_hosts' });
    expect(checkSlot({ ...input, hosts: [busy] }, rome(2026, 10, 20, 10))).toMatchObject({ ok: true, calendarIds: ['cal_a'] });
  });

  it('groups slots by day in the viewer time zone', () => {
    const late = Date.UTC(2026, 9, 19, 22, 30);
    const days = groupSlotsByDay([{ start: late }, { start: Date.UTC(2026, 9, 19, 9) }], ROME);
    expect(days.map((d) => d.date)).toEqual(['2026-10-19', '2026-10-20']);
    expect(groupSlotsByDay([{ start: late }], 'America/Los_Angeles')[0]?.date).toBe('2026-10-19');
  });
});

describe('answer validation', () => {
  it('validates invitee fields and the phone mode', () => {
    expect(validateInvitee({ given_name: ' Ada ', family_name: '', email: 'ADA@Example.com', phone: '' }, 'optional')).toEqual({
      ok: true,
      value: { given_name: 'Ada', family_name: '', email: 'ada@example.com', phone: '' },
    });
    expect(validateInvitee({ given_name: '', family_name: '', email: 'x', phone: '' }, 'required')).toEqual({
      ok: false,
      errors: { given_name: 'required', email: 'invalid_email', phone: 'required' },
    });
  });

  it('validates answers by kind and drops unknown keys', () => {
    const questions = [
      { key: 'topic', label: 'Topic', kind: 'select' as const, required: true, options: ['A', 'B'], placeholder: '', map_to: null },
      { key: 'seats', label: 'Seats', kind: 'number' as const, required: false, options: [], placeholder: '', map_to: null },
      { key: 'tools', label: 'Tools', kind: 'multicheck' as const, required: false, options: ['x', 'y'], placeholder: '', map_to: null },
    ];
    expect(validateAnswers(questions, { topic: 'B', seats: '3', tools: ['x'], extra: 'drop' })).toEqual({
      ok: true,
      value: { topic: 'B', seats: 3, tools: ['x'] },
    });
    expect(validateAnswers(questions, { topic: 'C', seats: 'many', tools: ['z'] })).toEqual({
      ok: false,
      errors: { topic: 'invalid_option', seats: 'invalid_number', tools: 'invalid_option' },
    });
  });
});
