import type { BookingCalendar, BookingDateOverride, BookingWeeklyRule } from '@amable/api-types';
import { DashboardButton, ListTable, PageBody, PageToolbar, type ListTableColumn, type ListTableRowAction } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarCog, Link2, Link2Off, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import { bookingKeys, useBooking, useBookingMutation, useCalendars, usePermissions, useReferences } from '../api/hooks';
import { browserTimeZone, Choice, ErrorNotice, Field, Pill, SectionCard, useBookingChrome, useTimeZones } from '../components/common';
import { OverridesEditor, WeeklyHoursEditor } from '../components/hours';

type Editing = { mode: 'create' } | { mode: 'edit'; calendar: BookingCalendar };

/** Finishes a Google connection when the OAuth redirect lands back here (`?calendar=&state=&code=`). */
function useGoogleCallback(): void {
  const { t } = useI18n();
  const { api } = useBooking();
  const handled = useRef(false);
  const finish = useBookingMutation({
    mutationFn: (input: { calendarId: string; state: string; code: string }) =>
      api.calendars.googleFinish(input.calendarId, { state: input.state, code: input.code }),
    success: t('booking.google.connected'),
  });
  useEffect(() => {
    if (handled.current) return;
    const params = new URLSearchParams(window.location.search);
    const calendarId = params.get('calendar');
    const state = params.get('state');
    const code = params.get('code');
    if (calendarId === null || state === null || code === null) return;
    handled.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    finish.mutate({ calendarId, state, code });
  }, [finish]);
}

export function CalendarsPage() {
  const { t } = useI18n();
  const { slug, api } = useBooking();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const calendars = useCalendars();
  const { members } = useReferences();
  useBookingChrome('calendars');
  useGoogleCallback();
  const [editing, setEditing] = useState<Editing | null>(null);
  const writable = can('booking:write');
  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  const sync = useBookingMutation({
    mutationFn: (id: string) => api.calendars.sync(id),
    success: (result) => t(`booking.google.sync.${result.status}`),
  });
  const connect = useBookingMutation({
    mutationFn: (id: string) => api.calendars.googleConnect(id),
    invalidate: [],
    onSuccess: (result) => window.location.assign(result.authorize_url),
  });
  const disconnect = useBookingMutation({
    mutationFn: (id: string) => api.calendars.googleDisconnect(id),
    success: t('booking.google.disconnected'),
  });

  const columns: ListTableColumn<BookingCalendar>[] = [
    { id: 'name', header: t('booking.field.name'), cell: (c) => <span className="font-medium">{c.name}</span>, sortable: true, sortValue: (c) => c.name.toLowerCase() },
    { id: 'host', header: t('booking.field.host'), cell: (c) => memberName.get(c.host_user_id) ?? c.host_user_id },
    { id: 'zone', header: t('booking.field.timeZone'), cell: (c) => c.time_zone, hideBelow: 'md' },
    {
      id: 'google',
      header: t('booking.field.google'),
      cell: (c) =>
        c.google.connected ? <Pill tone="success">{c.google.account_email ?? t('booking.google.connectedShort')}</Pill> : <Pill tone="neutral">{t('booking.google.notConnected')}</Pill>,
      hideBelow: 'lg',
    },
  ];

  const rowActions = (calendar: BookingCalendar): ListTableRowAction<BookingCalendar>[] => {
    if (!writable) return [];
    return [
      { id: 'edit', label: t('booking.action.editCalendar'), icon: CalendarCog, onSelect: () => setEditing({ mode: 'edit', calendar }) },
      calendar.google.connected
        ? { id: 'disconnect', label: t('booking.google.disconnect'), icon: Link2Off, separatorBefore: true, onSelect: () => disconnect.mutate(calendar.id) }
        : { id: 'connect', label: t('booking.google.connect'), icon: Link2, separatorBefore: true, onSelect: () => connect.mutate(calendar.id) },
      { id: 'sync', label: t('booking.google.syncNow'), icon: RefreshCw, onSelect: () => sync.mutate(calendar.id) },
    ];
  };

  return (
    <>
      <PageToolbar
        actions={
          writable ? (
            <DashboardButton variant="primary" onClick={() => setEditing({ mode: 'create' })}>
              <Plus aria-hidden /> {t('booking.calendars.new')}
            </DashboardButton>
          ) : null
        }
      />
      {calendars.error ? (
        <PageBody>
          <ErrorNotice error={calendars.error} />
        </PageBody>
      ) : (
        <ListTable<BookingCalendar>
          className="px-4"
          rows={calendars.data ?? []}
          getRowId={(c) => c.id}
          getRowLabel={(c) => c.name}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'name', direction: 'asc' }}
          loading={calendars.isPending}
          selectable={writable}
          onRowOpen={writable ? (calendar) => setEditing({ mode: 'edit', calendar }) : undefined}
          rowActions={rowActions}
          deletion={
            writable
              ? {
                  onDelete: async (rows) => {
                    await Promise.all(rows.map((c) => api.calendars.remove(c.id)));
                    await queryClient.invalidateQueries({ queryKey: bookingKeys.root(slug) });
                  },
                  confirm: true,
                }
              : undefined
          }
          emptyState={<p className="py-10 text-center text-sm text-muted-foreground">{t('booking.calendars.empty')}</p>}
        />
      )}
      {editing !== null ? <CalendarDialog editing={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function CalendarDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useBooking();
  const { members } = useReferences();
  const current = editing.mode === 'edit' ? editing.calendar : null;
  const [name, setName] = useState(current?.name ?? '');
  const [host, setHost] = useState<string | null>(current?.host_user_id ?? null);
  const [timeZone, setTimeZone] = useState(current?.time_zone ?? browserTimeZone());
  const [rules, setRules] = useState<BookingWeeklyRule[]>(
    current?.weekly_rules ?? [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  );
  const [overrides, setOverrides] = useState<BookingDateOverride[]>(current?.date_overrides ?? []);
  const zones = useTimeZones(timeZone);

  const save = useBookingMutation({
    mutationFn: async () => {
      const data = { name: name.trim(), host_user_id: host ?? '', time_zone: timeZone, weekly_rules: rules, date_overrides: overrides };
      return current === null ? api.calendars.create(data) : api.calendars.update(current.id, data);
    },
    success: t('booking.calendars.saved'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '' && host !== null) save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{current === null ? t('booking.calendars.new') : current.name}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('booking.field.name')}>
              {(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label={t('booking.field.host')} hint={t('booking.calendars.hostHint')}>
              {(id) => <Choice id={id} value={host} onChange={setHost} noneLabel={t('booking.calendars.pickHost')} options={members.map((m) => ({ value: m.id, label: m.name }))} />}
            </Field>
            <Field label={t('booking.field.timeZone')}>
              {(id) => <Choice id={id} value={timeZone} onChange={(z) => setTimeZone(z ?? 'UTC')} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, ' ') }))} />}
            </Field>
          </div>
          <SectionCard title={t('booking.calendars.weeklyHours')}>
            <WeeklyHoursEditor rules={rules} onChange={setRules} />
          </SectionCard>
          <SectionCard title={t('booking.calendars.overrides')}>
            <OverridesEditor overrides={overrides} onChange={setOverrides} />
          </SectionCard>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={name.trim() === '' || host === null || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
