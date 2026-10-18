import { z } from 'zod';
import { dateSchema, idSchema, timestampSchema } from '../crm/common';

/**
 * Calendars & bookings REST v2 schemas: host calendars (time zone, weekly
 * hours, date overrides, Google Calendar link), event types (limits, hosts,
 * questions with CRM mapping, reminders, messages), availability preview and
 * bookings. Times in JSON are ISO 8601 UTC; wall-clock hours are `HH:MM` in
 * the calendar's IANA time zone.
 */

const listQuery = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
};

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const bookingTimeZoneSchema = z.string().min(1).max(64).refine(validTimeZone, 'unknown IANA time zone');

const HM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const hm = z.string().regex(HM_RE, 'expected HH:MM');
const minutesOf = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

export const bookingTimeRangeSchema = z
  .object({ start: hm, end: hm })
  .refine((r) => minutesOf(r.end) > minutesOf(r.start), { message: 'end must be after start', path: ['end'] });

export const bookingWeeklyRuleSchema = z
  .object({ weekday: z.number().int().min(0).max(6), start: hm, end: hm })
  .refine((r) => minutesOf(r.end) > minutesOf(r.start), { message: 'end must be after start', path: ['end'] });
export type BookingWeeklyRule = z.infer<typeof bookingWeeklyRuleSchema>;

export const bookingDateOverrideSchema = z.object({
  date: dateSchema,
  /** Empty: closed all day. */
  intervals: z.array(bookingTimeRangeSchema).max(10),
});
export type BookingDateOverride = z.infer<typeof bookingDateOverrideSchema>;

export const bookingWeeklyRulesSchema = z.array(bookingWeeklyRuleSchema).max(70);
export const bookingDateOverridesSchema = z
  .array(bookingDateOverrideSchema)
  .max(400)
  .refine((list) => new Set(list.map((o) => o.date)).size === list.length, 'one override per date');

// -------------------------------------------------------------- calendars

export const bookingCalendarSchema = z.object({
  id: idSchema,
  name: z.string(),
  host_user_id: idSchema,
  time_zone: z.string(),
  weekly_rules: z.array(bookingWeeklyRuleSchema),
  date_overrides: z.array(bookingDateOverrideSchema),
  google: z.object({
    connected: z.boolean(),
    account_email: z.string().nullable(),
    calendar_id: z.string().nullable(),
  }),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type BookingCalendar = z.infer<typeof bookingCalendarSchema>;

export const createBookingCalendarSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  /** A member of the tenant. */
  host_user_id: idSchema,
  time_zone: bookingTimeZoneSchema,
  /** Default: Monday-Friday 09:00-17:00. */
  weekly_rules: bookingWeeklyRulesSchema.optional(),
  date_overrides: bookingDateOverridesSchema.optional(),
});
export type CreateBookingCalendarInput = z.infer<typeof createBookingCalendarSchema>;

export const updateBookingCalendarSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  host_user_id: idSchema.optional(),
  time_zone: bookingTimeZoneSchema.optional(),
  weekly_rules: bookingWeeklyRulesSchema.optional(),
  date_overrides: bookingDateOverridesSchema.optional(),
  /** Google calendar read for busy time (default `primary`). */
  google_calendar_id: z.string().trim().min(1).max(255).optional(),
});
export type UpdateBookingCalendarInput = z.infer<typeof updateBookingCalendarSchema>;

export const bookingAvailabilityRulesSchema = z.object({
  time_zone: z.string(),
  weekly_rules: z.array(bookingWeeklyRuleSchema),
  date_overrides: z.array(bookingDateOverrideSchema),
});
export type BookingAvailabilityRules = z.infer<typeof bookingAvailabilityRulesSchema>;

export const putBookingAvailabilitySchema = z.strictObject({
  time_zone: bookingTimeZoneSchema.optional(),
  weekly_rules: bookingWeeklyRulesSchema,
  date_overrides: bookingDateOverridesSchema,
});
export type PutBookingAvailabilityInput = z.infer<typeof putBookingAvailabilitySchema>;

export const bookingCalendarParamSchema = z.object({ calendarId: idSchema });

export const bookingGoogleConnectSchema = z.object({ authorize_url: z.string(), state: z.string() });
export type BookingGoogleConnect = z.infer<typeof bookingGoogleConnectSchema>;

export const bookingGoogleFinishSchema = z.strictObject({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(2048),
});

export const BOOKING_SYNC_STATUSES = ['ok', 'stub', 'not_connected', 'unavailable', 'error'] as const;
export const bookingSyncResultSchema = z.object({
  /** `stub`: dev OAuth token, Google was not called. */
  status: z.enum(BOOKING_SYNC_STATUSES),
  busy_count: z.number().int(),
  synced_at: timestampSchema.nullable(),
  message: z.string().nullable(),
  /** Last failed write of a booking to Google Calendar (null once a write succeeds). */
  write_error: z.string().nullable(),
  /** Connected before bookings were written: reconnect Google to grant `calendar.events`. */
  needs_reconnect: z.boolean(),
});
export type BookingSyncResult = z.infer<typeof bookingSyncResultSchema>;

// ------------------------------------------------------------ event types

export const BOOKING_ASSIGNMENTS = ['round_robin', 'collective'] as const;
export const BOOKING_PHONE_MODES = ['hidden', 'optional', 'required'] as const;
export const BOOKING_QUESTION_KINDS = ['text', 'textarea', 'phone', 'number', 'select', 'multicheck', 'checkbox'] as const;
export const BOOKING_LOCALES = ['auto', 'en', 'it'] as const;
const RESERVED_KEYS = new Set(['given_name', 'family_name', 'email', 'phone']);
export const BOOKING_QUESTION_MAP_TARGETS = [
  'company_name',
  'job_title',
  'website',
  'address.line1',
  'address.street_number',
  'address.line2',
  'address.locality',
  'address.region',
  'address.postal_code',
  'address.country_code',
] as const;

export const bookingQuestionSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, 'lowercase letters, digits and underscores')
      .refine((key) => !RESERVED_KEYS.has(key), 'reserved for the invitee fields'),
    label: z.string().trim().min(1).max(300),
    kind: z.enum(BOOKING_QUESTION_KINDS),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
    placeholder: z.string().max(200).default(''),
    /** Contact attribute or `custom.<key>` (contact custom field); null keeps the answer on the booking only. */
    map_to: z
      .union([z.enum(BOOKING_QUESTION_MAP_TARGETS), z.string().regex(/^custom\.[a-z][a-z0-9_]{0,62}$/, 'expected custom.<key>')])
      .nullable()
      .default(null),
  })
  .refine((q) => (q.kind !== 'select' && q.kind !== 'multicheck') || q.options.length > 0, {
    message: 'add at least one option',
    path: ['options'],
  });
export type BookingQuestionInput = z.input<typeof bookingQuestionSchema>;
export type BookingQuestionValue = z.infer<typeof bookingQuestionSchema>;

const questionsSchema = z
  .array(bookingQuestionSchema)
  .max(30)
  .superRefine((list, ctx) => {
    const keys = new Set<string>();
    const targets = new Set<string>();
    list.forEach((q, index) => {
      if (keys.has(q.key)) ctx.addIssue({ code: 'custom', path: [index, 'key'], message: 'duplicate key' });
      keys.add(q.key);
      if (q.map_to !== null) {
        if (targets.has(q.map_to)) ctx.addIssue({ code: 'custom', path: [index, 'map_to'], message: 'another question already maps to this attribute' });
        targets.add(q.map_to);
      }
    });
  });

/** Empty strings use the built-in (localized) template. Liquid: `{{ contact.first_name }}`, `{{ booking.start_time }}`… */
export const bookingMessagesSchema = z.object({
  confirmation_subject: z.string().max(300).default(''),
  confirmation_body: z.string().max(20_000).default(''),
  reminder_subject: z.string().max(300).default(''),
  reminder_body: z.string().max(20_000).default(''),
});
export type BookingMessages = z.infer<typeof bookingMessagesSchema>;

const uniqueIds = (max: number, min = 0) =>
  z
    .array(idSchema)
    .min(min)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate ids');

const eventTypeFields = {
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'lowercase letters, digits and dashes'),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  duration_minutes: z.number().int().min(5).max(720),
  location: z.string().max(500),
  /** Grid of proposed start times; null = the duration. */
  slot_interval_minutes: z.number().int().min(5).max(720).nullable(),
  buffer_before_minutes: z.number().int().min(0).max(240),
  buffer_after_minutes: z.number().int().min(0).max(240),
  min_notice_minutes: z.number().int().min(0).max(43_200),
  max_days_ahead: z.number().int().min(1).max(365),
  /** Per host and day; null = unlimited. */
  max_per_day: z.number().int().min(1).max(100).nullable(),
  host_calendar_ids: uniqueIds(20, 1),
  assignment: z.enum(BOOKING_ASSIGNMENTS),
  phone: z.enum(BOOKING_PHONE_MODES),
  questions: questionsSchema,
  /** Applied to the contact on every booking. */
  tag_ids: uniqueIds(50),
  /** Minutes before the start at which a reminder email is sent. */
  reminder_minutes: z
    .array(z.number().int().min(5).max(20_160))
    .max(5)
    .refine((list) => new Set(list).size === list.length, 'duplicate reminders'),
  messages: bookingMessagesSchema,
  success_message: z.string().max(2000),
  redirect_url: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2048)]),
  locale: z.enum(BOOKING_LOCALES),
  turnstile_enabled: z.boolean(),
  active: z.boolean(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb'),
};

export const createBookingEventTypeSchema = z.strictObject({
  slug: eventTypeFields.slug,
  title: eventTypeFields.title,
  duration_minutes: eventTypeFields.duration_minutes,
  host_calendar_ids: eventTypeFields.host_calendar_ids,
  description: eventTypeFields.description.optional(),
  location: eventTypeFields.location.optional(),
  slot_interval_minutes: eventTypeFields.slot_interval_minutes.optional(),
  buffer_before_minutes: eventTypeFields.buffer_before_minutes.optional(),
  buffer_after_minutes: eventTypeFields.buffer_after_minutes.optional(),
  min_notice_minutes: eventTypeFields.min_notice_minutes.optional(),
  max_days_ahead: eventTypeFields.max_days_ahead.optional(),
  max_per_day: eventTypeFields.max_per_day.optional(),
  assignment: eventTypeFields.assignment.optional(),
  phone: eventTypeFields.phone.optional(),
  questions: eventTypeFields.questions.optional(),
  tag_ids: eventTypeFields.tag_ids.optional(),
  reminder_minutes: eventTypeFields.reminder_minutes.optional(),
  messages: eventTypeFields.messages.optional(),
  success_message: eventTypeFields.success_message.optional(),
  redirect_url: eventTypeFields.redirect_url.optional(),
  locale: eventTypeFields.locale.optional(),
  turnstile_enabled: eventTypeFields.turnstile_enabled.optional(),
  active: eventTypeFields.active.optional(),
  color: eventTypeFields.color.optional(),
});
export type CreateBookingEventTypeInput = z.infer<typeof createBookingEventTypeSchema>;

export const updateBookingEventTypeSchema = createBookingEventTypeSchema.partial();
export type UpdateBookingEventTypeInput = z.infer<typeof updateBookingEventTypeSchema>;

export const bookingEventTypeSchema = z.object({
  id: idSchema,
  ...eventTypeFields,
  slug: z.string(),
  questions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(BOOKING_QUESTION_KINDS),
      required: z.boolean(),
      options: z.array(z.string()),
      placeholder: z.string(),
      map_to: z.string().nullable(),
    }),
  ),
  messages: z.object({
    confirmation_subject: z.string(),
    confirmation_body: z.string(),
    reminder_subject: z.string(),
    reminder_body: z.string(),
  }),
  redirect_url: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type BookingEventType = z.infer<typeof bookingEventTypeSchema>;

export const listBookingEventTypesQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  calendar_id: idSchema.optional(),
});

export const bookingEventTypeParamSchema = z.object({ eventTypeId: idSchema });

export const bookingEmbedSchema = z.object({
  event_type_id: idSchema,
  slug: z.string(),
  tenant: z.string(),
  script_url: z.string(),
  config_url: z.string(),
  hosted_url: z.string(),
  /** HTML to paste in a page. */
  snippet: z.string(),
});
export type BookingEmbed = z.infer<typeof bookingEmbedSchema>;

export const bookingAvailabilityQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  /** Time zone of `from` / `to` (default: the first host calendar's). */
  time_zone: bookingTimeZoneSchema.optional(),
});

export const bookingSlotSchema = z.object({
  start: timestampSchema,
  end: timestampSchema,
  /** Free host calendars at this time (collective: all hosts). */
  calendar_ids: z.array(idSchema),
});
export const bookingAvailabilitySchema = z.object({
  time_zone: z.string(),
  slots: z.array(bookingSlotSchema),
});
export type BookingAvailability = z.infer<typeof bookingAvailabilitySchema>;

// ---------------------------------------------------------------- bookings

export const BOOKING_STATUSES = ['confirmed', 'cancelled'] as const;
export const bookingStatusSchema = z.enum(BOOKING_STATUSES);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

export const bookingAnswerSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const bookingSchema = z.object({
  id: idSchema,
  event_type_id: idSchema,
  event_type_title: z.string().nullable(),
  calendar_id: idSchema,
  calendar_ids: z.array(idSchema),
  host_user_id: z.string().nullable(),
  appointment_id: z.string().nullable(),
  contact_id: z.string().nullable(),
  status: bookingStatusSchema,
  starts_at: timestampSchema,
  ends_at: timestampSchema,
  time_zone: z.string(),
  locale: z.string(),
  invitee_name: z.string(),
  invitee_email: z.string(),
  answers: z.record(z.string(), bookingAnswerSchema),
  /** CRM mapping problems (e.g. a mapped custom field was deleted). */
  warnings: z.array(z.string()),
  channel: z.enum(['public', 'staff']),
  source: z.object({
    utm_source: z.string().nullable(),
    utm_medium: z.string().nullable(),
    utm_campaign: z.string().nullable(),
    utm_term: z.string().nullable(),
    utm_content: z.string().nullable(),
    referrer: z.string().nullable(),
    page_url: z.string().nullable(),
    page_id: z.string().nullable(),
  }),
  visitor_id: z.string().nullable(),
  /** Previous start of the last reschedule. */
  rescheduled_from: timestampSchema.nullable(),
  reschedule_count: z.number().int(),
  cancelled_at: timestampSchema.nullable(),
  cancel_reason: z.string().nullable(),
  cancelled_by: z.enum(['invitee', 'staff']).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Booking = z.infer<typeof bookingSchema>;

export const listBookingsQuerySchema = z.object({
  ...listQuery,
  status: bookingStatusSchema.optional(),
  event_type_id: idSchema.optional(),
  calendar_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  /** Bookings starting at or after (ISO 8601). */
  from: z.string().max(40).optional(),
  /** Bookings starting before (ISO 8601). */
  to: z.string().max(40).optional(),
  /** `asc` lists upcoming first (default `desc`). */
  order: z.enum(['asc', 'desc']).optional(),
});
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;

export const bookingParamSchema = z.object({ bookingId: idSchema });

export const createBookingSchema = z.strictObject({
  event_type_id: idSchema,
  start_at: z.iso.datetime({ offset: true }),
  time_zone: bookingTimeZoneSchema,
  given_name: z.string().trim().min(1).max(100),
  family_name: z.string().trim().max(100).optional(),
  email: z.email().max(254),
  phone: z.string().trim().max(30).optional(),
  answers: z.record(z.string(), bookingAnswerSchema).optional(),
  /** Assign this host calendar (round robin) instead of the automatic pick. */
  calendar_id: idSchema.optional(),
  locale: z.enum(['en', 'it']).optional(),
  /** Send the confirmation email and schedule reminders (default true). */
  notify: z.boolean().optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const cancelBookingSchema = z.strictObject({
  reason: z.string().trim().max(500).optional(),
  notify: z.boolean().optional(),
});
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;

export const rescheduleBookingSchema = z.strictObject({
  start_at: z.iso.datetime({ offset: true }),
  notify: z.boolean().optional(),
});
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;
