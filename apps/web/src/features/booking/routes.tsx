import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/*
 * Calendars and bookings pages under /t/$tenant, each in a lazily loaded
 * chunk. `bookings` replaces the navigation placeholder.
 */

export const bookingsListRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'bookings',
  component: lazyRouteComponent(() => import('./pages/bookings-list'), 'BookingsListPage'),
});

export const bookingCalendarsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'bookings/calendars',
  component: lazyRouteComponent(() => import('./pages/calendars'), 'CalendarsPage'),
});

export const bookingEventTypesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'bookings/event-types',
  component: lazyRouteComponent(() => import('./pages/event-types-list'), 'EventTypesListPage'),
});

export const bookingEventTypeRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'bookings/event-types/$eventTypeId',
  component: lazyRouteComponent(() => import('./pages/event-type-editor'), 'EventTypeEditorPage'),
});

export const bookingRoutes = [bookingsListRoute, bookingCalendarsRoute, bookingEventTypesRoute, bookingEventTypeRoute] as const;
