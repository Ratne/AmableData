import { app as edgeApp, type Env as EdgeEnv } from '@amable/app-edge';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handleEdgeGateway } from '../../src/public/gateway';
import type { TestTenant } from '../crm/helpers';
import { collectWaits, inspectableTenantDb } from '../forms/helpers';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';
import { fakeCalendars, fakeEmailQueue, nextMonday, ROME, type FakeCalendars } from './helpers';

// The edge entry exports its Durable Object class, which needs the Workers runtime.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const SECRET = 'e2e-edge-gateway-secret';

let h: Harness;
let db: TestTenant;
let edgeEnv: EdgeEnv;
let calendars: FakeCalendars;
let emails: ReturnType<typeof fakeEmailQueue>;
const waits = collectWaits();

function edge(path: string, init: RequestInit = {}) {
  return edgeApp.request(`https://book.acme.example${path}`, init, edgeEnv, waits.ctx);
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9', cookie: 'amb_vid=visitor_abcdef12' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  h.env.EDGE_ORIGIN = 'https://book.acme.example';
  calendars = fakeCalendars();
  h.env.BOOKING_CALENDAR = calendars.namespace;
  emails = fakeEmailQueue();
  h.env.EMAIL_SEND = emails.queue;
  const acme = await seedTenant(h, 'acme');
  db = tenants.tenant(acme.id);
  const calendar = db.op('booking.createCalendar', { name: 'Desk', host_user_id: 'user_host', time_zone: ROME });
  db.op('booking.createEventType', {
    slug: 'consult',
    title: 'Consultation',
    duration_minutes: 45,
    host_calendar_ids: [calendar.id],
    min_notice_minutes: 60,
    questions: [{ key: 'goal', label: 'Goal', kind: 'textarea', required: true, options: [], placeholder: '', map_to: null }],
  });
  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => handleEdgeGateway(new Request(input, init), h.env, waits.ctx),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

describe('edge → core booking', () => {
  it('serves the config, a noindex hosted page and slots in the viewer time zone', async () => {
    const config = await edge('/b/acme/consult/config');
    expect(config.status).toBe(200);
    expect(config.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await config.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ slug: 'consult', tenant: 'acme', duration_minutes: 45, time_zone: ROME, turnstile_site_key: null });
    expect(JSON.stringify(body)).not.toContain('map_to');

    const hosted = await edge('/b/acme/consult', { headers: { 'accept-language': 'it' } });
    expect(hosted.status).toBe(200);
    expect(hosted.headers.get('x-robots-tag')).toContain('noindex');
    expect(await hosted.text()).toContain('data-amable-booking="consult"');
    expect((await edge('/b/acme/unknown')).status).toBe(404);

    const monday = nextMonday(Date.now(), 9);
    const day = new Date(monday).toISOString().slice(0, 10);
    const slots = await edge(`/b/acme/consult/slots?from=${day}&to=${day}&tz=America/New_York`);
    const result = (await slots.json()) as { time_zone: string; slots: Array<{ start: string }> };
    expect(result.time_zone).toBe('America/New_York');
    expect(result.slots.map((s) => s.start)).toContain(new Date(monday).toISOString());
  });

  it('books end to end: contact, appointment, confirmation email, reminders, manage link', async () => {
    const start = new Date(nextMonday(Date.now(), 9, 45)).toISOString();
    const res = await edge(
      '/b/acme/consult/book',
      json({
        start,
        time_zone: 'Europe/Rome',
        given_name: 'Grace',
        family_name: 'Hopper',
        email: 'grace@example.com',
        answers: { goal: 'Ship it' },
        tracking: { utm_campaign: 'launch' },
        meta: { page_url: 'https://www.acme.example/pricing' },
      }),
    );
    expect(res.status).toBe(200);
    const booked = (await res.json()) as { booking_id: string; manage_url: string };
    await waits.flush();
    const row = db.db.all<{ contact_id: string; appointment_id: string; visitor_id: string; utm_campaign: string; manage_token_hash: string }>(
      `SELECT contact_id, appointment_id, visitor_id, utm_campaign, manage_token_hash FROM booking_bookings WHERE id = ?`,
      booked.booking_id,
    )[0];
    expect(row).toMatchObject({ visitor_id: 'visitor_abcdef12', utm_campaign: 'launch' });
    const token = booked.manage_url.split('/manage/')[1] ?? '';
    expect(booked.manage_url).toBe(`https://book.acme.example/b/acme/manage/${token}`);
    expect(row?.manage_token_hash).not.toContain(token);
    expect(db.op('contacts.get', { id: row?.contact_id ?? '' }).given_name).toBe('Grace');
    expect(db.op('appointments.get', { id: row?.appointment_id ?? '' }).source).toBe('booking');
    expect(emails.messages.map((m) => m.id)).toContain(`booking:${booked.booking_id}:confirmation:0`);
    const core = [...calendars.cores.values()][0];
    expect(core?.pendingReminders().filter((r) => r.request.contactId === row?.contact_id)).toHaveLength(1);

    const again = await edge('/b/acme/consult/book', json({ start, time_zone: 'Europe/Rome', given_name: 'Linus', email: 'linus@example.com', answers: { goal: 'x' } }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'conflict', details: [{ path: 'start', message: 'slot_taken' }] });
    const invalid = await edge('/b/acme/consult/book', json({ start, time_zone: 'Europe/Rome', given_name: '', email: 'x' }));
    expect(invalid.status).toBe(422);

    const manage = await edge(`/b/acme/manage/${token}`);
    expect(manage.status).toBe(200);
    const html = await manage.text();
    expect(html).toContain('id="amable-booking-manage"');
    expect(html).toContain(booked.booking_id);

    const later = new Date(Date.parse(start) + 90 * 60_000).toISOString();
    const moved = await edge(`/b/acme/manage/${token}/reschedule`, json({ start: later, time_zone: 'Europe/Rome' }));
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ status: 'confirmed', start: later, can_change: true });
    await waits.flush();
    expect(emails.messages.map((m) => m.id)).toContain(`booking:${booked.booking_id}:rescheduled:1`);

    const cancelled = await edge(`/b/acme/manage/${token}/cancel`, json({ reason: 'Conflict' }));
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', can_change: false });
    await waits.flush();
    expect(core?.pendingReminders().filter((r) => r.request.contactId === row?.contact_id)).toEqual([]);
    expect(db.db.all(`SELECT 1 FROM crm_outbox WHERE type = 'appointment.cancelled'`)).toHaveLength(1);
    expect(db.db.all(`SELECT 1 FROM crm_outbox WHERE type = 'appointment.booked'`)).toHaveLength(1);
  });
});
