import type { Permission } from '@amable/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import {
  apiErrorMessage,
  type ApiMutationOptions,
  REFERENCE_STALE_MS,
  useApiMutation,
  useGrantedPermissions,
} from '../../../lib/feature-hooks';
import { tenantRoute } from '../../../routes/tenant';
import { bookingClient, type BookingClient } from './client';

/** Every booking query of a tenant lives under ['booking', slug, …]. */
export const bookingKeys = {
  root: (slug: string) => ['booking', slug] as const,
  me: (slug: string) => ['booking', slug, 'me'] as const,
  calendars: (slug: string) => ['booking', slug, 'calendars'] as const,
  calendarSync: (slug: string, calendarId: string) =>
    ['booking', slug, 'calendars', calendarId, 'sync'] as const,
  eventTypes: (slug: string) => ['booking', slug, 'eventTypes'] as const,
  eventType: (slug: string, id: string) => ['booking', slug, 'eventType', id] as const,
  embed: (slug: string, id: string) => ['booking', slug, 'eventType', id, 'embed'] as const,
  preview: (slug: string, id: string, from: string) =>
    ['booking', slug, 'eventType', id, 'preview', from] as const,
  bookings: (slug: string, filter: string) => ['booking', slug, 'bookings', filter] as const,
  ref: (slug: string, what: string) => ['booking', slug, 'ref', what] as const,
};

export function useBooking(): { slug: string; api: BookingClient } {
  const slug = useParams({ from: tenantRoute.id }).tenant;
  const api = useMemo(() => bookingClient(slug), [slug]);
  return { slug, api };
}

/** Permissions of the active membership; actions stay hidden until known (the server enforces them). */
export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const { slug, api } = useBooking();
  const me = useQuery({
    queryKey: bookingKeys.me(slug),
    queryFn: () => api.me(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
  return useGrantedPermissions(me.data);
}

export function useCalendars() {
  const { slug, api } = useBooking();
  return useQuery({
    queryKey: bookingKeys.calendars(slug),
    queryFn: async () => (await api.calendars.list()).data,
  });
}

export function useEventTypes() {
  const { slug, api } = useBooking();
  return useQuery({
    queryKey: bookingKeys.eventTypes(slug),
    queryFn: async () => (await api.eventTypes.list()).data,
  });
}

/** Tenant members (calendar hosts) and contact custom fields (tags: `TagPicker`). */
export function useReferences() {
  const { slug, api } = useBooking();
  const members = useQuery({
    queryKey: bookingKeys.ref(slug, 'members'),
    queryFn: async () => (await api.directory()).members,
    staleTime: REFERENCE_STALE_MS,
  });
  const customFields = useQuery({
    queryKey: bookingKeys.ref(slug, 'customFields'),
    queryFn: async () => (await api.crm.customFields()).data,
    staleTime: REFERENCE_STALE_MS,
  });
  return { members: members.data ?? [], customFields: customFields.data ?? [] };
}

/** Booking times in the browser's time zone, with the zone name when it differs from the invitee's. */
export function useBookingDates() {
  const { locale } = useI18n();
  return useMemo(() => {
    const full = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
    const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
    const day = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    const parse = (iso: string | null | undefined): number | null => {
      if (!iso) return null;
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? null : ms;
    };
    return {
      dateTime: (iso: string | null | undefined) => {
        const ms = parse(iso);
        return ms === null ? '—' : full.format(ms);
      },
      time: (iso: string) => {
        const ms = parse(iso);
        return ms === null ? '—' : time.format(ms);
      },
      day: (iso: string) => {
        const ms = parse(iso);
        return ms === null ? '—' : day.format(ms);
      },
    };
  }, [locale]);
}

type Translate = ReturnType<typeof useI18n>['t'];

export function errorMessage(t: Translate, error: unknown): string {
  return apiErrorMessage(t, error, {
    forbidden: 'booking.error.forbidden',
    notFound: 'booking.error.notFound',
    conflict: 'booking.error.conflict',
    validation: 'booking.error.validation',
  });
}

export type BookingMutationOptions<TInput, TResult> = ApiMutationOptions<TInput, TResult>;

/** `useMutation` with cache invalidation and toasts. */
export function useBookingMutation<TInput, TResult>(
  options: BookingMutationOptions<TInput, TResult>,
) {
  const { slug } = useBooking();
  return useApiMutation(options, bookingKeys.root(slug), errorMessage);
}
