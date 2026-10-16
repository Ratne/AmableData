import type { BookPayload, BookResult, ManageView, PublicBookingConfig, PublicSlotsResult } from './public';

/**
 * Edge ↔ core gateway ops of booking pages (structurally a `GatewayOpMap` of
 * @amable/api-types). The edge serves `/booking.js` and `/b/:tenant/…`; the
 * core worker computes availability and books inside the TenantDb.
 */
export type BookingGatewayOps = {
  /** Public widget configuration of an active event type (404 otherwise). */
  'booking.config': {
    input: { eventSlug: string };
    output: PublicBookingConfig;
  };
  /** Hosted page facts. */
  'booking.hosted': {
    input: { eventSlug: string };
    output: { config: PublicBookingConfig; tenantName: string };
  };
  /** Bookable slots between two local dates (inclusive) of `timeZone`. */
  'booking.slots': {
    input: { eventSlug: string; from: string; to: string; timeZone: string };
    output: PublicSlotsResult;
  };
  /** Availability version only (cheap polling when the live socket is unavailable). */
  'booking.version': {
    input: { eventSlug: string };
    output: { version: number };
  };
  /** Validates (Turnstile, fields, slot) and books: contact + CRM appointment + confirmation email. */
  'booking.book': {
    input: { eventSlug: string; payload: BookPayload };
    output: BookResult;
  };
  /** Booking behind a manage link. */
  'booking.manage': {
    input: { token: string };
    output: ManageView;
  };
  'booking.cancel': {
    input: { token: string; reason?: string };
    output: ManageView;
  };
  'booking.reschedule': {
    input: { token: string; start: string; timeZone: string };
    output: ManageView;
  };
};

export const BOOKING_GATEWAY_OPS = [
  'booking.config',
  'booking.hosted',
  'booking.slots',
  'booking.version',
  'booking.book',
  'booking.manage',
  'booking.cancel',
  'booking.reschedule',
] as const satisfies ReadonlyArray<keyof BookingGatewayOps>;

/** Raw op (`callCoreRaw`): WebSocket upgrade to the availability stream of an event type. */
export const BOOKING_LIVE_RAW_OP = 'booking.live';
