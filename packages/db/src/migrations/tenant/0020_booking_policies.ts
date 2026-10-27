import type { Migration } from '../types';

/**
 * Invitee permissions and per-email notifications of an event type.
 *
 * - `allow_reschedule` / `allow_cancel`: whether the invitee may move or
 *   cancel the booking from the manage link (staff always can).
 * - `notifications`: JSON array of `{ when: 'before' | 'after', offset_minutes,
 *   subject, body }`, up to 3 per side; empty texts use the built-in template.
 *   Filled from the existing reminder offsets (the 3 farthest) with the shared
 *   reminder text. `reminder_minutes` keeps mirroring the `before` offsets so a
 *   rolled back release still sends reminders.
 */
export const t0020BookingPolicies: Migration = {
  id: 20,
  name: 'booking_policies',
  statements: [
    `ALTER TABLE booking_event_types ADD COLUMN allow_reschedule INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE booking_event_types ADD COLUMN allow_cancel INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE booking_event_types ADD COLUMN notifications TEXT NOT NULL DEFAULT '[]'`,
    `UPDATE booking_event_types SET notifications = (
      SELECT json_group_array(json_object(
        'when', 'before',
        'offset_minutes', r.value,
        'subject', coalesce(json_extract(booking_event_types.messages, '$.reminder_subject'), ''),
        'body', coalesce(json_extract(booking_event_types.messages, '$.reminder_body'), '')
      ))
      FROM (
        SELECT value FROM json_each(CASE WHEN json_valid(booking_event_types.reminder_minutes) THEN booking_event_types.reminder_minutes ELSE '[]' END)
        ORDER BY value DESC LIMIT 3
      ) AS r
    )`,
  ],
};
