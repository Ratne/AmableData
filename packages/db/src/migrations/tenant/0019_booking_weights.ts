import type { Migration } from '../types';

/**
 * Round robin weights of an event type: `host_weights` maps each host calendar
 * id to its integer share in percent (the shares add up to 100). `{}` spreads
 * the bookings evenly among the hosts.
 */
export const t0019BookingWeights: Migration = {
  id: 19,
  name: 'booking_weights',
  statements: [`ALTER TABLE booking_event_types ADD COLUMN host_weights TEXT NOT NULL DEFAULT '{}'`],
};
