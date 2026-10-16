import type { CrmContext } from '../crm/context';
import * as bookings from './bookings';
import * as calendars from './calendars';
import * as eventTypes from './event-types';

/**
 * Booking operations of the TenantDb (merged into `crmOps`). Synchronous, one
 * transaction per call: external busy time, manage-token hashing, emails and
 * calendar Durable Objects are handled by the worker around them (flow.ts).
 */
export const bookingOps = {
  // calendars
  'booking.listCalendars': calendars.listCalendars,
  'booking.getCalendar': calendars.getCalendar,
  'booking.calendarForWorker': calendars.calendarForWorker,
  'booking.createCalendar': calendars.createCalendar,
  'booking.updateCalendar': calendars.updateCalendar,
  'booking.deleteCalendar': calendars.deleteCalendar,
  'booking.setCalendarGoogle': calendars.setCalendarGoogle,
  // event types
  'booking.listEventTypes': eventTypes.listEventTypes,
  'booking.getEventType': eventTypes.getEventType,
  'booking.createEventType': eventTypes.createEventType,
  'booking.updateEventType': eventTypes.updateEventType,
  'booking.deleteEventType': eventTypes.deleteEventType,
  'booking.eventTypeContext': eventTypes.eventTypeContext,
  // availability & bookings
  'booking.slots': bookings.slots,
  'booking.book': bookings.book,
  'booking.reschedule': bookings.rescheduleBooking,
  'booking.cancel': bookings.cancelBooking,
  'booking.listBookings': bookings.listBookings,
  'booking.getBooking': bookings.getBooking,
  'booking.bookingContext': bookings.bookingContext,
  'booking.manageContext': bookings.manageContext,
  // CRM appointments linked to bookings
  'booking.updateAppointment': bookings.updateAppointmentSynced,
  'booking.deleteAppointment': bookings.deleteAppointmentSynced,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
