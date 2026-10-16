/** Shared, zod-free types of calendars, event types and the public booking flow (also used by the widget). */

export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** 0 = Sunday … 6 = Saturday (`Date#getUTCDay`). */
export type Weekday = (typeof WEEKDAYS)[number];

/** Wall-clock range in the calendar's time zone, `HH:MM` (end may be `24:00`). */
export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

export interface WeeklyRule extends TimeRange {
  readonly weekday: Weekday;
}

/** Replaces the weekly rules of one local date; no intervals = closed all day. */
export interface DateOverride {
  readonly date: string;
  readonly intervals: readonly TimeRange[];
}

/** Half-open instant range `[start, end)` in epoch ms. */
export interface Interval {
  readonly start: number;
  readonly end: number;
}

export const ASSIGNMENTS = ['round_robin', 'collective'] as const;
/** Several hosts: `round_robin` needs any host free (one is assigned), `collective` needs all of them. */
export type Assignment = (typeof ASSIGNMENTS)[number];

export const QUESTION_KINDS = ['text', 'textarea', 'phone', 'number', 'select', 'multicheck', 'checkbox'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const PHONE_MODES = ['hidden', 'optional', 'required'] as const;
export type PhoneMode = (typeof PHONE_MODES)[number];

export const BOOKING_LOCALES = ['auto', 'en', 'it'] as const;
export type BookingLocaleSetting = (typeof BOOKING_LOCALES)[number];
export type BookingLocale = 'en' | 'it';

/** Keys of the invitee fields every booking collects (questions cannot reuse them). */
export const RESERVED_ANSWER_KEYS = ['given_name', 'family_name', 'email', 'phone'] as const;

/** Contact attributes a question can fill (besides `custom.<key>`); name, email and phone come from the fixed fields. */
export const QUESTION_MAP_TARGETS = [
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

export interface BookingQuestion {
  readonly key: string;
  readonly label: string;
  readonly kind: QuestionKind;
  readonly required: boolean;
  readonly options: readonly string[];
  readonly placeholder: string;
  /** Contact attribute (`QUESTION_MAP_TARGETS`) or `custom.<key>`; null = kept on the booking only. */
  readonly map_to: string | null;
}

export type BookingAnswer = string | number | boolean | string[];
export type BookingAnswers = Record<string, BookingAnswer>;

/** Booking-time limits of an event type (minutes / days). */
export interface EventTypeRules {
  readonly durationMinutes: number;
  /** Grid step of the proposed start times; null = the duration. */
  readonly slotIntervalMinutes: number | null;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxDaysAhead: number;
  /** Bookings of this event type per host and local day; null = unlimited. */
  readonly maxPerDay: number | null;
}

/** What the engine knows about one host calendar. */
export interface HostSchedule {
  readonly calendarId: string;
  readonly timeZone: string;
  readonly weeklyRules: readonly WeeklyRule[];
  readonly overrides: readonly DateOverride[];
  /** Appointments, bookings and external busy time of the host. */
  readonly busy: readonly Interval[];
  /** Starts of the host's confirmed bookings of this event type (daily cap). */
  readonly bookedStarts: readonly number[];
  /** Round robin fairness: confirmed bookings in the recent window and last assignment. */
  readonly load?: { readonly count: number; readonly lastAssignedAt: number | null };
}

export interface AvailableSlot {
  readonly start: number;
  readonly end: number;
  /** Hosts free at this time (collective: all hosts). */
  readonly calendarIds: readonly string[];
}

export const SLOT_REJECTIONS = [
  'no_hosts',
  'too_soon',
  'too_far',
  'out_of_schedule',
  'daily_limit',
  'slot_taken',
] as const;
export type SlotRejection = (typeof SLOT_REJECTIONS)[number];
