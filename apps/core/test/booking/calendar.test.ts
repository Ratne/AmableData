import { OAUTH_SCOPES, type OAuthScope, type OAuthTokenProvider } from '@amable/core';
import { describe, expect, it } from 'vitest';
import type { BookingOutcome } from '../../src/booking/bookings';
import { BOOKING_MAX_AGE_MS, googleEventId, SLOTS_MAX_AGE_MS, type CalendarEventChange } from '../../src/booking/calendar-core';
import { calendarEventFor, messagesFor } from '../../src/booking/flow';
import { fillBookingVars, textToDoc } from '../../src/booking/messages';
import { createTestTenant } from '../crm/helpers';
import { fakeCalendars, nextMonday, seedBooking, SOURCE } from './helpers';

const REF = { tenantId: 'ten_1', calendarId: 'cal_1', hostUserId: 'user_alice', googleAccountId: null, googleCalendarId: null };

function bookedOutcome(overrides: Record<string, unknown> = {}): { outcome: BookingOutcome; now: number } {
  const t = createTestTenant();
  const { eventType } = seedBooking(t, {
    notifications: [
      { when: 'before', offset_minutes: 1440, subject: 'Soon: {{ booking.event_title }} at {{ booking.start_time }}' },
      { when: 'before', offset_minutes: 60 },
    ],
    ...overrides,
  });
  const outcome = t.op('booking.book', {
    eventTypeId: eventType.id,
    start: nextMonday(t.clock.now, 10),
    timeZone: 'Europe/Rome',
    locale: 'en',
    invitee: { given_name: 'Ada', family_name: '', email: 'ada@example.com', phone: '' },
    answers: { topic: 'Sales' },
    source: SOURCE,
    visitorId: null,
    manageTokenHash: 'h1',
    externalBusy: {},
    channel: 'public',
  });
  return { outcome, now: t.clock.now };
}

describe('booking messages', () => {
  it('builds the confirmation EmailSendRequest and one reminder per offset', () => {
    const { outcome, now } = bookedOutcome();
    const { email, reminders } = messagesFor({ tenantId: 'ten_1', outcome, manageUrl: 'https://t.acme.example/b/acme/manage/tok', hostName: 'Alice', now });
    expect(email).toMatchObject({
      kind: 'email.send',
      version: 1,
      id: `booking:${outcome.booking.id}:confirmation:0`,
      tenantId: 'ten_1',
      contactId: outcome.booking.contact_id,
      source: { type: 'transactional', purpose: 'booking', referenceId: outcome.booking.id, userId: 'user_alice' },
      notAfter: null,
      content: { templateId: null, subject: expect.stringContaining('Confirmed: Intro call on Monday') },
    });
    const body = JSON.stringify(email?.content.body);
    expect(body).toContain('{"type":"liquidVariable","attrs":{"path":"contact.first_name","label":null,"fallback":"there","filter":null}}');
    expect(body).not.toContain('{{');
    expect(body).toContain('"href":"https://t.acme.example/b/acme/manage/tok"');
    expect(body).not.toContain('booking.');
    const start = Date.parse(outcome.booking.starts_at);
    expect(reminders.map((r) => r.fireAt)).toEqual([start - 1440 * 60_000, start - 60 * 60_000]);
    expect(reminders[0]?.request).toMatchObject({ notAfter: outcome.booking.starts_at, content: { subject: 'Soon: Intro call at 10:00 AM' } });
  });

  it('schedules emails before the start and after the end, each with its own text', () => {
    const { outcome, now } = bookedOutcome({
      notifications: [
        { when: 'after', offset_minutes: 1440 },
        { when: 'before', offset_minutes: 120, subject: 'In two hours', body: 'See you at {{ booking.start_time }}' },
        { when: 'after', offset_minutes: 60, subject: 'How did {{ booking.event_title }} go?', body: 'Tell us, {{ contact.first_name }}.' },
      ],
    });
    expect(outcome.eventType.notifications.map((n) => `${n.when}:${String(n.offset_minutes)}`)).toEqual(['before:120', 'after:60', 'after:1440']);
    const { reminders } = messagesFor({ tenantId: 'ten_1', outcome, manageUrl: 'https://x/m', hostName: 'Alice', now });
    const start = Date.parse(outcome.booking.starts_at);
    const end = Date.parse(outcome.booking.ends_at);
    expect(reminders.map((r) => r.fireAt)).toEqual([start - 120 * 60_000, end + 60 * 60_000, end + 1440 * 60_000]);
    expect(reminders.map((r) => r.id)).toEqual([
      `booking:${outcome.booking.id}:reminder:120:0`,
      `booking:${outcome.booking.id}:followup:60:0`,
      `booking:${outcome.booking.id}:followup:1440:0`,
    ]);
    expect(reminders.map((r) => r.request.notAfter)).toEqual([outcome.booking.starts_at, null, null]);
    expect(reminders.map((r) => r.request.content.subject)).toEqual(['In two hours', 'How did Intro call go?', 'Thank you for Intro call']);
    expect(JSON.stringify(reminders[0]?.request.content.body)).toContain('See you at 10:00 AM');
    expect(JSON.stringify(reminders[2]?.request.content.body)).toContain('thank you for meeting Alice');

    const cancelled = { ...outcome, booking: { ...outcome.booking, status: 'cancelled' as const } };
    expect(messagesFor({ tenantId: 'ten_1', outcome: cancelled, manageUrl: '', hostName: 'Alice', now }).reminders).toEqual([]);
  });

  it('words the manage link after what the invitee may do', () => {
    const body = (overrides: Record<string, unknown>) => {
      const { outcome, now } = bookedOutcome(overrides);
      return JSON.stringify(messagesFor({ tenantId: 'ten_1', outcome, manageUrl: 'https://x/m', hostName: 'Alice', now }).email?.content.body);
    };
    expect(body({})).toContain('Need to change it? Cancel or reschedule here: ');
    expect(body({ allow_cancel: false })).toContain('Need to change it? Reschedule here: ');
    expect(body({ allow_reschedule: false })).toContain("Can't make it? Cancel here: ");
    const none = body({ allow_reschedule: false, allow_cancel: false });
    expect(none).not.toContain('https://x/m');
    expect(none).not.toContain('Cancel');
  });

  it('fills booking variables only and turns text into a Tiptap document', () => {
    expect(fillBookingVars('{{ booking.event_title }} {{ contact.first_name }} {{booking.nope}}', { event_title: 'Call' })).toBe('Call {{ contact.first_name }} ');
    expect(textToDoc('Hello\nworld\n\nSee https://x.test/a')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }, { type: 'hardBreak' }, { type: 'text', text: 'world' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'text', text: 'https://x.test/a', marks: [{ type: 'link', attrs: { href: 'https://x.test/a' } }] },
          ],
        },
      ],
    });
  });
});

describe('BookingCalendar core', () => {
  it('schedules reminders, sends them when due and bumps the live version', async () => {
    const { outcome, now } = bookedOutcome();
    const calendars = fakeCalendars({ now });
    const { reminders } = messagesFor({ tenantId: 'ten_1', outcome, manageUrl: 'https://x/m', hostName: 'Alice', now });
    const stub = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_1'));
    const version = await stub.bookingChanged(outcome.booking.id, reminders);
    expect(version).toBe(1);
    expect(calendars.frames.get('ten_1:cal_1')).toEqual([JSON.stringify({ type: 'version', version: 1 })]);
    const core = calendars.cores.get('ten_1:cal_1');
    expect(core?.pendingReminders()).toHaveLength(2);
    expect(core?.nextAlarm()).toBe(reminders[0]?.fireAt);

    calendars.clock.now = (reminders[0]?.fireAt ?? 0) + 1;
    expect(await core?.fireDue()).toBe(1);
    expect(calendars.sent.map((r) => r.id)).toEqual([reminders[0]?.id]);
    expect(core?.pendingReminders().map((r) => r.id)).toEqual([reminders[1]?.id]);

    await stub.bookingChanged(outcome.booking.id, []);
    expect(core?.pendingReminders()).toEqual([]);
    expect(core?.version()).toBe(2);
  });

  it('never calls Google with the dev stub token and reports it', async () => {
    const calls: string[] = [];
    const calendars = fakeCalendars({ fetch: (url) => (calls.push(url), Promise.resolve(new Response('{}'))) });
    const stub = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_1'));
    expect(await stub.sync(REF)).toMatchObject({ status: 'not_connected', busyCount: 0 });
    expect(await stub.sync({ ...REF, googleAccountId: 'dev-account:x', googleCalendarId: 'primary' })).toMatchObject({
      status: 'stub',
      message: 'skipped (dev stub)',
    });
    expect(calls).toEqual([]);
  });

  it('caches Google free/busy with a real token (fake fetch) and refreshes when stale', async () => {
    const oauth: OAuthTokenProvider = {
      available: true,
      startConnect: () => Promise.reject(new Error('unused')),
      finishConnect: () => Promise.reject(new Error('unused')),
      getAccessToken: () => Promise.resolve({ accessToken: 'real', expiresAt: Date.now() + 3600_000, scopes: [OAUTH_SCOPES.calendarRead], stub: false }),
      revoke: () => Promise.resolve(),
    };
    const requests: Array<{ url: string; auth: string | null }> = [];
    const busyStart = Date.UTC(2026, 9, 20, 8);
    const calendars = fakeCalendars({
      oauth,
      fetch: (url, init) => {
        requests.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return Promise.resolve(
          Response.json({ calendars: { work: { busy: [{ start: new Date(busyStart).toISOString(), end: new Date(busyStart + 3600_000).toISOString() }] } } }),
        );
      },
    });
    const ref = { ...REF, googleAccountId: 'acc_1', googleCalendarId: 'work' };
    const stub = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_1'));
    const first = await stub.busy(ref, busyStart - 86_400_000, busyStart + 86_400_000);
    expect(first.intervals).toEqual([{ start: busyStart, end: busyStart + 3600_000 }]);
    expect(first.sync.status).toBe('ok');
    expect(requests).toEqual([{ url: 'https://www.googleapis.com/calendar/v3/freeBusy', auth: 'Bearer real' }]);
    await stub.busy(ref, busyStart, busyStart + 1);
    expect(requests).toHaveLength(1);
    calendars.clock.now += 6 * 60_000;
    await stub.busy(ref, busyStart, busyStart + 1);
    expect(requests).toHaveLength(2);

    calendars.clock.now += 2 * 60_000;
    await stub.busy(ref, busyStart, busyStart + 1);
    expect(requests).toHaveLength(2);
    await stub.busy(ref, busyStart, busyStart + 1, SLOTS_MAX_AGE_MS);
    expect(requests).toHaveLength(3);
    calendars.clock.now += 30_000;
    await stub.busy(ref, busyStart, busyStart + 1, SLOTS_MAX_AGE_MS);
    expect(requests).toHaveLength(3);
    await stub.busy(ref, busyStart, busyStart + 1, BOOKING_MAX_AGE_MS);
    expect(requests).toHaveLength(4);
    calendars.clock.now += 5_000;
    await stub.busy(ref, busyStart, busyStart + 1, 0);
    expect(requests).toHaveLength(4);
  });

  it('writes the booking to Google Calendar, moves it, deletes it, and retries failures', async () => {
    let scopes: OAuthScope[] = [OAUTH_SCOPES.calendarRead, OAUTH_SCOPES.calendar];
    const oauth: OAuthTokenProvider = {
      available: true,
      startConnect: () => Promise.reject(new Error('unused')),
      finishConnect: () => Promise.reject(new Error('unused')),
      getAccessToken: () => Promise.resolve({ accessToken: 'real', expiresAt: Date.now() + 3600_000, scopes, stub: false }),
      revoke: () => Promise.resolve(),
    };
    const google = new Map<string, { status: string; summary: string; start: string; attendees: unknown }>();
    const calls: string[] = [];
    let failNext = 0;
    const calendars = fakeCalendars({
      oauth,
      fetch: (url, init) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url.replace('https://www.googleapis.com/calendar/v3/calendars/', '')}`);
        if (failNext > 0) {
          failNext -= 1;
          return Promise.resolve(new Response('busy', { status: 503 }));
        }
        const match = /calendars\/([^/]+)\/events(?:\/([^?]+))?/.exec(url);
        const key = `${decodeURIComponent(match?.[1] ?? '')}/${match?.[2] ?? ''}`;
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id: string; summary: string; start: { dateTime: string }; attendees: unknown }) : null;
        if (method === 'PUT') {
          if (!google.has(key)) return Promise.resolve(new Response('', { status: 404 }));
          google.set(key, { status: 'confirmed', summary: body?.summary ?? '', start: body?.start.dateTime ?? '', attendees: body?.attendees });
          return Promise.resolve(Response.json({}));
        }
        if (method === 'POST') {
          google.set(`${key}${body?.id ?? ''}`, { status: 'confirmed', summary: body?.summary ?? '', start: body?.start.dateTime ?? '', attendees: body?.attendees });
          return Promise.resolve(Response.json({}));
        }
        if (method === 'DELETE') {
          if (!google.has(key)) return Promise.resolve(new Response('', { status: 410 }));
          google.delete(key);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(new Response('', { status: 400 }));
      },
    });
    const { outcome } = bookedOutcome();
    const bookingId = outcome.booking.id;
    const eventId = googleEventId(bookingId);
    expect(eventId).toMatch(/^[a-v0-9]{5,1024}$/);
    const event = calendarEventFor(outcome);
    expect(event).toMatchObject({ attendee: { email: 'ada@example.com' }, description: expect.stringContaining('topic: Sales') });
    const ref = { ...REF, googleAccountId: 'acc_1', googleCalendarId: 'work' };
    const a = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_1'));
    const b = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_2'));
    const change = (r: typeof ref | null, e: typeof event | null): CalendarEventChange => ({ tenantId: 'ten_1', ref: r, event: e });

    await a.bookingChanged(bookingId, [], change(ref, event));
    expect(google.get(`work/${eventId}`)).toMatchObject({ summary: event.summary, attendees: [{ email: 'ada@example.com', displayName: event.attendee?.name }] });
    expect(calls.slice(-2)).toEqual([`PUT work/events/${eventId}?sendUpdates=none`, 'POST work/events?sendUpdates=none']);

    // Rescheduled: same event, new time.
    const later = { ...event, start: event.start + 3_600_000, end: event.end + 3_600_000 };
    await a.bookingChanged(bookingId, [], change(ref, later));
    expect(google.size).toBe(1);
    expect(google.get(`work/${eventId}`)?.start).toBe(new Date(later.start).toISOString());

    // Moved to another host: written there, removed here.
    const refB = { ...ref, calendarId: 'cal_2', googleAccountId: 'acc_2', googleCalendarId: 'other' };
    await b.bookingChanged(bookingId, [], change(refB, later));
    await a.bookingChanged(bookingId, [], change(null, null));
    expect([...google.keys()]).toEqual([`other/${eventId}`]);
    expect(await a.eventState(bookingId)).toBeNull();

    // Cancelled while Google is down: retried by the alarm.
    failNext = 1;
    await b.bookingChanged(bookingId, [], change(refB, null));
    expect(await b.eventState(bookingId)).toMatchObject({ pending: true, attempts: 1, lastError: 'Google answered 503' });
    const core = calendars.cores.get('ten_1:cal_2');
    calendars.clock.now += 61_000;
    await core?.fireDue();
    expect(google.size).toBe(0);
    expect(await b.eventState(bookingId)).toBeNull();

    // Old read-only connections are not retried: the host has to reconnect Google.
    scopes = [OAUTH_SCOPES.calendarRead];
    await a.bookingChanged(bookingId, [], change(ref, event));
    expect(await a.eventState(bookingId)).toMatchObject({ pending: false, lastError: expect.stringContaining('reconnect') });
    expect(calendars.cores.get('ten_1:cal_1')?.lastSync()).toMatchObject({ needsReconnect: true });

    // The failed write above shows on the other calendar until a write succeeds.
    const coreB = calendars.cores.get('ten_1:cal_2');
    expect(coreB?.lastSync().writeError).toBeNull();
    failNext = 1;
    scopes = [OAUTH_SCOPES.calendarRead, OAUTH_SCOPES.calendar];
    await b.bookingChanged(bookingId, [], change(refB, event));
    expect(coreB?.lastSync()).toMatchObject({ writeError: 'Google answered 503', needsReconnect: false });
    calendars.clock.now += 61_000;
    await coreB?.fireDue();
    expect(coreB?.lastSync().writeError).toBeNull();
  });

  it('flags read-only Google connections on sync until they are reconnected', async () => {
    let scopes: OAuthScope[] = [OAUTH_SCOPES.calendarRead];
    const oauth: OAuthTokenProvider = {
      available: true,
      startConnect: () => Promise.reject(new Error('unused')),
      finishConnect: () => Promise.reject(new Error('unused')),
      getAccessToken: () => Promise.resolve({ accessToken: 'real', expiresAt: Date.now() + 3600_000, scopes, stub: false }),
      revoke: () => Promise.resolve(),
    };
    const calendars = fakeCalendars({ oauth, fetch: () => Promise.resolve(Response.json({ calendars: {} })) });
    const stub = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_1'));
    const ref = { ...REF, googleAccountId: 'acc_1', googleCalendarId: 'primary' };
    expect(await stub.sync(ref)).toMatchObject({ status: 'ok', needsReconnect: true });
    scopes = [OAUTH_SCOPES.calendarRead, OAUTH_SCOPES.calendar];
    expect(await stub.sync(ref)).toMatchObject({ status: 'ok', needsReconnect: false, writeError: null });
  });

  it('shows a read-only grant on the first status read, before any sync or write', async () => {
    let scopes: OAuthScope[] = [OAUTH_SCOPES.calendarRead];
    let tokenReads = 0;
    const oauth: OAuthTokenProvider = {
      available: true,
      startConnect: () => Promise.reject(new Error('unused')),
      finishConnect: () => Promise.reject(new Error('unused')),
      getAccessToken: () => {
        tokenReads += 1;
        return Promise.resolve({ accessToken: 'real', expiresAt: Date.now() + 3600_000, scopes, stub: false });
      },
      revoke: () => Promise.resolve(),
    };
    const calendars = fakeCalendars({ oauth, fetch: () => Promise.reject(new Error('Google must not be called')) });
    const stub = calendars.namespace.get(calendars.namespace.idFromName('ten_1:cal_1'));
    const ref = { ...REF, googleAccountId: 'acc_1', googleCalendarId: 'primary' };
    expect(await stub.status(ref)).toMatchObject({ status: 'not_connected', needsReconnect: true });
    // Cached between reads; re-read after the interval.
    scopes = [OAUTH_SCOPES.calendarRead, OAUTH_SCOPES.calendar];
    expect(await stub.status(ref)).toMatchObject({ needsReconnect: true });
    expect(tokenReads).toBe(1);
    // Reconnecting changes the account: checked at once.
    expect(await stub.status({ ...ref, googleAccountId: 'acc_2' })).toMatchObject({ needsReconnect: false });
    expect(tokenReads).toBe(2);
    scopes = [OAUTH_SCOPES.calendarRead];
    calendars.clock.now += 5 * 60_000;
    expect(await stub.status({ ...ref, googleAccountId: 'acc_2' })).toMatchObject({ needsReconnect: true });
    expect(tokenReads).toBe(3);
  });
});
