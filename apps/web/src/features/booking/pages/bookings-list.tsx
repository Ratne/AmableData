import type { Booking, BookingStatus } from '@amable/api-types';
import { DashboardFilterMenu, ListTable, PageBody, PageToolbar, type ListTableColumn, type ListTableRowAction } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Ban } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { bookingKeys, useBooking, useBookingDates, useBookingMutation, useEventTypes, usePermissions, useReferences } from '../api/hooks';
import { ErrorNotice, Field, Pill, useBookingChrome } from '../components/common';

type When = 'upcoming' | 'past' | 'all';
type StatusFilter = 'all' | BookingStatus;

export function BookingsListPage() {
  const { t } = useI18n();
  const { slug, api } = useBooking();
  const { can } = usePermissions();
  const { dateTime } = useBookingDates();
  const { members } = useReferences();
  const eventTypes = useEventTypes();
  useBookingChrome('bookings');
  const [when, setWhen] = useState<When>('upcoming');
  const [status, setStatus] = useState<StatusFilter>('confirmed');
  const [eventType, setEventType] = useState('all');
  const [cancelling, setCancelling] = useState<Booking | null>(null);
  const [now] = useState(() => new Date().toISOString());
  const filterKey = JSON.stringify([when, status, eventType]);

  const bookings = useQuery({
    queryKey: bookingKeys.bookings(slug, filterKey),
    queryFn: async () =>
      (
        await api.bookings.list({
          ...(status === 'all' ? {} : { status }),
          ...(eventType === 'all' ? {} : { event_type_id: eventType }),
          ...(when === 'upcoming' ? { from: now, order: 'asc' as const } : when === 'past' ? { to: now } : {}),
        })
      ).data,
  });
  const hostName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const manage = can('booking:manage_bookings');

  const columns: ListTableColumn<Booking>[] = [
    {
      id: 'start',
      header: t('booking.field.when'),
      cell: (b) => <span className="font-medium whitespace-nowrap">{dateTime(b.starts_at)}</span>,
      sortable: true,
      sortValue: (b) => b.starts_at,
    },
    {
      id: 'event',
      header: t('booking.field.eventType'),
      cell: (b) => <span className="truncate">{b.event_type_title ?? '—'}</span>,
      sortable: true,
      sortValue: (b) => (b.event_type_title ?? '').toLowerCase(),
    },
    {
      id: 'invitee',
      header: t('booking.field.invitee'),
      cell: (b) =>
        b.contact_id === null ? (
          b.invitee_name
        ) : (
          <Link
            to="/t/$tenant/contacts/$contactId"
            params={{ tenant: slug, contactId: b.contact_id }}
            className="truncate text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {b.invitee_name || b.invitee_email}
          </Link>
        ),
    },
    { id: 'email', header: t('booking.field.email'), cell: (b) => b.invitee_email, hideBelow: 'lg' },
    {
      id: 'host',
      header: t('booking.field.host'),
      cell: (b) => (b.host_user_id === null ? '—' : (hostName.get(b.host_user_id) ?? b.host_user_id)),
      hideBelow: 'md',
    },
    {
      id: 'status',
      header: t('booking.field.status'),
      cell: (b) => (
        <Pill tone={b.status === 'confirmed' ? 'success' : 'neutral'}>
          {t(`booking.status.${b.status}`)}
          {b.reschedule_count > 0 && b.status === 'confirmed' ? ` · ${t('booking.list.rescheduled')}` : ''}
        </Pill>
      ),
    },
    { id: 'zone', header: t('booking.field.inviteeTimeZone'), cell: (b) => b.time_zone, hideBelow: 'xl' },
  ];

  const rowActions = (booking: Booking): ListTableRowAction<Booking>[] =>
    manage && booking.status === 'confirmed'
      ? [{ id: 'cancel', label: t('booking.action.cancelBooking'), icon: Ban, onSelect: () => setCancelling(booking) }]
      : [];

  return (
    <>
      <PageToolbar
        filters={
          <>
            <DashboardFilterMenu
              label={t('booking.filter.when')}
              value={when}
              onValueChange={(value) => setWhen(value as When)}
              options={(['upcoming', 'past', 'all'] as const).map((value) => ({ value, label: t(`booking.filter.${value}`) }))}
            />
            <DashboardFilterMenu
              label={t('booking.field.status')}
              value={status}
              onValueChange={(value) => setStatus(value as StatusFilter)}
              options={[
                { value: 'all', label: t('booking.filter.allStatuses') },
                { value: 'confirmed', label: t('booking.status.confirmed') },
                { value: 'cancelled', label: t('booking.status.cancelled') },
              ]}
            />
            <DashboardFilterMenu
              label={t('booking.field.eventType')}
              value={eventType}
              onValueChange={setEventType}
              options={[
                { value: 'all', label: t('booking.filter.allEventTypes') },
                ...(eventTypes.data ?? []).map((e) => ({ value: e.id, label: e.title })),
              ]}
            />
          </>
        }
      />
      {bookings.error ? (
        <PageBody>
          <ErrorNotice error={bookings.error} />
        </PageBody>
      ) : (
        <ListTable<Booking>
          className="px-4"
          rows={bookings.data ?? []}
          getRowId={(b) => b.id}
          getRowLabel={(b) => `${b.invitee_name} · ${dateTime(b.starts_at)}`}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'start', direction: when === 'past' ? 'desc' : 'asc' }}
          loading={bookings.isPending}
          rowActions={rowActions}
          emptyState={<p className="py-10 text-center text-sm text-muted-foreground">{t('booking.list.empty')}</p>}
        />
      )}
      {cancelling !== null ? <CancelDialog booking={cancelling} onClose={() => setCancelling(null)} /> : null}
    </>
  );
}

function CancelDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useBooking();
  const { dateTime } = useBookingDates();
  const [reason, setReason] = useState('');
  const cancel = useBookingMutation({
    mutationFn: () => api.bookings.cancel(booking.id, reason.trim()),
    success: t('booking.list.cancelled'),
    onSuccess: onClose,
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('booking.action.cancelBooking')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {booking.invitee_name} · {dateTime(booking.starts_at)}
        </p>
        <Field label={t('booking.field.cancelReason')} hint={t('booking.list.cancelHint')}>
          {(id) => <Textarea id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={cancel.isPending} onClick={() => cancel.mutate(undefined)}>
            {t('booking.action.confirmCancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
