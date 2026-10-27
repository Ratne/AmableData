import {
  bookingNotificationsSchema,
  bookingQuestionSchema,
  type BookingEventType,
  type BookingMessages,
  type BookingNotification,
  type BookingNotificationInput,
  type BookingQuestionInput,
  type CreateBookingEventTypeInput,
  type UpdateBookingEventTypeInput,
} from '@amable/api-types';
import type { Assignment, BookingLocaleSetting, BookingQuestion, EventTypeRules, PhoneMode } from '@amable/booking';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { CrmError, invalid, notFound } from '../crm/errors';
import { assertTags } from '../crm/tags';
import { parseJson, toIso } from '../crm/util';
import { calendarRef, calendarRows, type CalendarRef } from './calendars';

/** Event types: what can be booked, by whom, with which limits, questions, reminders and messages. */

export interface EventTypeRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  duration_minutes: number;
  location: string;
  slot_interval_minutes: number | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  min_notice_minutes: number;
  max_days_ahead: number;
  max_per_day: number | null;
  host_calendar_ids: string;
  /** Added by tenant migration 19: `{ calendarId: percent }`, `{}` = even. */
  host_weights: string;
  assignment: Assignment;
  phone_mode: PhoneMode;
  questions: string;
  tag_ids: string;
  /** Mirror of the `before` notification offsets, read by releases before migration 20. */
  reminder_minutes: string;
  /** Added by tenant migration 20. */
  notifications: string;
  allow_reschedule: number;
  allow_cancel: number;
  messages: string;
  success_message: string;
  redirect_url: string;
  locale: BookingLocaleSetting;
  turnstile_enabled: number;
  active: number;
  color: string;
  created_at: number;
  updated_at: number;
}

const EMPTY_MESSAGES: BookingMessages = {
  confirmation_subject: '',
  confirmation_body: '',
};

const DEFAULT_NOTIFICATIONS: BookingNotification[] = [{ when: 'before', offset_minutes: 1440, subject: '', body: '' }];

/** Question defaults (REST input is already parsed; direct op callers may omit optional keys). */
function normalizeQuestions(list: readonly BookingQuestionInput[]): BookingQuestion[] {
  return list.map((q) => bookingQuestionSchema.parse(q));
}

/** Validated (caps, duplicates) and in send order: before the start farthest first, then after the end nearest first. */
function normalizeNotifications(list: readonly BookingNotificationInput[]): BookingNotification[] {
  const parsed = bookingNotificationsSchema.safeParse(list);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(['notifications', ...(issue?.path ?? []).map(String)].join('.'), issue?.message ?? 'invalid notifications');
  }
  const rank = (n: BookingNotification) => (n.when === 'before' ? -n.offset_minutes : n.offset_minutes + 1_000_000);
  return [...parsed.data].sort((a, b) => rank(a) - rank(b));
}

export function notificationsOf(row: EventTypeRow): BookingNotification[] {
  return parseJson<BookingNotification[]>(row.notifications, []);
}

function reminderMirror(list: readonly BookingNotification[]): string {
  return JSON.stringify(list.filter((n) => n.when === 'before').map((n) => n.offset_minutes));
}

export function questionsOf(row: EventTypeRow): BookingQuestion[] {
  return parseJson<BookingQuestion[]>(row.questions, []);
}

export function hostIdsOf(row: EventTypeRow): string[] {
  return parseJson<string[]>(row.host_calendar_ids, []);
}

export function weightsOf(row: EventTypeRow): Record<string, number> {
  return parseJson<Record<string, number>>(row.host_weights, {});
}

/**
 * Round robin shares as given (validated) or `{}`: one key per host, integers
 * adding up to 100, round robin only.
 */
function validWeights(weights: Record<string, number>, hosts: readonly string[], assignment: Assignment): Record<string, number> {
  const keys = Object.keys(weights);
  if (keys.length === 0) return {};
  if (assignment !== 'round_robin') throw invalid('host_weights', 'weights apply to round robin event types only');
  const missing = hosts.find((id) => !(id in weights));
  if (missing !== undefined) throw invalid(`host_weights.${missing}`, 'every host needs a weight');
  const extra = keys.find((id) => !hosts.includes(id));
  if (extra !== undefined) throw invalid(`host_weights.${extra}`, 'not a host of this event type');
  const total = keys.reduce((sum, id) => sum + (weights[id] ?? 0), 0);
  if (total !== 100) throw invalid('host_weights', `weights must add up to 100 (now ${String(total)})`);
  return Object.fromEntries(hosts.map((id) => [id, weights[id] as number]));
}

/** Stored weights that still fit the hosts and assignment after an update, else even. */
function keptWeights(weights: Record<string, number>, hosts: readonly string[], assignment: Assignment): Record<string, number> {
  try {
    return validWeights(weights, hosts, assignment);
  } catch {
    return {};
  }
}

export function messagesOf(row: EventTypeRow): BookingMessages {
  const stored = parseJson<Partial<BookingMessages>>(row.messages, {});
  return {
    confirmation_subject: stored.confirmation_subject ?? '',
    confirmation_body: stored.confirmation_body ?? '',
  };
}

export function rulesOf(row: EventTypeRow): EventTypeRules {
  return {
    durationMinutes: row.duration_minutes,
    slotIntervalMinutes: row.slot_interval_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    minNoticeMinutes: row.min_notice_minutes,
    maxDaysAhead: row.max_days_ahead,
    maxPerDay: row.max_per_day,
  };
}

export function eventTypeToApi(row: EventTypeRow): BookingEventType {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    duration_minutes: row.duration_minutes,
    location: row.location,
    slot_interval_minutes: row.slot_interval_minutes,
    buffer_before_minutes: row.buffer_before_minutes,
    buffer_after_minutes: row.buffer_after_minutes,
    min_notice_minutes: row.min_notice_minutes,
    max_days_ahead: row.max_days_ahead,
    max_per_day: row.max_per_day,
    host_calendar_ids: hostIdsOf(row),
    host_weights: weightsOf(row),
    assignment: row.assignment,
    phone: row.phone_mode,
    questions: questionsOf(row).map((q) => ({ ...q, options: [...q.options] })),
    tag_ids: parseJson<string[]>(row.tag_ids, []),
    notifications: notificationsOf(row),
    allow_reschedule: row.allow_reschedule === 1,
    allow_cancel: row.allow_cancel === 1,
    messages: messagesOf(row),
    success_message: row.success_message,
    redirect_url: row.redirect_url,
    locale: row.locale,
    turnstile_enabled: row.turnstile_enabled === 1,
    active: row.active === 1,
    color: row.color,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function getEventTypeRow(ctx: CrmContext, id: string): EventTypeRow {
  const row = ctx.db.all<EventTypeRow>(`SELECT * FROM booking_event_types WHERE id = ? AND deleted_at IS NULL`, id)[0];
  if (row === undefined) throw notFound('event type', id);
  return row;
}

export function eventTypeRowBySlug(ctx: CrmContext, slug: string): EventTypeRow {
  const row = ctx.db.all<EventTypeRow>(
    `SELECT * FROM booking_event_types WHERE slug = ? AND deleted_at IS NULL`,
    slug.toLowerCase(),
  )[0];
  if (row === undefined) throw notFound('event type', slug);
  return row;
}

function assertSlugFree(ctx: CrmContext, slug: string, exceptId: string | null): void {
  const taken = ctx.db.all(
    `SELECT 1 FROM booking_event_types WHERE slug = ? AND deleted_at IS NULL AND (? IS NULL OR id != ?)`,
    slug,
    exceptId,
    exceptId,
  );
  if (taken.length > 0) throw new CrmError('conflict', `slug "${slug}" is already used`, [{ path: 'slug', message: 'already used' }]);
}

function assertCalendars(ctx: CrmContext, ids: readonly string[]): void {
  const found = new Set(calendarRows(ctx, ids).map((r) => r.id));
  ids.forEach((id, index) => {
    if (!found.has(id)) throw invalid(`host_calendar_ids.${String(index)}`, `calendar ${id} not found`);
  });
}

function checkLimits(data: { duration_minutes: number; max_days_ahead: number; min_notice_minutes: number }): void {
  if (data.min_notice_minutes >= data.max_days_ahead * 1440) {
    throw invalid('min_notice_minutes', 'minimum notice must be shorter than the booking horizon');
  }
}

export function listEventTypes(
  ctx: CrmContext,
  input: { active?: 'true' | 'false'; calendar_id?: string },
): BookingEventType[] {
  const active = input.active === undefined ? null : input.active === 'true' ? 1 : 0;
  return ctx.db
    .all<EventTypeRow>(
      `SELECT * FROM booking_event_types WHERE deleted_at IS NULL AND (? IS NULL OR active = ?) ORDER BY title COLLATE NOCASE, id`,
      active,
      active,
    )
    .filter((row) => input.calendar_id === undefined || hostIdsOf(row).includes(input.calendar_id))
    .map(eventTypeToApi);
}

export function getEventType(ctx: CrmContext, input: { id: string }): BookingEventType {
  return eventTypeToApi(getEventTypeRow(ctx, input.id));
}

/** Questions and notifications may omit optional keys (defaults applied); REST input is already parsed. */
type WithQuestionInputs<T> = Omit<T, 'questions' | 'notifications'> & {
  questions?: BookingQuestionInput[];
  notifications?: BookingNotificationInput[];
};

export function createEventType(ctx: CrmContext, input: WithQuestionInputs<CreateBookingEventTypeInput>): BookingEventType {
  assertSlugFree(ctx, input.slug, null);
  assertCalendars(ctx, input.host_calendar_ids);
  if (input.tag_ids !== undefined) assertTags(ctx, input.tag_ids);
  const data = {
    duration_minutes: input.duration_minutes,
    max_days_ahead: input.max_days_ahead ?? 60,
    min_notice_minutes: input.min_notice_minutes ?? 240,
  };
  checkLimits(data);
  const assignment = input.assignment ?? 'round_robin';
  const weights = validWeights(input.host_weights ?? {}, input.host_calendar_ids, assignment);
  const notifications = input.notifications === undefined ? DEFAULT_NOTIFICATIONS : normalizeNotifications(input.notifications);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO booking_event_types (id, slug, title, description, duration_minutes, location, slot_interval_minutes,
       buffer_before_minutes, buffer_after_minutes, min_notice_minutes, max_days_ahead, max_per_day, host_calendar_ids,
       host_weights, assignment, phone_mode, questions, tag_ids, reminder_minutes, notifications, allow_reschedule,
       allow_cancel, messages, success_message, redirect_url, locale, turnstile_enabled, active, color, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.slug,
    input.title,
    input.description ?? '',
    data.duration_minutes,
    input.location ?? '',
    input.slot_interval_minutes ?? null,
    input.buffer_before_minutes ?? 0,
    input.buffer_after_minutes ?? 0,
    data.min_notice_minutes,
    data.max_days_ahead,
    input.max_per_day ?? null,
    JSON.stringify(input.host_calendar_ids),
    JSON.stringify(weights),
    assignment,
    input.phone ?? 'optional',
    JSON.stringify(normalizeQuestions(input.questions ?? [])),
    JSON.stringify(input.tag_ids ?? []),
    reminderMirror(notifications),
    JSON.stringify(notifications),
    input.allow_reschedule === false ? 0 : 1,
    input.allow_cancel === false ? 0 : 1,
    JSON.stringify({ ...EMPTY_MESSAGES, ...input.messages }),
    input.success_message ?? '',
    input.redirect_url ?? '',
    input.locale ?? 'auto',
    input.turnstile_enabled === false ? 0 : 1,
    input.active === false ? 0 : 1,
    input.color ?? '#4f46e5',
    ctx.actor.id,
    now,
    now,
  );
  return getEventType(ctx, { id });
}

export function updateEventType(
  ctx: CrmContext,
  input: { id: string; data: WithQuestionInputs<UpdateBookingEventTypeInput> },
): BookingEventType {
  const current = getEventTypeRow(ctx, input.id);
  const data = input.data;
  if (data.slug !== undefined && data.slug !== current.slug) assertSlugFree(ctx, data.slug, input.id);
  if (data.host_calendar_ids !== undefined) assertCalendars(ctx, data.host_calendar_ids);
  if (data.tag_ids !== undefined) assertTags(ctx, data.tag_ids);
  checkLimits({
    duration_minutes: data.duration_minutes ?? current.duration_minutes,
    max_days_ahead: data.max_days_ahead ?? current.max_days_ahead,
    min_notice_minutes: data.min_notice_minutes ?? current.min_notice_minutes,
  });
  const hosts = data.host_calendar_ids ?? hostIdsOf(current);
  const assignment = data.assignment ?? current.assignment;
  const weights =
    data.host_weights !== undefined
      ? validWeights(data.host_weights, hosts, assignment)
      : keptWeights(weightsOf(current), hosts, assignment);
  const pick = <T extends SqlValue>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
  const json = (value: unknown, fallback: string): string => (value === undefined ? fallback : JSON.stringify(value));
  const flag = (value: boolean | undefined, fallback: number): number => (value === undefined ? fallback : value ? 1 : 0);
  const notifications = data.notifications === undefined ? notificationsOf(current) : normalizeNotifications(data.notifications);
  ctx.db.run(
    `UPDATE booking_event_types SET slug = ?, title = ?, description = ?, duration_minutes = ?, location = ?,
       slot_interval_minutes = ?, buffer_before_minutes = ?, buffer_after_minutes = ?, min_notice_minutes = ?,
       max_days_ahead = ?, max_per_day = ?, host_calendar_ids = ?, host_weights = ?, assignment = ?, phone_mode = ?, questions = ?,
       tag_ids = ?, reminder_minutes = ?, notifications = ?, allow_reschedule = ?, allow_cancel = ?, messages = ?,
       success_message = ?, redirect_url = ?, locale = ?, turnstile_enabled = ?, active = ?, color = ?, updated_at = ?
     WHERE id = ?`,
    pick(data.slug, current.slug),
    pick(data.title, current.title),
    pick(data.description, current.description),
    pick(data.duration_minutes, current.duration_minutes),
    pick(data.location, current.location),
    pick(data.slot_interval_minutes, current.slot_interval_minutes),
    pick(data.buffer_before_minutes, current.buffer_before_minutes),
    pick(data.buffer_after_minutes, current.buffer_after_minutes),
    pick(data.min_notice_minutes, current.min_notice_minutes),
    pick(data.max_days_ahead, current.max_days_ahead),
    pick(data.max_per_day, current.max_per_day),
    json(data.host_calendar_ids, current.host_calendar_ids),
    JSON.stringify(weights),
    assignment,
    pick(data.phone, current.phone_mode),
    data.questions === undefined ? current.questions : JSON.stringify(normalizeQuestions(data.questions)),
    json(data.tag_ids, current.tag_ids),
    data.notifications === undefined ? current.reminder_minutes : reminderMirror(notifications),
    JSON.stringify(notifications),
    flag(data.allow_reschedule, current.allow_reschedule),
    flag(data.allow_cancel, current.allow_cancel),
    data.messages === undefined
      ? current.messages
      : JSON.stringify({ ...parseJson<Record<string, unknown>>(current.messages, {}), ...data.messages }),
    pick(data.success_message, current.success_message),
    pick(data.redirect_url, current.redirect_url),
    pick(data.locale, current.locale),
    flag(data.turnstile_enabled, current.turnstile_enabled),
    flag(data.active, current.active),
    pick(data.color, current.color),
    ctx.now(),
    input.id,
  );
  return getEventType(ctx, { id: input.id });
}

export function deleteEventType(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  getEventTypeRow(ctx, input.id);
  ctx.db.run(`UPDATE booking_event_types SET deleted_at = ?, updated_at = ? WHERE id = ?`, ctx.now(), ctx.now(), input.id);
  return { id: input.id, deleted: true };
}

export interface EventTypeContext {
  eventType: BookingEventType;
  /** Host calendars in event type order (deleted calendars are skipped). */
  calendars: CalendarRef[];
}

/**
 * Event type + host calendar references, by id or public slug. `publicOnly`
 * hides inactive event types (404) — what the booking page may see.
 */
export function eventTypeContext(
  ctx: CrmContext,
  input: { id?: string; slug?: string; publicOnly?: boolean },
): EventTypeContext {
  const row =
    input.id !== undefined ? getEventTypeRow(ctx, input.id) : eventTypeRowBySlug(ctx, input.slug ?? '');
  if (input.publicOnly === true && row.active !== 1) throw notFound('event type', input.slug ?? row.id);
  return { eventType: eventTypeToApi(row), calendars: calendarRows(ctx, hostIdsOf(row)).map(calendarRef) };
}
