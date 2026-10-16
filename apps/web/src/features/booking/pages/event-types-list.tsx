import type { BookingEventType } from '@amable/api-types';
import { DashboardButton, ListTable, PageBody, PageToolbar, type ListTableColumn, type ListTableRowAction } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Pencil, Plus } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { bookingKeys, useBooking, useBookingMutation, useCalendars, useEventTypes, usePermissions } from '../api/hooks';
import { Choice, ErrorNotice, Field, Pill, useBookingChrome } from '../components/common';

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function EventTypesListPage() {
  const { t } = useI18n();
  const { slug, api } = useBooking();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const eventTypes = useEventTypes();
  const calendars = useCalendars();
  useBookingChrome('eventTypes');
  const [creating, setCreating] = useState(false);
  const writable = can('booking:write');
  const calendarName = useMemo(() => new Map((calendars.data ?? []).map((c) => [c.id, c.name])), [calendars.data]);
  const open = (eventType: BookingEventType) =>
    void navigate({ to: '/t/$tenant/bookings/event-types/$eventTypeId', params: { tenant: slug, eventTypeId: eventType.id } });

  const columns: ListTableColumn<BookingEventType>[] = [
    {
      id: 'title',
      header: t('booking.field.title'),
      cell: (e) => (
        <span className="flex items-center gap-2 truncate font-medium">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: e.color }} aria-hidden />
          {e.title}
        </span>
      ),
      sortable: true,
      sortValue: (e) => e.title.toLowerCase(),
    },
    { id: 'slug', header: t('booking.field.slug'), cell: (e) => <code className="text-xs">{e.slug}</code>, hideBelow: 'md' },
    { id: 'duration', header: t('booking.field.duration'), cell: (e) => t('booking.common.minutes', { count: e.duration_minutes }), align: 'right' },
    {
      id: 'hosts',
      header: t('booking.field.hosts'),
      cell: (e) => e.host_calendar_ids.map((id) => calendarName.get(id) ?? id).join(', '),
      hideBelow: 'lg',
    },
    {
      id: 'status',
      header: t('booking.field.status'),
      cell: (e) => <Pill tone={e.active ? 'success' : 'warning'}>{e.active ? t('booking.status.active') : t('booking.status.inactive')}</Pill>,
    },
  ];

  const rowActions = (eventType: BookingEventType): ListTableRowAction<BookingEventType>[] => [
    { id: 'edit', label: t('booking.action.edit'), icon: Pencil, onSelect: () => open(eventType) },
  ];

  return (
    <>
      <PageToolbar
        actions={
          writable ? (
            <DashboardButton variant="primary" onClick={() => setCreating(true)} disabled={(calendars.data ?? []).length === 0}>
              <Plus aria-hidden /> {t('booking.eventTypes.new')}
            </DashboardButton>
          ) : null
        }
      />
      {eventTypes.error ? (
        <PageBody>
          <ErrorNotice error={eventTypes.error} />
        </PageBody>
      ) : (
        <ListTable<BookingEventType>
          className="px-4"
          rows={eventTypes.data ?? []}
          getRowId={(e) => e.id}
          getRowLabel={(e) => e.title}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'title', direction: 'asc' }}
          loading={eventTypes.isPending}
          selectable={writable}
          onRowOpen={open}
          rowActions={rowActions}
          deletion={
            writable
              ? {
                  onDelete: async (rows) => {
                    await Promise.all(rows.map((e) => api.eventTypes.remove(e.id)));
                    await queryClient.invalidateQueries({ queryKey: bookingKeys.root(slug) });
                  },
                  confirm: true,
                }
              : undefined
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {(calendars.data ?? []).length === 0 ? t('booking.eventTypes.needCalendar') : t('booking.eventTypes.empty')}
            </p>
          }
        />
      )}
      {creating ? <CreateDialog onClose={() => setCreating(false)} onCreated={open} /> : null}
    </>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (eventType: BookingEventType) => void }) {
  const { t } = useI18n();
  const { api } = useBooking();
  const calendars = useCalendars();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [duration, setDuration] = useState('30');
  const [host, setHost] = useState<string | null>(calendars.data?.[0]?.id ?? null);
  const create = useBookingMutation({
    mutationFn: () =>
      api.eventTypes.create({ title: title.trim(), slug, duration_minutes: Number(duration), host_calendar_ids: host === null ? [] : [host] }),
    onSuccess: onCreated,
  });
  const valid = title.trim() !== '' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) && Number(duration) >= 5 && host !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('booking.eventTypes.new')}</DialogTitle>
          </DialogHeader>
          <Field label={t('booking.field.title')}>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={title}
                maxLength={200}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </Field>
          <Field label={t('booking.field.slug')} hint={t('booking.eventTypes.slugHint')}>
            {(id) => (
              <Input
                id={id}
                value={slug}
                maxLength={80}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('booking.field.durationMinutes')}>
              {(id) => <Input id={id} type="number" min={5} max={720} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} />}
            </Field>
            <Field label={t('booking.field.host')}>
              {(id) => <Choice id={id} value={host} onChange={setHost} options={(calendars.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {t('booking.eventTypes.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
