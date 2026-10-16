/**
 * @amable/booking — availability engine (IANA time zones, buffers, notice,
 * horizon, daily caps, round robin / collective hosts), answer validation,
 * public booking types, widget strings and the edge ↔ core gateway op types.
 * The embeddable preact widget lives in `src/widget` and ships prebuilt
 * through `@amable/booking/bundle`.
 */

export * from './types';
export * from './tz';
export * from './availability';
export * from './validate';
export * from './public';
export * from './strings';
export type { BookingGatewayOps } from './gateway';
export { BOOKING_GATEWAY_OPS, BOOKING_LIVE_RAW_OP } from './gateway';
