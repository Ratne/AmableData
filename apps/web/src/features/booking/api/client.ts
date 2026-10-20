import type {
  Booking,
  BookingAvailability,
  BookingAvailabilityRules,
  BookingCalendar,
  BookingEmbed,
  BookingEventType,
  BookingGoogleConnect,
  BookingStatus,
  BookingSyncResult,
  CreateBookingCalendarInput,
  CreateBookingEventTypeInput,
  CustomField,
  Page,
  PutBookingAvailabilityInput,
  UpdateBookingCalendarInput,
  UpdateBookingEventTypeInput,
} from '@amable/api-types';
import { type Deleted, tenantRest } from '../../../lib/tenant-api';

export { TenantApiError as BookingApiError } from '../../../lib/tenant-api';

/**
 * Typed client of the calendars & bookings REST v2 surface (`/api/v2/t/{slug}`)
 * plus the lookups the editors need (members, contact custom fields, tags).
 */

export interface ListBookingsParams {
  readonly status?: BookingStatus;
  readonly event_type_id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly order?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly limit?: number;
}

export function bookingClient(slug: string) {
  const { get, post, patch, put, del, me, directory } = tenantRest(slug, { idempotent: false });
  const id = encodeURIComponent;
  const calendar = (calendarId: string) => `/bookingCalendars/${id(calendarId)}`;
  const eventType = (eventTypeId: string) => `/bookingEventTypes/${id(eventTypeId)}`;

  return {
    me,
    directory,
    calendars: {
      list: () => get<{ data: BookingCalendar[] }>('/bookingCalendars'),
      create: (input: CreateBookingCalendarInput) =>
        post<BookingCalendar>('/bookingCalendars', input),
      update: (calendarId: string, input: UpdateBookingCalendarInput) =>
        patch<BookingCalendar>(calendar(calendarId), input),
      remove: (calendarId: string) => del<Deleted>(calendar(calendarId)),
      putAvailability: (calendarId: string, input: PutBookingAvailabilityInput) =>
        put<BookingAvailabilityRules>(`${calendar(calendarId)}/availability`, input),
      googleConnect: (calendarId: string) =>
        post<BookingGoogleConnect>(`${calendar(calendarId)}/google/connect`),
      googleFinish: (calendarId: string, input: { state: string; code: string }) =>
        post<BookingCalendar>(`${calendar(calendarId)}/google/finish`, input),
      googleDisconnect: (calendarId: string) =>
        del<BookingCalendar>(`${calendar(calendarId)}/google`),
      sync: (calendarId: string) => post<BookingSyncResult>(`${calendar(calendarId)}/sync`),
      syncStatus: (calendarId: string) => get<BookingSyncResult>(`${calendar(calendarId)}/sync`),
    },
    eventTypes: {
      list: () => get<{ data: BookingEventType[] }>('/bookingEventTypes'),
      get: (eventTypeId: string) => get<BookingEventType>(eventType(eventTypeId)),
      create: (input: CreateBookingEventTypeInput) =>
        post<BookingEventType>('/bookingEventTypes', input),
      update: (eventTypeId: string, input: UpdateBookingEventTypeInput) =>
        patch<BookingEventType>(eventType(eventTypeId), input),
      remove: (eventTypeId: string) => del<Deleted>(eventType(eventTypeId)),
      embed: (eventTypeId: string) => get<BookingEmbed>(`${eventType(eventTypeId)}/embed`),
      availability: (eventTypeId: string, from: string, to: string, timeZone?: string) =>
        get<BookingAvailability>(`${eventType(eventTypeId)}/availability`, {
          from,
          to,
          time_zone: timeZone,
        }),
    },
    bookings: {
      list: (params: ListBookingsParams = {}) =>
        get<Page<Booking>>('/bookings', { limit: 100, ...params }),
      cancel: (bookingId: string, reason?: string) =>
        post<Booking>(
          `/bookings/${id(bookingId)}/cancel`,
          reason === undefined || reason === '' ? {} : { reason },
        ),
      reschedule: (bookingId: string, startAt: string) =>
        post<Booking>(`/bookings/${id(bookingId)}/reschedule`, { start_at: startAt }),
    },
    crm: {
      customFields: () => get<{ data: CustomField[] }>('/customFields/contact'),
    },
  };
}

export type BookingClient = ReturnType<typeof bookingClient>;
