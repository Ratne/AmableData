import { devOAuthProvider, ROLES, type Role } from '@amable/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overrideBookingRuntime } from '../../src/booking/runtime';
import type { TestTenant } from '../crm/helpers';
import { inspectableTenantDb } from '../forms/helpers';
import { addMember, createHarness, login, seedTenant, seedUser, type Harness, type TestClient } from '../helpers/harness';
import { fakeCalendars, fakeEmailQueue, nextMonday, type FakeCalendars } from './helpers';

const BASE = '/api/v2/t/acme';
const READERS: readonly Role[] = ['owner', 'admin', 'marketer', 'sales', 'analyst', 'viewer'];
const WRITERS: readonly Role[] = ['owner', 'admin', 'marketer', 'sales'];

let h: Harness;
let db: TestTenant;
let calendars: FakeCalendars;
let emails: ReturnType<typeof fakeEmailQueue>;
const clients = {} as Record<Role, TestClient>;
const userIds = {} as Record<Role, string>;
let calendarId = '';
let eventTypeId = '';

function expectByRole(results: Record<Role, number>, allowed: readonly Role[], ok: number) {
  expect(results).toEqual(Object.fromEntries(ROLES.map((role) => [role, allowed.includes(role) ? ok : 403])));
}

async function forEachRole(fn: (client: TestClient, role: Role) => Promise<number>): Promise<Record<Role, number>> {
  const out = {} as Record<Role, number>;
  for (const role of ROLES) out[role] = await fn(clients[role], role);
  return out;
}

beforeAll(async () => {
  h = await createHarness();
  h.env.EDGE_ORIGIN = 'https://t.acme.example';
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  calendars = fakeCalendars();
  h.env.BOOKING_CALENDAR = calendars.namespace;
  emails = fakeEmailQueue();
  h.env.EMAIL_SEND = emails.queue;
  const acme = await seedTenant(h, 'acme');
  db = tenants.tenant(acme.id);
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    userIds[role] = user.id;
    await addMember(h, user.id, acme.id, role);
    clients[role] = await login(h, user.email);
  }
  overrideBookingRuntime((base) => ({ ...base, oauth: devOAuthProvider() }));
  const calendar = await clients.owner.post(`${BASE}/bookingCalendars`, {
    name: 'Sales desk',
    host_user_id: userIds.sales,
    time_zone: 'Europe/Rome',
  });
  expect(calendar.status).toBe(201);
  calendarId = String(calendar.body['id']);
  const eventType = await clients.owner.post(`${BASE}/bookingEventTypes`, {
    slug: 'demo',
    title: 'Product demo',
    duration_minutes: 30,
    host_calendar_ids: [calendarId],
    min_notice_minutes: 60,
  });
  expect(eventType.status).toBe(201);
  eventTypeId = String(eventType.body['id']);
});

afterAll(() => overrideBookingRuntime(null));

describe('booking REST v2 permissions by role', () => {
  it('lets every role read calendars, event types and bookings', async () => {
    for (const path of ['/bookingCalendars', `/bookingCalendars/${calendarId}/availability`, '/bookingEventTypes', `/bookingEventTypes/${eventTypeId}/embed`, '/bookings']) {
      expectByRole(await forEachRole(async (c) => (await c.get(`${BASE}${path}`)).status), READERS, 200);
    }
  });

  it('restricts calendars, availability and event types to booking:write', async () => {
    expectByRole(
      await forEachRole(async (c, role) =>
        (await c.post(`${BASE}/bookingCalendars`, { name: `Cal ${role}`, host_user_id: userIds.owner, time_zone: 'UTC' })).status,
      ),
      WRITERS,
      201,
    );
    expectByRole(
      await forEachRole(async (c) =>
        (await c.request('PUT', `${BASE}/bookingCalendars/${calendarId}/availability`, {
          weekly_rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '12:00' })),
          date_overrides: [{ date: '2030-01-01', intervals: [] }],
        })).status,
      ),
      WRITERS,
      200,
    );
    expectByRole(
      await forEachRole(async (c) => (await c.patch(`${BASE}/bookingEventTypes/${eventTypeId}`, { location: 'Video call' })).status),
      WRITERS,
      200,
    );
    expectByRole(
      await forEachRole(async (c) => (await c.post(`${BASE}/bookingCalendars/${calendarId}/sync`)).status),
      WRITERS,
      200,
    );
    const outsider = await clients.owner.post(`${BASE}/bookingCalendars`, { name: 'X', host_user_id: 'usr_nobody', time_zone: 'UTC' });
    expect(outsider.status).toBe(422);
    const badZone = await clients.owner.post(`${BASE}/bookingCalendars`, { name: 'X', host_user_id: userIds.owner, time_zone: 'Mars/Base' });
    expect(badZone.status).toBe(422);
  });

  it('previews availability and serves the embed snippet on the edge origin', async () => {
    const monday = new Date(nextMonday(Date.now(), 9));
    const day = monday.toISOString().slice(0, 10);
    const preview = await clients.viewer.get(`${BASE}/bookingEventTypes/${eventTypeId}/availability?from=${day}&to=${day}`);
    expect(preview.status).toBe(200);
    expect(preview.body['time_zone']).toBe('Europe/Rome');
    expect((preview.body['slots'] as Array<{ start: string; calendar_ids: string[] }>)[0]).toEqual({
      start: monday.toISOString(),
      end: new Date(monday.getTime() + 1800_000).toISOString(),
      calendar_ids: [calendarId],
    });
    const embed = await clients.analyst.get(`${BASE}/bookingEventTypes/${eventTypeId}/embed`);
    expect(embed.body).toMatchObject({
      hosted_url: 'https://t.acme.example/b/acme/demo',
      snippet: '<div data-amable-booking="demo" data-amable-tenant="acme"></div>\n<script async src="https://t.acme.example/booking.js"></script>',
    });
  });

  it('creates, reschedules and cancels bookings with booking:manage_bookings only', async () => {
    let n = 0;
    const results = await forEachRole(async (c, role) => {
      n += 1;
      const res = await c.post(`${BASE}/bookings`, {
        event_type_id: eventTypeId,
        start_at: new Date(nextMonday(Date.now(), 9, 0, n)).toISOString(),
        time_zone: 'Europe/Rome',
        given_name: 'Guest',
        email: `guest-${role}@example.com`,
      });
      return res.status;
    });
    expectByRole(results, WRITERS, 201);
    expect(emails.messages.filter((m) => m.id.endsWith(':confirmation:0'))).toHaveLength(WRITERS.length);
    const [first] = (await clients.viewer.get(`${BASE}/bookings?order=asc`)).body['data'] as Array<{ id: string; starts_at: string }>;
    const bookingId = String(first?.id);
    const startOf = (i: number) => new Date(Date.parse(String(first?.starts_at)) + (i + 1) * 1800_000).toISOString();
    expectByRole(
      await forEachRole(async (c, role) =>
        (await c.post(`${BASE}/bookings/${bookingId}/reschedule`, { start_at: startOf(ROLES.indexOf(role)), notify: role === 'owner' })).status,
      ),
      WRITERS,
      200,
    );
    const booking = await clients.viewer.get(`${BASE}/bookings/${bookingId}`);
    expect(booking.body).toMatchObject({ starts_at: startOf(ROLES.indexOf('sales')), reschedule_count: WRITERS.length });
    expect(emails.messages.some((m) => m.id === `booking:${bookingId}:rescheduled:1`)).toBe(true);
    const key = [...calendars.cores.keys()].find((k) => k.endsWith(`:${calendarId}`)) ?? '';
    const reminders = calendars.cores.get(key)?.pendingReminders() ?? [];
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.some((r) => r.bookingId === bookingId)).toBe(false);

    expectByRole(
      await forEachRole(async (c) => (await c.post(`${BASE}/bookings/${bookingId}/cancel`, { reason: 'No longer needed' })).status),
      WRITERS,
      200,
    );
    const cancelled = await clients.viewer.get(`${BASE}/bookings/${bookingId}`);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancel_reason: 'No longer needed', cancelled_by: 'staff' });
    expect(emails.messages.filter((m) => m.id === `booking:${bookingId}:cancelled:${String(WRITERS.length)}`)).toHaveLength(1);
    expect(db.db.all(`SELECT 1 FROM crm_outbox WHERE type = 'appointment.cancelled'`)).toHaveLength(1);
  });

  it('cancelling the appointment from the CRM cancels the booking, notifies the invitee and drops reminders', async () => {
    const created = await clients.sales.post(`${BASE}/bookings`, {
      event_type_id: eventTypeId,
      start_at: new Date(nextMonday(Date.now(), 11, 0, 3)).toISOString(),
      time_zone: 'Europe/Rome',
      given_name: 'Grace',
      email: 'grace@example.com',
    });
    expect(created.status).toBe(201);
    const bookingId = String(created.body['id']);
    const appointmentId = String(created.body['appointment_id']);
    const key = [...calendars.cores.keys()].find((k) => k.endsWith(`:${calendarId}`)) ?? '';
    const pending = () => calendars.cores.get(key)?.pendingReminders().filter((r) => r.bookingId === bookingId) ?? [];
    expect(pending().length).toBeGreaterThan(0);
    const cancelledBefore = db.db.all(`SELECT 1 FROM crm_outbox WHERE type = 'appointment.cancelled'`).length;

    const patched = await clients.sales.patch(`${BASE}/appointments/${appointmentId}`, { status: 'cancelled' });
    expect(patched.status).toBe(200);
    expect(patched.body['status']).toBe('cancelled');
    expect((await clients.viewer.get(`${BASE}/bookings/${bookingId}`)).body).toMatchObject({ status: 'cancelled', cancelled_by: 'staff' });
    expect(emails.messages.filter((m) => m.id === `booking:${bookingId}:cancelled:0`)).toHaveLength(1);
    expect(pending()).toEqual([]);
    expect(db.db.all(`SELECT 1 FROM crm_outbox WHERE type = 'appointment.cancelled'`)).toHaveLength(cancelledBefore + 1);

    expect((await clients.sales.patch(`${BASE}/appointments/${appointmentId}`, { status: 'cancelled' })).status).toBe(200);
    expect(emails.messages.filter((m) => m.id === `booking:${bookingId}:cancelled:0`)).toHaveLength(1);
  });

  it('connects Google through the OAuth stub and audits sensitive actions', async () => {
    const start = await clients.marketer.post(`${BASE}/bookingCalendars/${calendarId}/google/connect`);
    expect(start.status).toBe(200);
    const url = new URL(String(start.body['authorize_url']));
    const finish = await clients.marketer.post(`${BASE}/bookingCalendars/${calendarId}/google/finish`, {
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
    });
    expect(finish.body).toMatchObject({ google: { connected: true, account_email: 'dev-account@example.com', calendar_id: 'primary' } });
    expect((await clients.marketer.post(`${BASE}/bookingCalendars/${calendarId}/sync`)).body).toMatchObject({ status: 'stub' });
    expect((await clients.viewer.post(`${BASE}/bookingCalendars/${calendarId}/google/connect`)).status).toBe(403);
    const audits = await h.env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'booking.%'`).all<{ action: string }>();
    expect(audits.results.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'booking.calendar_created',
        'booking.event_type_created',
        'booking.availability_updated',
        'booking.booking_created',
        'booking.booking_rescheduled',
        'booking.booking_cancelled',
        'booking.google_connected',
      ]),
    );
  });
});
