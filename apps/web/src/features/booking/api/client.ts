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
  Tag,
  UpdateBookingCalendarInput,
  UpdateBookingEventTypeInput,
} from '@amable/api-types';
import type { Permission, Role } from '@amable/core';
import { stepUpFetch } from '../../../lib/step-up';

/**
 * Typed client of the calendars & bookings REST v2 surface (`/api/v2/t/{slug}`)
 * plus the lookups the editors need (members, contact custom fields, tags).
 */

const CSRF_HEADER = 'x-amable-csrf';

export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class BookingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    readonly details: readonly ApiErrorDetail[],
  ) {
    super(detail ?? `API ${String(status)} ${code}`);
  }
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly json?: unknown;
}

function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

let redirecting = false;

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, '1');
  const response = await stepUpFetch(`${url}${buildQuery(options.query)}`, { method, headers, body, credentials: 'same-origin' });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string; details?: ApiErrorDetail[] } | null;
    if (response.status === 401 && !redirecting && window.location.pathname !== '/login') {
      redirecting = true;
      window.location.assign('/login');
    }
    throw new BookingApiError(response.status, payload?.error ?? 'http_error', payload?.message ?? null, payload?.details ?? []);
  }
  return (await response.json()) as T;
}

export interface TenantMe {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export interface DirectoryMember {
  readonly id: string;
  readonly name: string;
}

export interface ListBookingsParams {
  readonly status?: BookingStatus;
  readonly event_type_id?: string;
  readonly from?: string;
  readonly to?: string;
  readonly order?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly limit?: number;
}

type Deleted = { id: string; deleted: true };

export function bookingClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const tenantBase = `/api/t/${encodeURIComponent(slug)}`;
  const id = encodeURIComponent;
  const get = <T>(path: string, query?: RequestOptions['query']) => request<T>(`${base}${path}`, { query });
  const post = <T>(path: string, json: unknown = {}) => request<T>(`${base}${path}`, { method: 'POST', json });
  const patch = <T>(path: string, json: unknown) => request<T>(`${base}${path}`, { method: 'PATCH', json });
  const put = <T>(path: string, json: unknown) => request<T>(`${base}${path}`, { method: 'PUT', json });
  const del = <T>(path: string) => request<T>(`${base}${path}`, { method: 'DELETE' });
  const calendar = (calendarId: string) => `/bookingCalendars/${id(calendarId)}`;
  const eventType = (eventTypeId: string) => `/bookingEventTypes/${id(eventTypeId)}`;

  return {
    me: () => request<TenantMe>(`${tenantBase}/me`),
    directory: () => request<{ members: DirectoryMember[] }>(`${tenantBase}/directory`),
    calendars: {
      list: () => get<{ data: BookingCalendar[] }>('/bookingCalendars'),
      create: (input: CreateBookingCalendarInput) => post<BookingCalendar>('/bookingCalendars', input),
      update: (calendarId: string, input: UpdateBookingCalendarInput) => patch<BookingCalendar>(calendar(calendarId), input),
      remove: (calendarId: string) => del<Deleted>(calendar(calendarId)),
      putAvailability: (calendarId: string, input: PutBookingAvailabilityInput) =>
        put<BookingAvailabilityRules>(`${calendar(calendarId)}/availability`, input),
      googleConnect: (calendarId: string) => post<BookingGoogleConnect>(`${calendar(calendarId)}/google/connect`),
      googleFinish: (calendarId: string, input: { state: string; code: string }) =>
        post<BookingCalendar>(`${calendar(calendarId)}/google/finish`, input),
      googleDisconnect: (calendarId: string) => del<BookingCalendar>(`${calendar(calendarId)}/google`),
      sync: (calendarId: string) => post<BookingSyncResult>(`${calendar(calendarId)}/sync`),
    },
    eventTypes: {
      list: () => get<{ data: BookingEventType[] }>('/bookingEventTypes'),
      get: (eventTypeId: string) => get<BookingEventType>(eventType(eventTypeId)),
      create: (input: CreateBookingEventTypeInput) => post<BookingEventType>('/bookingEventTypes', input),
      update: (eventTypeId: string, input: UpdateBookingEventTypeInput) => patch<BookingEventType>(eventType(eventTypeId), input),
      remove: (eventTypeId: string) => del<Deleted>(eventType(eventTypeId)),
      embed: (eventTypeId: string) => get<BookingEmbed>(`${eventType(eventTypeId)}/embed`),
      availability: (eventTypeId: string, from: string, to: string, timeZone?: string) =>
        get<BookingAvailability>(`${eventType(eventTypeId)}/availability`, { from, to, time_zone: timeZone }),
    },
    bookings: {
      list: (params: ListBookingsParams = {}) => get<Page<Booking>>('/bookings', { limit: 100, ...params }),
      cancel: (bookingId: string, reason?: string) =>
        post<Booking>(`/bookings/${id(bookingId)}/cancel`, reason === undefined || reason === '' ? {} : { reason }),
      reschedule: (bookingId: string, startAt: string) => post<Booking>(`/bookings/${id(bookingId)}/reschedule`, { start_at: startAt }),
    },
    crm: {
      customFields: () => get<{ data: CustomField[] }>('/customFields/contact'),
    },
  };
}

export type BookingClient = ReturnType<typeof bookingClient>;
