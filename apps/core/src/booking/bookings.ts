import type { Appointment, Booking, BookingEventType, ListBookingsQuery, Page } from '@amable/api-types';
import {
  checkSlot,
  computeSlots,
  DAY_MS,
  pickRoundRobinHost,
  validateAnswers,
  validateInvitee,
  type AvailableSlot,
  type BookingAnswers,
  type BookingQuestion,
  type HostSchedule,
  type InviteeInput,
  type Interval,
  type SlotRejection,
} from '@amable/booking';
import { formDefinitionSchema, type FormFieldInput, type SubmissionValues } from '@amable/forms';
import { createAppointment, deleteAppointment, getAppointment, updateAppointment } from '../crm/calendar';
import type { CrmContext } from '../crm/context';
import { CrmError, invalidMany, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { decodeCursor, encodeCursor, parseIsoMs, parseJson, toIso } from '../crm/util';
import { applyToContact } from '../forms/mapping';
import { calendarRef, calendarRows, type CalendarRef, type CalendarRow } from './calendars';
import {
  eventTypeToApi,
  getEventTypeRow,
  hostIdsOf,
  questionsOf,
  rulesOf,
  weightsOf,
  type EventTypeRow,
} from './event-types';

/**
 * Bookings in the TenantDb. Booking, rescheduling and cancelling are single
 * synchronous ops: the slot is re-checked against the host calendars'
 * appointments, co-hosted bookings and the external busy time passed in by
 * the worker, inside the same transaction that writes the booking — the
 * TenantDb is single-threaded, so two visitors can never get the same slot.
 */

/** Calendar id → external busy intervals (Google Calendar), fetched by the worker from the calendar DOs. */
export type ExternalBusy = Record<string, Interval[]>;

export interface BookingSource {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  referrer: string | null;
  page_url: string | null;
  page_id: string | null;
}

export const EMPTY_SOURCE: BookingSource = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_term: null,
  utm_content: null,
  referrer: null,
  page_url: null,
  page_id: null,
};

export interface BookingRow extends BookingSource {
  id: string;
  event_type_id: string;
  calendar_id: string;
  calendar_ids: string;
  host_user_id: string | null;
  appointment_id: string | null;
  contact_id: string | null;
  status: 'confirmed' | 'cancelled';
  starts_at: number;
  ends_at: number;
  time_zone: string;
  locale: string;
  invitee_name: string;
  invitee_email: string;
  answers: string;
  warnings: string;
  manage_token_hash: string | null;
  channel: 'public' | 'staff';
  visitor_id: string | null;
  rescheduled_from: number | null;
  reschedule_count: number;
  cancelled_at: number | null;
  cancel_reason: string | null;
  cancelled_by: 'invitee' | 'staff' | null;
  created_at: number;
  updated_at: number;
}

type BookingRowWithTitle = BookingRow & { event_type_title: string | null };

export function bookingToApi(row: BookingRowWithTitle): Booking {
  return {
    id: row.id,
    event_type_id: row.event_type_id,
    event_type_title: row.event_type_title,
    calendar_id: row.calendar_id,
    calendar_ids: parseJson<string[]>(row.calendar_ids, [row.calendar_id]),
    host_user_id: row.host_user_id,
    appointment_id: row.appointment_id,
    contact_id: row.contact_id,
    status: row.status,
    starts_at: toIso(row.starts_at),
    ends_at: toIso(row.ends_at),
    time_zone: row.time_zone,
    locale: row.locale,
    invitee_name: row.invitee_name,
    invitee_email: row.invitee_email,
    answers: parseJson<BookingAnswers>(row.answers, {}),
    warnings: parseJson<string[]>(row.warnings, []),
    channel: row.channel,
    source: {
      utm_source: row.utm_source,
      utm_medium: row.utm_medium,
      utm_campaign: row.utm_campaign,
      utm_term: row.utm_term,
      utm_content: row.utm_content,
      referrer: row.referrer,
      page_url: row.page_url,
      page_id: row.page_id,
    },
    visitor_id: row.visitor_id,
    rescheduled_from: toIso(row.rescheduled_from),
    reschedule_count: row.reschedule_count,
    cancelled_at: toIso(row.cancelled_at),
    cancel_reason: row.cancel_reason,
    cancelled_by: row.cancelled_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

const SELECT_BOOKING = `SELECT b.*, e.title AS event_type_title FROM booking_bookings b
  LEFT JOIN booking_event_types e ON e.id = b.event_type_id`;

function bookingRow(ctx: CrmContext, ref: { id?: string; tokenHash?: string }): BookingRowWithTitle {
  const row =
    ref.id !== undefined
      ? ctx.db.all<BookingRowWithTitle>(`${SELECT_BOOKING} WHERE b.id = ?`, ref.id)[0]
      : ref.tokenHash !== undefined && ref.tokenHash !== ''
        ? ctx.db.all<BookingRowWithTitle>(`${SELECT_BOOKING} WHERE b.manage_token_hash = ?`, ref.tokenHash)[0]
        : undefined;
  if (row === undefined) throw notFound('booking', ref.id ?? 'token');
  return row;
}

// ------------------------------------------------------------ availability

const LOAD_WINDOW_MS = 30 * DAY_MS;

function calendarIdsOf(row: { calendar_ids: string; calendar_id: string }): string[] {
  return parseJson<string[]>(row.calendar_ids, [row.calendar_id]);
}

/** Engine input of each host: busy time (appointments, co-hosted bookings, external), booked starts, load. */
function hostSchedules(
  ctx: CrmContext,
  event: EventTypeRow,
  calendars: readonly CalendarRow[],
  external: ExternalBusy,
  from: number,
  to: number,
  excludeBookingId: string | null,
): HostSchedule[] {
  const margin = DAY_MS + (event.duration_minutes + event.buffer_before_minutes + event.buffer_after_minutes) * 60_000;
  const lo = from - margin;
  const hi = to + margin;
  const excluded =
    excludeBookingId === null
      ? null
      : (ctx.db.all<{ appointment_id: string | null }>(`SELECT appointment_id FROM booking_bookings WHERE id = ?`, excludeBookingId)[0]
          ?.appointment_id ?? null);
  const bookings = ctx.db
    .all<{ id: string; event_type_id: string; calendar_id: string; calendar_ids: string; starts_at: number; ends_at: number; created_at: number }>(
      `SELECT id, event_type_id, calendar_id, calendar_ids, starts_at, ends_at, created_at FROM booking_bookings
       WHERE status = 'confirmed' AND ends_at > ? AND starts_at < ?`,
      Math.min(lo, ctx.now() - LOAD_WINDOW_MS),
      hi,
    )
    .filter((b) => b.id !== excludeBookingId);
  const weights = event.assignment === 'round_robin' ? weightsOf(event) : {};
  return calendars.map((calendar) => {
    const weight = weights[calendar.id];
    const appointments = ctx.db
      .all<{ id: string; start_at: number; end_at: number }>(
        `SELECT id, start_at, end_at FROM crm_appointments
         WHERE deleted_at IS NULL AND status != 'cancelled' AND owner_id = ? AND end_at > ? AND start_at < ?`,
        calendar.host_user_id,
        lo,
        hi,
      )
      .filter((a) => a.id !== excluded);
    const mine = bookings.filter((b) => calendarIdsOf(b).includes(calendar.id));
    const sameType = mine.filter((b) => b.event_type_id === event.id);
    const recent = sameType.filter((b) => b.calendar_id === calendar.id && b.created_at >= ctx.now() - LOAD_WINDOW_MS);
    return {
      calendarId: calendar.id,
      timeZone: calendar.time_zone,
      weeklyRules: parseJson(calendar.weekly_rules, []),
      overrides: parseJson(calendar.date_overrides, []),
      busy: [
        ...appointments.map((a) => ({ start: a.start_at, end: a.end_at })),
        ...mine.filter((b) => b.ends_at > lo && b.starts_at < hi).map((b) => ({ start: b.starts_at, end: b.ends_at })),
        ...(external[calendar.id] ?? []),
      ],
      bookedStarts: sameType.map((b) => b.starts_at),
      load: {
        count: recent.length,
        lastAssignedAt: recent.reduce<number | null>((max, b) => (max === null || b.created_at > max ? b.created_at : max), null),
      },
      ...(weight === undefined ? {} : { share: weight / 100 }),
    };
  });
}

export interface SlotsResult {
  timeZone: string;
  slots: AvailableSlot[];
}

/** Bookable slots of an event type with a start in `[from, to]` (epoch ms). */
export function slots(
  ctx: CrmContext,
  input: { eventTypeId: string; from: number; to: number; externalBusy?: ExternalBusy; publicOnly?: boolean; excludeBookingId?: string },
): SlotsResult {
  const event = getEventTypeRow(ctx, input.eventTypeId);
  if (input.publicOnly === true && event.active !== 1) throw notFound('event type', input.eventTypeId);
  const calendars = calendarRows(ctx, hostIdsOf(event));
  const hosts = hostSchedules(ctx, event, calendars, input.externalBusy ?? {}, input.from, input.to, input.excludeBookingId ?? null);
  return {
    timeZone: calendars[0]?.time_zone ?? 'UTC',
    slots: computeSlots({
      now: ctx.now(),
      rules: rulesOf(event),
      assignment: event.assignment,
      hosts,
      from: input.from,
      to: input.to,
    }),
  };
}

function rejected(reason: SlotRejection): CrmError {
  return new CrmError('conflict', `the requested time is not available (${reason})`, [{ path: 'start', message: reason }]);
}

/** Hosts that get the booking: all of them (collective) or one free host (round robin). */
function assignHosts(
  event: EventTypeRow,
  hosts: HostSchedule[],
  start: number,
  now: number,
  preferred: string | null,
): string[] {
  const check = checkSlot({ now, rules: rulesOf(event), assignment: event.assignment, hosts }, start);
  if (!check.ok) throw rejected(check.reason);
  if (event.assignment === 'collective') return check.calendarIds;
  if (preferred !== null) {
    if (!check.calendarIds.includes(preferred)) throw rejected('slot_taken');
    return [preferred];
  }
  const picked = pickRoundRobinHost(hosts, check.calendarIds);
  if (picked === null) throw rejected('slot_taken');
  return [picked];
}

// ----------------------------------------------------------------- outcome

export interface BookingOutcome {
  kind: 'booked' | 'rescheduled' | 'cancelled';
  /** False when nothing changed (e.g. cancelling a cancelled booking). */
  changed: boolean;
  booking: Booking;
  eventType: BookingEventType;
  /** Calendars of the booking, primary host first. */
  calendars: CalendarRef[];
  /** Calendar DOs whose availability changed (booking hosts + first host of every event type sharing them). */
  notifyCalendarIds: string[];
  previous: { startsAt: string; endsAt: string } | null;
}

function notifyIdsFor(ctx: CrmContext, calendarIds: readonly string[]): string[] {
  const ids = new Set(calendarIds);
  const events = ctx.db.all<{ host_calendar_ids: string }>(
    `SELECT host_calendar_ids FROM booking_event_types WHERE deleted_at IS NULL`,
  );
  for (const event of events) {
    const hosts = parseJson<string[]>(event.host_calendar_ids, []);
    if (hosts[0] !== undefined && hosts.some((h) => calendarIds.includes(h))) ids.add(hosts[0]);
  }
  return [...ids];
}

function outcome(
  ctx: CrmContext,
  kind: BookingOutcome['kind'],
  bookingId: string,
  changed: boolean,
  previous: BookingOutcome['previous'],
  /** Calendars the booking just left (reschedule to another host). */
  leftCalendarIds: readonly string[] = [],
): BookingOutcome {
  const row = bookingRow(ctx, { id: bookingId });
  const ids = calendarIdsOf(row);
  const calendars = calendarRows(ctx, ids);
  return {
    kind,
    changed,
    booking: bookingToApi(row),
    eventType: eventTypeToApi(getEventTypeRow(ctx, row.event_type_id)),
    calendars: calendars.map(calendarRef),
    notifyCalendarIds: notifyIdsFor(ctx, [...ids, ...leftCalendarIds]),
    previous,
  };
}

// --------------------------------------------------------------------- book

export interface BookInput {
  eventTypeId: string;
  /** Epoch ms. */
  start: number;
  timeZone: string;
  locale: 'en' | 'it';
  invitee: InviteeInput;
  answers: Record<string, unknown>;
  source: BookingSource;
  visitorId: string | null;
  manageTokenHash: string;
  externalBusy: ExternalBusy;
  channel: 'public' | 'staff';
  /** Staff only: force this host (round robin). */
  calendarId?: string;
}

const MAP_KIND: Record<BookingQuestion['kind'], FormFieldInput['kind']> = {
  text: 'text',
  textarea: 'textarea',
  phone: 'phone',
  number: 'number',
  select: 'select',
  multicheck: 'multicheck',
  checkbox: 'checkbox',
};

/** The booking as a form submission, so contacts are matched and filled exactly like form leads. */
function contactDefinition(event: EventTypeRow) {
  const fields: FormFieldInput[] = [
    { id: 'given_name', kind: 'text', key: 'given_name', map_to: 'given_name' },
    { id: 'family_name', kind: 'text', key: 'family_name', map_to: 'family_name' },
    { id: 'email', kind: 'email', key: 'email', map_to: 'email' },
    { id: 'phone', kind: 'phone', key: 'phone', map_to: 'phone' },
  ];
  for (const q of questionsOf(event)) {
    if (q.map_to === null) continue;
    fields.push({
      id: `q_${q.key}`,
      kind: MAP_KIND[q.kind],
      key: q.key,
      options: q.options.map((o) => ({ label: o, value: o })),
      map_to: q.map_to as FormFieldInput['map_to'],
    });
  }
  return formDefinitionSchema.parse({
    fields,
    crm: { create_contacts: true, tag_ids: parseJson<string[]>(event.tag_ids, []), update_policy: 'fill_empty' },
  });
}

function upsertContact(
  ctx: CrmContext,
  event: EventTypeRow,
  invitee: InviteeInput,
  answers: BookingAnswers,
  source: BookingSource,
): { contactId: string; warnings: string[] } {
  const values: SubmissionValues = { ...answers, given_name: invitee.given_name, email: invitee.email };
  if (invitee.family_name !== '') values['family_name'] = invitee.family_name;
  if (invitee.phone !== '') values['phone'] = invitee.phone;
  const tracking: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const) {
    const value = source[key];
    if (value !== null) tracking[key] = value;
  }
  const result = applyToContact(ctx, contactDefinition(event), values, tracking);
  if (result.contactId === null) throw new CrmError('validation_failed', 'the invitee email is required', [{ path: 'email', message: 'required' }]);
  if (result.created) {
    ctx.db.run(`UPDATE crm_contacts SET source_type = 'booking' WHERE id = ?`, result.contactId);
  }
  return { contactId: result.contactId, warnings: result.warnings };
}

function answersSummary(questions: readonly BookingQuestion[], answers: BookingAnswers): string | null {
  const lines = questions
    .filter((q) => answers[q.key] !== undefined)
    .map((q) => {
      const value = answers[q.key];
      return `${q.label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`;
    });
  return lines.length === 0 ? null : lines.join('\n');
}

function validated(event: EventTypeRow, invitee: InviteeInput, answers: Record<string, unknown>): { invitee: InviteeInput; answers: BookingAnswers } {
  const person = validateInvitee(invitee, event.phone_mode);
  const checked = validateAnswers(questionsOf(event), answers);
  const details = [
    ...(person.ok ? [] : Object.entries(person.errors).map(([path, message]) => ({ path, message }))),
    ...(checked.ok ? [] : Object.entries(checked.errors).map(([key, message]) => ({ path: `answers.${key}`, message }))),
  ];
  if (!person.ok || !checked.ok) throw invalidMany(details);
  return { invitee: person.value, answers: checked.value };
}

function bookingFacts(row: BookingRow) {
  return {
    appointmentId: row.appointment_id ?? '',
    bookingId: row.id,
    eventTypeId: row.event_type_id,
    calendarId: row.calendar_id,
    contactId: row.contact_id ?? '',
    ownerId: row.host_user_id,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    timeZone: row.time_zone,
  };
}

export function book(ctx: CrmContext, input: BookInput): BookingOutcome {
  const event = getEventTypeRow(ctx, input.eventTypeId);
  if (input.channel === 'public' && event.active !== 1) throw notFound('event type', input.eventTypeId);
  const { invitee, answers } = validated(event, input.invitee, input.answers);
  const calendars = calendarRows(ctx, hostIdsOf(event));
  const end = input.start + event.duration_minutes * 60_000;
  const hosts = hostSchedules(ctx, event, calendars, input.externalBusy, input.start, end, null);
  const assigned = assignHosts(event, hosts, input.start, ctx.now(), input.calendarId ?? null);
  const primary = calendars.find((c) => c.id === assigned[0]);
  if (primary === undefined) throw rejected('no_hosts');

  const { contactId, warnings } = upsertContact(ctx, event, invitee, answers, input.source);
  const name = [invitee.given_name, invitee.family_name].filter((p) => p !== '').join(' ');
  const appointment = createAppointment(ctx, {
    title: `${event.title}: ${name}`,
    description: answersSummary(questionsOf(event), answers),
    location: event.location === '' ? null : event.location,
    start_at: toIso(input.start),
    end_at: toIso(end),
    time_zone: input.timeZone,
    contact_id: contactId,
    owner_id: primary.host_user_id,
    attendees: [{ email: invitee.email, name }],
    reminder_minutes: [],
    source: 'booking',
  });

  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO booking_bookings (id, event_type_id, calendar_id, calendar_ids, host_user_id, appointment_id, contact_id,
       status, starts_at, ends_at, time_zone, locale, invitee_name, invitee_email, answers, warnings, manage_token_hash,
       channel, visitor_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, page_url, page_id,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    event.id,
    primary.id,
    JSON.stringify(assigned),
    primary.host_user_id,
    appointment.id,
    contactId,
    input.start,
    end,
    input.timeZone,
    input.locale,
    name,
    invitee.email,
    JSON.stringify(answers),
    JSON.stringify(warnings),
    input.manageTokenHash,
    input.channel,
    input.visitorId,
    input.source.utm_source,
    input.source.utm_medium,
    input.source.utm_campaign,
    input.source.utm_term,
    input.source.utm_content,
    input.source.referrer,
    input.source.page_url,
    input.source.page_id,
    ctx.actor.id,
    now,
    now,
  );
  const row = bookingRow(ctx, { id });
  emit(
    ctx,
    'appointment.booked',
    {
      ...bookingFacts(row),
      source: {
        utmSource: row.utm_source,
        utmMedium: row.utm_medium,
        utmCampaign: row.utm_campaign,
        utmTerm: row.utm_term,
        utmContent: row.utm_content,
        referrer: row.referrer,
        pageUrl: row.page_url,
        pageId: row.page_id,
      },
      visitorId: row.visitor_id,
    },
    { title: event.title, startAt: toIso(row.starts_at) },
  );
  return outcome(ctx, 'booked', id, true, null);
}

// --------------------------------------------------------------- reschedule

function appointmentAlive(ctx: CrmContext, id: string | null): boolean {
  if (id === null) return false;
  return ctx.db.all(`SELECT 1 FROM crm_appointments WHERE id = ? AND deleted_at IS NULL`, id).length > 0;
}

/** The event type does not let the invitee do this from the manage link. */
function notAllowed(reason: 'reschedule_disabled' | 'cancel_disabled'): CrmError {
  return new CrmError('conflict', `the host does not allow this change (${reason})`, [{ path: 'booking', message: reason }]);
}

function assertChangeable(ctx: CrmContext, row: BookingRow, by: 'invitee' | 'staff'): void {
  if (row.status === 'cancelled') throw new CrmError('conflict', 'the booking is cancelled');
  if (by === 'invitee' && row.starts_at <= ctx.now()) throw new CrmError('conflict', 'the booking has already started');
}

export function rescheduleBooking(
  ctx: CrmContext,
  input: {
    id?: string;
    tokenHash?: string;
    start: number;
    externalBusy: ExternalBusy;
    by: 'invitee' | 'staff';
    timeZone?: string;
    /** Replaces the manage link (staff reschedules: the invitee gets a fresh link). */
    newTokenHash?: string;
  },
): BookingOutcome {
  const row = bookingRow(ctx, input);
  assertChangeable(ctx, row, input.by);
  const event = getEventTypeRow(ctx, row.event_type_id);
  if (input.by === 'invitee' && event.allow_reschedule !== 1) throw notAllowed('reschedule_disabled');
  const current = calendarIdsOf(row);
  const end = input.start + event.duration_minutes * 60_000;
  const candidates = event.assignment === 'collective' ? current : [...new Set([...current, ...hostIdsOf(event)])];
  const calendars = calendarRows(ctx, candidates);
  const hosts = hostSchedules(ctx, event, calendars, input.externalBusy, input.start, end, row.id);
  const check = checkSlot({ now: ctx.now(), rules: rulesOf(event), assignment: event.assignment, hosts }, input.start);
  if (!check.ok) throw rejected(check.reason);
  const assigned =
    event.assignment === 'collective'
      ? check.calendarIds
      : [check.calendarIds.includes(row.calendar_id) ? row.calendar_id : (pickRoundRobinHost(hosts, check.calendarIds) ?? '')];
  const primary = calendars.find((c) => c.id === assigned[0]);
  if (primary === undefined) throw rejected('slot_taken');

  let appointmentId = row.appointment_id;
  if (appointmentId !== null && appointmentAlive(ctx, appointmentId)) {
    updateAppointment(ctx, {
      id: appointmentId,
      data: {
        start_at: toIso(input.start),
        end_at: toIso(end),
        owner_id: primary.host_user_id,
        status: 'scheduled',
        ...(input.timeZone === undefined ? {} : { time_zone: input.timeZone }),
      },
    });
  } else {
    appointmentId = createAppointment(ctx, {
      title: `${event.title}: ${row.invitee_name}`,
      location: event.location === '' ? null : event.location,
      start_at: toIso(input.start),
      end_at: toIso(end),
      time_zone: input.timeZone ?? row.time_zone,
      contact_id: row.contact_id,
      owner_id: primary.host_user_id,
      attendees: [{ email: row.invitee_email, name: row.invitee_name }],
      source: 'booking',
    }).id;
  }
  ctx.db.run(
    `UPDATE booking_bookings SET starts_at = ?, ends_at = ?, calendar_id = ?, calendar_ids = ?, host_user_id = ?,
       appointment_id = ?, time_zone = ?, rescheduled_from = ?, reschedule_count = reschedule_count + 1,
       manage_token_hash = ?, updated_at = ? WHERE id = ?`,
    input.start,
    end,
    primary.id,
    JSON.stringify(assigned),
    primary.host_user_id,
    appointmentId,
    input.timeZone ?? row.time_zone,
    row.starts_at,
    input.newTokenHash ?? row.manage_token_hash,
    ctx.now(),
    row.id,
  );
  const updated = bookingRow(ctx, { id: row.id });
  const previous = { startsAt: toIso(row.starts_at), endsAt: toIso(row.ends_at) };
  emit(ctx, 'appointment.rescheduled', { ...bookingFacts(updated), previousStartsAt: previous.startsAt, previousEndsAt: previous.endsAt }, {
    title: event.title,
    startAt: toIso(updated.starts_at),
  });
  return outcome(ctx, 'rescheduled', row.id, true, previous, calendarIdsOf(row));
}

// ------------------------------------------------------------------- cancel

export function cancelBooking(
  ctx: CrmContext,
  input: { id?: string; tokenHash?: string; reason?: string; by: 'invitee' | 'staff' },
): BookingOutcome {
  const row = bookingRow(ctx, input);
  if (row.status === 'cancelled') return outcome(ctx, 'cancelled', row.id, false, null);
  assertChangeable(ctx, row, input.by);
  if (input.by === 'invitee' && getEventTypeRow(ctx, row.event_type_id).allow_cancel !== 1) throw notAllowed('cancel_disabled');
  if (row.appointment_id !== null && appointmentAlive(ctx, row.appointment_id)) {
    if (getAppointment(ctx, { id: row.appointment_id }).status !== 'cancelled') {
      updateAppointment(ctx, { id: row.appointment_id, data: { status: 'cancelled' } });
    }
  }
  const now = ctx.now();
  const reason = input.reason?.trim() ?? '';
  ctx.db.run(
    `UPDATE booking_bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, cancelled_by = ?, updated_at = ? WHERE id = ?`,
    now,
    reason === '' ? null : reason.slice(0, 500),
    input.by,
    now,
    row.id,
  );
  return outcome(ctx, 'cancelled', row.id, true, null);
}

/**
 * Cancels the confirmed booking behind a CRM appointment that was just
 * cancelled or deleted. The appointment is already in its final state, so
 * `cancelBooking` does not touch it again (one `appointment.cancelled` only).
 */
function cancelLinkedBooking(ctx: CrmContext, appointmentId: string): BookingOutcome | null {
  const linked = ctx.db.all<{ id: string }>(
    `SELECT id FROM booking_bookings WHERE appointment_id = ? AND status = 'confirmed' LIMIT 1`,
    appointmentId,
  )[0];
  return linked === undefined ? null : cancelBooking(ctx, { id: linked.id, by: 'staff' });
}

export interface AppointmentChange<T> {
  appointment: T;
  /** The linked booking when this change cancelled it (worker: emails, reminders, live version). */
  booking: BookingOutcome | null;
}

/** CRM appointment update that also cancels the linked booking when the appointment becomes cancelled. */
export function updateAppointmentSynced(
  ctx: CrmContext,
  input: Parameters<typeof updateAppointment>[1],
): AppointmentChange<Appointment> {
  const appointment = updateAppointment(ctx, input);
  return {
    appointment,
    booking: appointment.status === 'cancelled' ? cancelLinkedBooking(ctx, appointment.id) : null,
  };
}

/** CRM appointment delete that also cancels the linked booking. */
export function deleteAppointmentSynced(
  ctx: CrmContext,
  input: { id: string },
): AppointmentChange<{ id: string; deleted: true }> {
  const appointment = deleteAppointment(ctx, input);
  return { appointment, booking: cancelLinkedBooking(ctx, input.id) };
}

// ------------------------------------------------------------------ queries

export function getBooking(ctx: CrmContext, input: { id: string }): Booking {
  return bookingToApi(bookingRow(ctx, { id: input.id }));
}

/** Booking behind a manage link, with what the worker needs to render or change it. */
export function manageContext(ctx: CrmContext, input: { tokenHash: string }): BookingOutcome {
  const row = bookingRow(ctx, { tokenHash: input.tokenHash });
  return outcome(ctx, row.status === 'cancelled' ? 'cancelled' : 'booked', row.id, false, null);
}

/** Booking facts for the worker (staff cancel / reschedule: calendars, event type). */
export function bookingContext(ctx: CrmContext, input: { id: string }): BookingOutcome {
  const row = bookingRow(ctx, { id: input.id });
  return outcome(ctx, row.status === 'cancelled' ? 'cancelled' : 'booked', row.id, false, null);
}

export function listBookings(ctx: CrmContext, input: ListBookingsQuery): Page<Booking> {
  const asc = input.order === 'asc';
  const from = input.from === undefined ? null : parseIsoMs(input.from, 'from');
  const to = input.to === undefined ? null : parseIsoMs(input.to, 'to');
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const at = typeof cursor?.v === 'number' ? cursor.v : null;
  const rows = ctx.db.all<BookingRowWithTitle>(
    `${SELECT_BOOKING} WHERE (? IS NULL OR b.status = ?) AND (? IS NULL OR b.event_type_id = ?)
       AND (? IS NULL OR b.calendar_ids LIKE '%"' || ? || '"%') AND (? IS NULL OR b.contact_id = ?)
       AND (? IS NULL OR b.starts_at >= ?) AND (? IS NULL OR b.starts_at < ?)
       AND (? IS NULL OR ${asc ? 'b.starts_at > ? OR (b.starts_at = ? AND b.id > ?)' : 'b.starts_at < ? OR (b.starts_at = ? AND b.id < ?)'})
     ORDER BY b.starts_at ${asc ? 'ASC' : 'DESC'}, b.id ${asc ? 'ASC' : 'DESC'} LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    input.event_type_id ?? null,
    input.event_type_id ?? null,
    input.calendar_id ?? null,
    input.calendar_id ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    from,
    from,
    to,
    to,
    at,
    at,
    at,
    cursor?.id ?? '',
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(bookingToApi),
    next_cursor: rows.length > input.limit && last !== undefined ? encodeCursor({ v: last.starts_at, id: last.id }) : null,
  };
}
