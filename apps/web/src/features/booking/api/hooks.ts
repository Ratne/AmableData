import type { Permission } from '@amable/core';
import { toast } from '@amable/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { tenantRoute } from '../../../routes/tenant';
import { BookingApiError, bookingClient, type BookingClient } from './client';

/** Every booking query of a tenant lives under ['booking', slug, …]. */
export const bookingKeys = {
  root: (slug: string) => ['booking', slug] as const,
  me: (slug: string) => ['booking', slug, 'me'] as const,
  calendars: (slug: string) => ['booking', slug, 'calendars'] as const,
  calendarSync: (slug: string, calendarId: string) => ['booking', slug, 'calendars', calendarId, 'sync'] as const,
  eventTypes: (slug: string) => ['booking', slug, 'eventTypes'] as const,
  eventType: (slug: string, id: string) => ['booking', slug, 'eventType', id] as const,
  embed: (slug: string, id: string) => ['booking', slug, 'eventType', id, 'embed'] as const,
  preview: (slug: string, id: string, from: string) => ['booking', slug, 'eventType', id, 'preview', from] as const,
  bookings: (slug: string, filter: string) => ['booking', slug, 'bookings', filter] as const,
  ref: (slug: string, what: string) => ['booking', slug, 'ref', what] as const,
};

export function useBooking(): { slug: string; api: BookingClient } {
  const slug = useParams({ from: tenantRoute.id }).tenant;
  const api = useMemo(() => bookingClient(slug), [slug]);
  return { slug, api };
}

const REFERENCE_STALE_MS = 60_000;

/** Permissions of the active membership; actions stay hidden until known (the server enforces them). */
export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const { slug, api } = useBooking();
  const me = useQuery({ queryKey: bookingKeys.me(slug), queryFn: () => api.me(), staleTime: REFERENCE_STALE_MS, retry: false });
  const granted = useMemo(() => new Set(me.data?.permissions ?? []), [me.data]);
  const can = useCallback((permission: Permission) => granted.has(permission), [granted]);
  return { can, ready: me.data !== undefined };
}

export function useCalendars() {
  const { slug, api } = useBooking();
  return useQuery({ queryKey: bookingKeys.calendars(slug), queryFn: async () => (await api.calendars.list()).data });
}

export function useEventTypes() {
  const { slug, api } = useBooking();
  return useQuery({ queryKey: bookingKeys.eventTypes(slug), queryFn: async () => (await api.eventTypes.list()).data });
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
    const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
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
  if (error instanceof BookingApiError) {
    if (error.status === 403) return t('booking.error.forbidden');
    if (error.status === 404) return t('booking.error.notFound');
    if (error.status === 409) return error.detail ?? t('booking.error.conflict');
    if (error.status === 422 || error.status === 400) {
      const first = error.details[0];
      if (first !== undefined) return first.path ? `${first.path}: ${first.message}` : first.message;
      return error.detail ?? t('booking.error.validation');
    }
  }
  return t('common.error');
}

export interface BookingMutationOptions<TInput, TResult> {
  readonly mutationFn: (input: TInput) => Promise<TResult>;
  /** Default: the whole tenant booking cache. */
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((result: TResult) => string);
  readonly onSuccess?: (result: TResult, input: TInput) => void;
}

/** `useMutation` with cache invalidation and toasts. */
export function useBookingMutation<TInput, TResult>(options: BookingMutationOptions<TInput, TResult>) {
  const { slug } = useBooking();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, input) => {
      const keys = options.invalidate ?? [bookingKeys.root(slug)];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success !== undefined) {
        toast.success(typeof options.success === 'function' ? options.success(result) : options.success);
      }
      options.onSuccess?.(result, input);
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });
}
