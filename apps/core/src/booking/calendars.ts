import type {
  BookingCalendar,
  BookingDateOverride,
  BookingWeeklyRule,
  CreateBookingCalendarInput,
  UpdateBookingCalendarInput,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { CrmError, notFound } from '../crm/errors';
import { parseJson, toIso } from '../crm/util';

/** Host calendars: time zone, weekly hours, date overrides and the Google account reference. */

export interface CalendarRow {
  id: string;
  name: string;
  host_user_id: string;
  time_zone: string;
  weekly_rules: string;
  date_overrides: string;
  google_account_id: string | null;
  google_account_email: string | null;
  google_calendar_id: string | null;
  created_at: number;
  updated_at: number;
}

/** What the worker needs to talk to the calendar's Durable Object. */
export interface CalendarRef {
  calendarId: string;
  hostUserId: string;
  timeZone: string;
  googleAccountId: string | null;
  googleCalendarId: string | null;
}

export const DEFAULT_WEEKLY_RULES: BookingWeeklyRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start: '09:00',
  end: '17:00',
}));

export function calendarToApi(row: CalendarRow): BookingCalendar {
  return {
    id: row.id,
    name: row.name,
    host_user_id: row.host_user_id,
    time_zone: row.time_zone,
    weekly_rules: parseJson<BookingWeeklyRule[]>(row.weekly_rules, []),
    date_overrides: parseJson<BookingDateOverride[]>(row.date_overrides, []),
    google: {
      connected: row.google_account_id !== null,
      account_email: row.google_account_email,
      calendar_id: row.google_account_id === null ? null : (row.google_calendar_id ?? 'primary'),
    },
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function calendarRef(row: CalendarRow): CalendarRef {
  return {
    calendarId: row.id,
    hostUserId: row.host_user_id,
    timeZone: row.time_zone,
    googleAccountId: row.google_account_id,
    googleCalendarId: row.google_account_id === null ? null : (row.google_calendar_id ?? 'primary'),
  };
}

export function getCalendarRow(ctx: CrmContext, id: string): CalendarRow {
  const row = ctx.db.all<CalendarRow>(`SELECT * FROM booking_calendars WHERE id = ? AND deleted_at IS NULL`, id)[0];
  if (row === undefined) throw notFound('calendar', id);
  return row;
}

export function calendarRows(ctx: CrmContext, ids: readonly string[]): CalendarRow[] {
  const rows = ctx.db.all<CalendarRow>(`SELECT * FROM booking_calendars WHERE deleted_at IS NULL`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is CalendarRow => r !== undefined);
}

function sortRules(rules: readonly BookingWeeklyRule[]): BookingWeeklyRule[] {
  return [...rules].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
}

function sortOverrides(overrides: readonly BookingDateOverride[]): BookingDateOverride[] {
  return [...overrides]
    .map((o) => ({ date: o.date, intervals: [...o.intervals].sort((a, b) => a.start.localeCompare(b.start)) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function listCalendars(ctx: CrmContext, input: { hostUserId?: string }): BookingCalendar[] {
  const host = input.hostUserId ?? null;
  return ctx.db
    .all<CalendarRow>(
      `SELECT * FROM booking_calendars WHERE deleted_at IS NULL AND (? IS NULL OR host_user_id = ?) ORDER BY name COLLATE NOCASE, id`,
      host,
      host,
    )
    .map(calendarToApi);
}

export function getCalendar(ctx: CrmContext, input: { id: string }): BookingCalendar {
  return calendarToApi(getCalendarRow(ctx, input.id));
}

export function calendarForWorker(ctx: CrmContext, input: { id: string }): CalendarRef {
  return calendarRef(getCalendarRow(ctx, input.id));
}

export function createCalendar(ctx: CrmContext, input: CreateBookingCalendarInput): BookingCalendar {
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO booking_calendars (id, name, host_user_id, time_zone, weekly_rules, date_overrides, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.host_user_id,
    input.time_zone,
    JSON.stringify(sortRules(input.weekly_rules ?? DEFAULT_WEEKLY_RULES)),
    JSON.stringify(sortOverrides(input.date_overrides ?? [])),
    ctx.actor.id,
    now,
    now,
  );
  return getCalendar(ctx, { id });
}

export function updateCalendar(
  ctx: CrmContext,
  input: { id: string; data: UpdateBookingCalendarInput },
): BookingCalendar {
  const current = getCalendarRow(ctx, input.id);
  const data = input.data;
  ctx.db.run(
    `UPDATE booking_calendars SET name = ?, host_user_id = ?, time_zone = ?, weekly_rules = ?, date_overrides = ?,
       google_calendar_id = ?, updated_at = ? WHERE id = ?`,
    data.name ?? current.name,
    data.host_user_id ?? current.host_user_id,
    data.time_zone ?? current.time_zone,
    data.weekly_rules === undefined ? current.weekly_rules : JSON.stringify(sortRules(data.weekly_rules)),
    data.date_overrides === undefined ? current.date_overrides : JSON.stringify(sortOverrides(data.date_overrides)),
    data.google_calendar_id ?? current.google_calendar_id,
    ctx.now(),
    input.id,
  );
  return getCalendar(ctx, { id: input.id });
}

export function deleteCalendar(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  getCalendarRow(ctx, input.id);
  const users = ctx.db
    .all<{ title: string; host_calendar_ids: string }>(
      `SELECT title, host_calendar_ids FROM booking_event_types WHERE deleted_at IS NULL`,
    )
    .filter((row) => parseJson<string[]>(row.host_calendar_ids, []).includes(input.id));
  if (users.length > 0) {
    throw new CrmError('conflict', `calendar is a host of: ${users.map((u) => u.title).join(', ')}`);
  }
  ctx.db.run(`UPDATE booking_calendars SET deleted_at = ?, updated_at = ? WHERE id = ?`, ctx.now(), ctx.now(), input.id);
  return { id: input.id, deleted: true };
}

/** Stores (or clears, with nulls) the Google account connected through the OAuth service. */
export function setCalendarGoogle(
  ctx: CrmContext,
  input: { id: string; accountId: string | null; email: string | null },
): BookingCalendar {
  getCalendarRow(ctx, input.id);
  ctx.db.run(
    `UPDATE booking_calendars SET google_account_id = ?, google_account_email = ?,
       google_calendar_id = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(google_calendar_id, 'primary') END,
       updated_at = ? WHERE id = ?`,
    input.accountId,
    input.email,
    input.accountId,
    ctx.now(),
    input.id,
  );
  return getCalendar(ctx, { id: input.id });
}
