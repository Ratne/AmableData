import type { Migration } from '../types';

/**
 * Calendars & bookings schema of the tenant DO.
 *
 * - `booking_calendars`: one per host (tenant member) with its IANA time zone,
 *   weekly hours and date overrides (JSON), plus the reference of the Google
 *   account connected through the central OAuth service (never a token).
 * - `booking_event_types`: what can be booked (public slug, limits, hosts by
 *   calendar id, round robin / collective, questions with CRM mapping, tags,
 *   reminder offsets and message templates).
 * - `booking_bookings`: one row per booking, linked to the CRM appointment
 *   (`crm_appointments`) and contact it created. Manage links are random
 *   tokens: only their SHA-256 (hex) is stored.
 *
 * ULID ids, epoch-ms timestamps, JSON in TEXT, soft delete, user ids without FK.
 */
export const t0006Booking: Migration = {
  id: 6,
  name: 'booking',
  statements: [
    `CREATE TABLE booking_calendars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_user_id TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      weekly_rules TEXT NOT NULL DEFAULT '[]',
      date_overrides TEXT NOT NULL DEFAULT '[]',
      google_account_id TEXT,
      google_account_email TEXT,
      google_calendar_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE INDEX booking_calendars_host ON booking_calendars (host_user_id) WHERE deleted_at IS NULL`,

    `CREATE TABLE booking_event_types (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      slot_interval_minutes INTEGER,
      buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
      buffer_after_minutes INTEGER NOT NULL DEFAULT 0,
      min_notice_minutes INTEGER NOT NULL DEFAULT 0,
      max_days_ahead INTEGER NOT NULL DEFAULT 60,
      max_per_day INTEGER,
      host_calendar_ids TEXT NOT NULL DEFAULT '[]',
      assignment TEXT NOT NULL DEFAULT 'round_robin' CHECK (assignment IN ('round_robin', 'collective')),
      phone_mode TEXT NOT NULL DEFAULT 'optional' CHECK (phone_mode IN ('hidden', 'optional', 'required')),
      questions TEXT NOT NULL DEFAULT '[]',
      tag_ids TEXT NOT NULL DEFAULT '[]',
      reminder_minutes TEXT NOT NULL DEFAULT '[]',
      messages TEXT NOT NULL DEFAULT '{}',
      success_message TEXT NOT NULL DEFAULT '',
      redirect_url TEXT NOT NULL DEFAULT '',
      locale TEXT NOT NULL DEFAULT 'auto',
      turnstile_enabled INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      color TEXT NOT NULL DEFAULT '#4f46e5',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`,
    `CREATE UNIQUE INDEX booking_event_types_slug ON booking_event_types (slug) WHERE deleted_at IS NULL`,

    `CREATE TABLE booking_bookings (
      id TEXT PRIMARY KEY,
      event_type_id TEXT NOT NULL REFERENCES booking_event_types (id),
      calendar_id TEXT NOT NULL REFERENCES booking_calendars (id),
      calendar_ids TEXT NOT NULL DEFAULT '[]',
      host_user_id TEXT,
      appointment_id TEXT,
      contact_id TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      time_zone TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      invitee_name TEXT NOT NULL DEFAULT '',
      invitee_email TEXT NOT NULL DEFAULT '',
      answers TEXT NOT NULL DEFAULT '{}',
      warnings TEXT NOT NULL DEFAULT '[]',
      manage_token_hash TEXT,
      channel TEXT NOT NULL DEFAULT 'public' CHECK (channel IN ('public', 'staff')),
      visitor_id TEXT,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_term TEXT,
      utm_content TEXT,
      referrer TEXT,
      page_url TEXT,
      page_id TEXT,
      rescheduled_from INTEGER,
      reschedule_count INTEGER NOT NULL DEFAULT 0,
      cancelled_at INTEGER,
      cancel_reason TEXT,
      cancelled_by TEXT CHECK (cancelled_by IN ('invitee', 'staff')),
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX booking_bookings_starts ON booking_bookings (starts_at DESC, id DESC)`,
    `CREATE INDEX booking_bookings_calendar ON booking_bookings (calendar_id, starts_at) WHERE status = 'confirmed'`,
    `CREATE INDEX booking_bookings_event_type ON booking_bookings (event_type_id, starts_at)`,
    `CREATE INDEX booking_bookings_contact ON booking_bookings (contact_id) WHERE contact_id IS NOT NULL`,
    `CREATE INDEX booking_bookings_appointment ON booking_bookings (appointment_id) WHERE appointment_id IS NOT NULL`,
    `CREATE UNIQUE INDEX booking_bookings_token ON booking_bookings (manage_token_hash) WHERE manage_token_hash IS NOT NULL`,
  ],
};
