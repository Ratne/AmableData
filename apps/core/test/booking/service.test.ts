import { describe, expect, it } from 'vitest';
import type { BookInput } from '../../src/booking/bookings';
import { createTestTenant, outbox, type TestTenant } from '../crm/helpers';
import { nextMonday, seedBooking, SOURCE } from './helpers';

function bookInput(t: TestTenant, eventTypeId: string, start: number, overrides: Partial<BookInput> = {}): BookInput {
  return {
    eventTypeId,
    start,
    timeZone: 'Europe/Rome',
    locale: 'it',
    invitee: { given_name: 'Ada', family_name: 'Lovelace', email: 'Ada@Example.com', phone: '+39 333 1234567' },
    answers: { company: 'Analytical Engines', budget: '1200', topic: 'Sales' },
    source: SOURCE,
    visitorId: 'vis_12345678',
    manageTokenHash: `hash_${String(start)}_${String(t.clock.now)}`,
    externalBusy: {},
    channel: 'public',
    ...overrides,
  };
}

function errorOf(fn: () => unknown): { code: string; details?: Array<{ path: string; message: string }> } {
  try {
    fn();
  } catch (error) {
    return (error as { shape: { code: string; details?: Array<{ path: string; message: string }> } }).shape;
  }
  throw new Error('expected an error');
}

describe('booking ops', () => {
  it('books: contact + CRM appointment + appointment.booked in one transaction', () => {
    const t = createTestTenant();
    t.op('customFields.create', { entity: 'contact', data: { key: 'budget', label: 'Budget', type: 'WHOLE_NUMBER' } });
    const tag = t.op('tags.create', { name: 'Booked' });
    const { eventType, alice } = seedBooking(t, { tag_ids: [tag.id] });
    const start = nextMonday(t.clock.now, 9);
    const before = outbox(t).length;
    const result = t.op('booking.book', bookInput(t, eventType.id, start));

    expect(result.booking).toMatchObject({
      status: 'confirmed',
      calendar_id: alice.id,
      host_user_id: 'user_alice',
      invitee_email: 'ada@example.com',
      invitee_name: 'Ada Lovelace',
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + 30 * 60_000).toISOString(),
      answers: { company: 'Analytical Engines', budget: 1200, topic: 'Sales' },
      source: { utm_campaign: 'autumn' },
      visitor_id: 'vis_12345678',
    });
    const contact = t.op('contacts.get', { id: result.booking.contact_id ?? '' });
    expect(contact).toMatchObject({
      given_name: 'Ada',
      family_name: 'Lovelace',
      source_type: 'booking',
      custom_fields: { budget: 1200 },
      utm: { source: 'newsletter', campaign: 'autumn' },
    });
    expect(contact.tag_ids).toContain(tag.id);
    const appointment = t.op('appointments.get', { id: result.booking.appointment_id ?? '' });
    expect(appointment).toMatchObject({ source: 'booking', owner_id: 'user_alice', contact_id: contact.id, status: 'scheduled' });

    const events = outbox(t).slice(before);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['contact.created', 'appointment.created', 'appointment.booked']),
    );
    const booked = events.find((e) => e.type === 'appointment.booked');
    expect(booked?.payload).toMatchObject({
      bookingId: result.booking.id,
      appointmentId: appointment.id,
      eventTypeId: eventType.id,
      calendarId: alice.id,
      contactId: contact.id,
      ownerId: 'user_alice',
      timeZone: 'Europe/Rome',
      source: { utmSource: 'newsletter', pageUrl: 'https://www.example.com/book' },
      visitorId: 'vis_12345678',
    });
  });

  it('reuses the contact matched by normalized email', () => {
    const t = createTestTenant();
    const existing = t.op('contacts.create', { given_name: 'Ada', emails: [{ email: 'ada@example.com' }] });
    const { eventType } = seedBooking(t);
    const result = t.op('booking.book', bookInput(t, eventType.id, nextMonday(t.clock.now, 9)));
    expect(result.booking.contact_id).toBe(existing.id);
    expect(t.op('contacts.get', { id: existing.id }).family_name).toBe('Lovelace');
  });

  it('rejects double bookings, busy appointments and external busy time', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const start = nextMonday(t.clock.now, 9);
    t.op('booking.book', bookInput(t, eventType.id, start));
    const twice = errorOf(() => t.op('booking.book', bookInput(t, eventType.id, start, { invitee: { given_name: 'Bo', family_name: '', email: 'bo@example.com', phone: '' } })));
    expect(twice).toMatchObject({ code: 'conflict', details: [{ path: 'start', message: 'slot_taken' }] });

    t.op('appointments.create', { title: 'Dentist', start_at: new Date(start + 3600_000).toISOString(), end_at: new Date(start + 5400_000).toISOString(), owner_id: 'user_alice' });
    expect(errorOf(() => t.op('booking.book', bookInput(t, eventType.id, start + 3600_000))).details?.[0]?.message).toBe('slot_taken');

    const external = { [eventType.host_calendar_ids[0] ?? '']: [{ start: start + 7200_000, end: start + 9000_000 }] };
    expect(errorOf(() => t.op('booking.book', bookInput(t, eventType.id, start + 7200_000, { externalBusy: external }))).details?.[0]?.message).toBe('slot_taken');
    expect(errorOf(() => t.op('booking.book', bookInput(t, eventType.id, start + 7 * 60_000))).details?.[0]?.message).toBe('out_of_schedule');
  });

  it('validates invitee fields and answers', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const error = errorOf(() =>
      t.op('booking.book', bookInput(t, eventType.id, nextMonday(t.clock.now, 9), {
        invitee: { given_name: '', family_name: '', email: 'nope', phone: '' },
        answers: { topic: 'Other' },
      })),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.details).toEqual([
      { path: 'given_name', message: 'required' },
      { path: 'email', message: 'invalid_email' },
      { path: 'answers.topic', message: 'invalid_option' },
    ]);
  });

  it('reschedules: appointment moved, appointment.rescheduled emitted, old slot free again', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const start = nextMonday(t.clock.now, 9);
    const booked = t.op('booking.book', bookInput(t, eventType.id, start, { manageTokenHash: 'tok_hash_1' }));
    const before = outbox(t).length;
    const moved = t.op('booking.reschedule', { tokenHash: 'tok_hash_1', start: start + 3600_000, externalBusy: {}, by: 'invitee' });
    expect(moved.booking).toMatchObject({ reschedule_count: 1, rescheduled_from: new Date(start).toISOString() });
    expect(moved.previous).toEqual({ startsAt: new Date(start).toISOString(), endsAt: new Date(start + 1800_000).toISOString() });
    expect(t.op('appointments.get', { id: booked.booking.appointment_id ?? '' }).start_at).toBe(new Date(start + 3600_000).toISOString());
    const events = outbox(t).slice(before);
    expect(events.map((e) => e.type)).toEqual(['appointment.updated', 'appointment.rescheduled']);
    expect(events[1]?.payload).toMatchObject({ bookingId: booked.booking.id, previousStartsAt: new Date(start).toISOString() });
    expect(() => t.op('booking.book', bookInput(t, eventType.id, start, { invitee: { given_name: 'Bo', family_name: '', email: 'bo@example.com', phone: '' } }))).not.toThrow();
  });

  it('cancels once: appointment cancelled, appointment.cancelled emitted a single time', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const booked = t.op('booking.book', bookInput(t, eventType.id, nextMonday(t.clock.now, 9)));
    const before = outbox(t).length;
    const cancelled = t.op('booking.cancel', { id: booked.booking.id, by: 'staff', reason: 'Host sick' });
    expect(cancelled).toMatchObject({ changed: true, booking: { status: 'cancelled', cancel_reason: 'Host sick', cancelled_by: 'staff' } });
    expect(t.op('appointments.get', { id: booked.booking.appointment_id ?? '' }).status).toBe('cancelled');
    const again = t.op('booking.cancel', { id: booked.booking.id, by: 'staff' });
    expect(again.changed).toBe(false);
    expect(outbox(t).slice(before).map((e) => e.type)).toEqual(['appointment.cancelled']);
    expect(errorOf(() => t.op('booking.reschedule', { id: booked.booking.id, start: nextMonday(t.clock.now, 10), externalBusy: {}, by: 'staff' })).code).toBe('conflict');
  });

  it('cancelling the CRM appointment cancels the booking and frees the slot, without a second event', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const start = nextMonday(t.clock.now, 9);
    const booked = t.op('booking.book', bookInput(t, eventType.id, start));
    const appointmentId = booked.booking.appointment_id ?? '';
    const before = outbox(t).length;

    const result = t.op('booking.updateAppointment', { id: appointmentId, data: { status: 'cancelled' } });
    expect(result.appointment.status).toBe('cancelled');
    expect(result.booking).toMatchObject({ kind: 'cancelled', changed: true, booking: { id: booked.booking.id, status: 'cancelled', cancelled_by: 'staff' } });
    expect(result.booking?.notifyCalendarIds).toEqual(eventType.host_calendar_ids);
    expect(t.op('booking.getBooking', { id: booked.booking.id }).status).toBe('cancelled');
    expect(outbox(t).slice(before).map((e) => e.type)).toEqual(['appointment.cancelled']);

    const again = t.op('booking.updateAppointment', { id: appointmentId, data: { status: 'cancelled' } });
    expect(again.booking).toBeNull();
    expect(t.op('booking.slots', { eventTypeId: eventType.id, from: start, to: start }).slots.map((s) => s.start)).toContain(start);
    expect(() => t.op('booking.book', bookInput(t, eventType.id, start, { invitee: { given_name: 'Bo', family_name: '', email: 'bo@example.com', phone: '' } }))).not.toThrow();
  });

  it('deleting the CRM appointment cancels the booking; plain appointments are untouched', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const booked = t.op('booking.book', bookInput(t, eventType.id, nextMonday(t.clock.now, 9)));
    const before = outbox(t).length;
    const deleted = t.op('booking.deleteAppointment', { id: booked.booking.appointment_id ?? '' });
    expect(deleted.appointment).toEqual({ id: booked.booking.appointment_id, deleted: true });
    expect(deleted.booking?.booking.status).toBe('cancelled');
    expect(outbox(t).slice(before).map((e) => e.type)).toEqual(['appointment.deleted']);

    const manual = t.op('appointments.create', {
      title: 'Lunch',
      start_at: new Date(nextMonday(t.clock.now, 12)).toISOString(),
      end_at: new Date(nextMonday(t.clock.now, 13)).toISOString(),
    });
    expect(t.op('booking.updateAppointment', { id: manual.id, data: { title: 'Lunch!' } }).booking).toBeNull();
    expect(t.op('booking.updateAppointment', { id: manual.id, data: { status: 'cancelled' } }).booking).toBeNull();
  });

  it('round robin assigns the least loaded free host; collective needs every host', () => {
    const t = createTestTenant();
    const { alice, bob } = seedBooking(t);
    const rr = t.op('booking.createEventType', { slug: 'demo', title: 'Demo', duration_minutes: 30, host_calendar_ids: [alice.id, bob.id], min_notice_minutes: 60 });
    const start = nextMonday(t.clock.now, 9);
    const first = t.op('booking.book', bookInput(t, rr.id, start, { answers: {} }));
    const second = t.op('booking.book', bookInput(t, rr.id, start, { answers: {}, invitee: { given_name: 'Bo', family_name: '', email: 'bo@example.com', phone: '' } }));
    expect(new Set([first.booking.calendar_id, second.booking.calendar_id])).toEqual(new Set([alice.id, bob.id]));
    const third = t.op('booking.book', bookInput(t, rr.id, start + 3600_000, { answers: {}, invitee: { given_name: 'Cy', family_name: '', email: 'cy@example.com', phone: '' } }));
    expect(third.booking.calendar_id).toBe(alice.id < bob.id ? alice.id : bob.id);
    expect(errorOf(() => t.op('booking.book', bookInput(t, rr.id, start, { answers: {}, invitee: { given_name: 'Di', family_name: '', email: 'di@example.com', phone: '' } }))).code).toBe('conflict');

    const team = t.op('booking.createEventType', { slug: 'team', title: 'Team', duration_minutes: 30, host_calendar_ids: [alice.id, bob.id], assignment: 'collective', min_notice_minutes: 60 });
    const slots = t.op('booking.slots', { eventTypeId: team.id, from: start, to: start + 3 * 3600_000 });
    expect(slots.slots.map((s) => s.start)).not.toContain(start + 3600_000);
    const joint = t.op('booking.book', bookInput(t, team.id, start + 1800_000, { answers: {} }));
    expect(joint.booking.calendar_ids).toEqual([alice.id, bob.id]);
    expect(t.op('booking.slots', { eventTypeId: rr.id, from: start + 1800_000, to: start + 1800_000 }).slots).toEqual([]);
    expect(joint.notifyCalendarIds).toEqual(expect.arrayContaining([alice.id, bob.id]));
  });

  it('lists bookings with filters and cursor pagination', () => {
    const t = createTestTenant();
    const { eventType } = seedBooking(t);
    const start = nextMonday(t.clock.now, 9);
    for (let i = 0; i < 3; i += 1) {
      t.op('booking.book', bookInput(t, eventType.id, start + i * 1800_000, { invitee: { given_name: `P${String(i)}`, family_name: '', email: `p${String(i)}@example.com`, phone: '' } }));
    }
    const page = t.op('booking.listBookings', { limit: 2, order: 'asc' });
    expect(page.data.map((b) => b.invitee_name)).toEqual(['P0', 'P1']);
    const next = t.op('booking.listBookings', { limit: 2, order: 'asc', cursor: page.next_cursor ?? '' });
    expect(next.data.map((b) => b.invitee_name)).toEqual(['P2']);
    expect(t.op('booking.listBookings', { limit: 50, status: 'cancelled' }).data).toEqual([]);
    expect(t.op('booking.listBookings', { limit: 50, calendar_id: eventType.host_calendar_ids[0] }).data).toHaveLength(3);
  });

  it('refuses to delete a calendar used by an event type and duplicate slugs', () => {
    const t = createTestTenant();
    const { alice } = seedBooking(t);
    expect(errorOf(() => t.op('booking.deleteCalendar', { id: alice.id })).code).toBe('conflict');
    expect(errorOf(() => t.op('booking.createEventType', { slug: 'intro-call', title: 'X', duration_minutes: 15, host_calendar_ids: [alice.id] })).code).toBe('conflict');
  });
});
