import { zonedToUtc } from '@amable/booking';
import { devOAuthProvider, type EmailSendRequest, type OAuthTokenProvider } from '@amable/core';
import { CalendarCore } from '../../src/booking/calendar-core';
import type { Env } from '../../src/env';
import { createNodeSqlDb, type TestTenant } from '../crm/helpers';

export const ROME = 'Europe/Rome';

/** Instant of `hh:mm` in Rome on the Monday at least `weeksAhead` weeks after `now`. */
export function nextMonday(now: number, hh: number, mm = 0, weeksAhead = 1): number {
  const base = new Date(now + weeksAhead * 7 * 86_400_000);
  const shift = (8 - base.getUTCDay()) % 7;
  const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + shift));
  return zonedToUtc({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() }, hh * 60 + mm, ROME);
}

export interface FakeCalendars {
  namespace: NonNullable<Env['BOOKING_CALENDAR']>;
  cores: Map<string, CalendarCore>;
  frames: Map<string, string[]>;
  sent: EmailSendRequest[];
  clock: { now: number };
}

/** BOOKING_CALENDAR stand-in: one `CalendarCore` on node:sqlite per DO name. */
export function fakeCalendars(options: { oauth?: OAuthTokenProvider; fetch?: (input: string, init?: RequestInit) => Promise<Response>; now?: number } = {}): FakeCalendars {
  const cores = new Map<string, CalendarCore>();
  const frames = new Map<string, string[]>();
  const sent: EmailSendRequest[] = [];
  const clock = { now: options.now ?? Date.now() };
  const core = (name: string): CalendarCore => {
    let found = cores.get(name);
    if (found === undefined) {
      const log: string[] = [];
      frames.set(name, log);
      found = new CalendarCore({
        db: createNodeSqlDb(),
        now: () => clock.now,
        oauth: options.oauth ?? devOAuthProvider(() => clock.now),
        fetch: options.fetch ?? (() => Promise.reject(new Error('no network in tests'))),
        broadcast: (message) => log.push(message),
        setAlarm: () => Promise.resolve(),
        sendEmail: (request) => {
          sent.push(request);
          return Promise.resolve();
        },
      });
      cores.set(name, found);
    }
    return found;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const c = core(name);
      return {
        busy: (ref: Parameters<CalendarCore['busy']>[0], from: number, to: number) => c.busy(ref, from, to),
        sync: (ref: Parameters<CalendarCore['sync']>[0]) => c.sync(ref),
        bookingChanged: (
          id: string,
          jobs: Parameters<CalendarCore['bookingChanged']>[1],
          change?: Parameters<CalendarCore['bookingChanged']>[2],
        ) => c.bookingChanged(id, structuredClone(jobs), change === undefined ? undefined : structuredClone(change)),
        eventState: (id: string) => Promise.resolve(c.eventState(id)),
        status: () => Promise.resolve(c.lastSync()),
        touch: () => Promise.resolve(c.bump()),
        version: () => Promise.resolve(c.version()),
        fetch: () => Promise.resolve(new Response('ws', { status: 200 })),
      };
    },
  };
  return { namespace: namespace as unknown as NonNullable<Env['BOOKING_CALENDAR']>, cores, frames, sent, clock };
}

/** Captures what is put on the `email-send` queue. */
export function fakeEmailQueue(): { queue: Env['EMAIL_SEND']; messages: EmailSendRequest[] } {
  const messages: EmailSendRequest[] = [];
  const queue = {
    send: (message: unknown) => {
      messages.push(message as EmailSendRequest);
      return Promise.resolve();
    },
    sendBatch: () => Promise.resolve(),
  };
  return { queue: queue as unknown as Env['EMAIL_SEND'], messages };
}

/** A tenant with two Rome calendars (Mon-Fri 09-12) and a 30-minute event type on the first one. */
export function seedBooking(t: TestTenant, overrides: Record<string, unknown> = {}) {
  const rules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '12:00' }));
  const alice = t.op('booking.createCalendar', { name: 'Alice', host_user_id: 'user_alice', time_zone: ROME, weekly_rules: rules });
  const bob = t.op('booking.createCalendar', { name: 'Bob', host_user_id: 'user_bob', time_zone: ROME, weekly_rules: rules });
  const eventType = t.op('booking.createEventType', {
    slug: 'intro-call',
    title: 'Intro call',
    duration_minutes: 30,
    host_calendar_ids: [alice.id],
    min_notice_minutes: 60,
    reminder_minutes: [1440, 60],
    questions: [
      { key: 'company', label: 'Company', kind: 'text', map_to: 'company_name' },
      { key: 'budget', label: 'Budget', kind: 'number', map_to: 'custom.budget' },
      { key: 'topic', label: 'Topic', kind: 'select', options: ['Sales', 'Support'], required: true },
    ],
    ...overrides,
  });
  return { alice, bob, eventType };
}

export const SOURCE = {
  utm_source: 'newsletter',
  utm_medium: 'email',
  utm_campaign: 'autumn',
  utm_term: null,
  utm_content: null,
  referrer: 'https://www.example.com/',
  page_url: 'https://www.example.com/book',
  page_id: null,
};
