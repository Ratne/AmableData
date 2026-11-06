import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../middleware';
import { registerCalendarsRoutes } from './calendars';
import { registerEventTypesRoutes } from './event-types';
import { registerBookingsRoutes } from './bookings';

export { finishChange } from './shared';

/** Calendars & bookings REST v2 routes (relative to `/api/v2/t/{slug}`). */
export function registerBookingRoutes(router: OpenAPIHono<AppEnv>): void {
  registerCalendarsRoutes(router);
  registerEventTypesRoutes(router);
  registerBookingsRoutes(router);
}
