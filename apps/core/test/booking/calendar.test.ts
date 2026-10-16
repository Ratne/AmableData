import { OAUTH_SCOPES, type OAuthTokenProvider } from '@amable/core';
import { describe, expect, it } from 'vitest';
import type { BookingOutcome } from '../../src/booking/bookings';
import { messagesFor } from '../../src/booking/flow';
import { fillBookingVars, textToDoc } from '../../src/booking/messages';
import { createTestTenant } from '../crm/helpers';
import { fakeCalendars, nextMonday, seedBooking, SOURCE } from './helpers';

const REF = { tenantId: 'ten_1', calendarId: 'cal_1', hostUserId: 'user_alice', googleAccountId: null, googleCalendarId: null };

function bookedOutcome(): { outcome: BookingOutcome; now: number } {
  const t = createTestTenant();
  const { eventType } = seedBooking(t, { messages: { reminder_subject: 'Soon: {{ booking.event_title }} at {{ booking.start_time }}' } });
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
  });
});
