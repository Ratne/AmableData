import { BOOKING_LOCALES, type BookingEventType, type UpdateBookingEventTypeInput } from '@amable/api-types';
import { PageBody, PageToolbar, DashboardButton } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Copy, ExternalLink, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from '@amable/ui';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { bookingKeys, useBooking, useBookingMutation, useCalendars, usePermissions, useReferences } from '../api/hooks';
import { Choice, Field, PageState, SectionCard, useBookingChrome } from '../components/common';
import { QuestionsEditor } from '../components/questions';
import { TagPicker } from '../../crm/components/tag-picker';

const num = (value: string, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

export function EventTypeEditorPage() {
  const { eventTypeId } = useParams({ strict: false }) as { eventTypeId: string };
  const { slug, api } = useBooking();
  const { t } = useI18n();
  const query = useQuery({ queryKey: bookingKeys.eventType(slug, eventTypeId), queryFn: () => api.eventTypes.get(eventTypeId) });
  useBookingChrome('eventTypes', query.data?.title ?? t('booking.tab.eventTypes'));
  return (
    <PageState isPending={query.isPending} error={query.error}>
      {() => (query.data === undefined ? null : <Editor key={query.data.updated_at} initial={query.data} />)}
    </PageState>
  );
}

function Editor({ initial }: { initial: BookingEventType }) {
  const { t } = useI18n();
  const { api } = useBooking();
  const { can } = usePermissions();
  const calendars = useCalendars();
  const { customFields } = useReferences();
  const [draft, setDraft] = useState(initial);
  const [reminder, setReminder] = useState('60');
  const writable = can('booking:write');
  const set = <K extends keyof BookingEventType>(key: K, value: BookingEventType[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const save = useBookingMutation({
    mutationFn: () => {
      const { id: _id, created_at: _c, updated_at: _u, ...data } = draft;
      return api.eventTypes.update(initial.id, data satisfies UpdateBookingEventTypeInput);
    },
    success: t('booking.eventTypes.saved'),
  });

  const disabled = !writable;
  return (
    <>
      <PageToolbar
        actions={
          writable ? (
            <DashboardButton variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(undefined)}>
              <Save aria-hidden /> {t('common.save')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid gap-4 pb-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <fieldset disabled={disabled} className="grid content-start gap-4">
          <SectionCard title={t('booking.editor.basics')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('booking.field.title')}>{(id) => <Input id={id} value={draft.title} maxLength={200} onChange={(e) => set('title', e.target.value)} />}</Field>
              <Field label={t('booking.field.slug')} hint={t('booking.eventTypes.slugHint')}>
                {(id) => <Input id={id} value={draft.slug} maxLength={80} onChange={(e) => set('slug', e.target.value.toLowerCase())} />}
              </Field>
              <Field label={t('booking.field.description')} className="sm:col-span-2">
                {(id) => <Textarea id={id} value={draft.description} maxLength={5000} onChange={(e) => set('description', e.target.value)} />}
              </Field>
              <Field label={t('booking.field.location')} hint={t('booking.editor.locationHint')}>
                {(id) => <Input id={id} value={draft.location} maxLength={500} onChange={(e) => set('location', e.target.value)} />}
              </Field>
              <Field label={t('booking.field.color')}>{(id) => <Input id={id} type="color" className="h-9 w-20 p-1" value={draft.color} onChange={(e) => set('color', e.target.value)} />}</Field>
              <Field label={t('booking.field.locale')}>
                {(id) => (
                  <Choice id={id} value={draft.locale} onChange={(v) => set('locale', (v ?? 'auto') as BookingEventType['locale'])} options={BOOKING_LOCALES.map((l) => ({ value: l, label: t(`booking.locale.${l}`) }))} />
                )}
              </Field>
              <label className="flex items-center gap-2 self-end text-sm">
                <Switch checked={draft.active} onCheckedChange={(v) => set('active', v)} />
                {t('booking.editor.active')}
              </label>
            </div>
          </SectionCard>

          <SectionCard title={t('booking.editor.scheduling')}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('booking.field.durationMinutes')}>
                {(id) => <Input id={id} type="number" min={5} max={720} step={5} value={draft.duration_minutes} onChange={(e) => set('duration_minutes', num(e.target.value, 30))} />}
              </Field>
              <Field label={t('booking.field.interval')} hint={t('booking.editor.intervalHint')}>
                {(id) => (
                  <Input id={id} type="number" min={5} max={720} step={5} value={draft.slot_interval_minutes ?? ''} onChange={(e) => set('slot_interval_minutes', e.target.value === '' ? null : num(e.target.value, 30))} />
                )}
              </Field>
              <Field label={t('booking.field.dailyCap')} hint={t('booking.editor.dailyCapHint')}>
                {(id) => <Input id={id} type="number" min={1} max={100} value={draft.max_per_day ?? ''} onChange={(e) => set('max_per_day', e.target.value === '' ? null : num(e.target.value, 1))} />}
              </Field>
              <Field label={t('booking.field.bufferBefore')}>
                {(id) => <Input id={id} type="number" min={0} max={240} step={5} value={draft.buffer_before_minutes} onChange={(e) => set('buffer_before_minutes', num(e.target.value, 0))} />}
              </Field>
              <Field label={t('booking.field.bufferAfter')}>
                {(id) => <Input id={id} type="number" min={0} max={240} step={5} value={draft.buffer_after_minutes} onChange={(e) => set('buffer_after_minutes', num(e.target.value, 0))} />}
              </Field>
              <Field label={t('booking.field.minNotice')} hint={t('booking.editor.minutesHint')}>
                {(id) => <Input id={id} type="number" min={0} max={43200} step={15} value={draft.min_notice_minutes} onChange={(e) => set('min_notice_minutes', num(e.target.value, 0))} />}
              </Field>
              <Field label={t('booking.field.maxDaysAhead')}>
                {(id) => <Input id={id} type="number" min={1} max={365} value={draft.max_days_ahead} onChange={(e) => set('max_days_ahead', num(e.target.value, 60))} />}
              </Field>
            </div>
          </SectionCard>

          <SectionCard title={t('booking.field.hosts')}>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                {(calendars.data ?? []).map((calendar) => (
                  <label key={calendar.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.host_calendar_ids.includes(calendar.id)}
                      onCheckedChange={(checked) =>
                        set('host_calendar_ids', checked === true ? [...draft.host_calendar_ids, calendar.id] : draft.host_calendar_ids.filter((id) => id !== calendar.id))
                      }
                    />
                    {calendar.name} <span className="text-muted-foreground">· {calendar.time_zone}</span>
                  </label>
                ))}
              </div>
              {draft.host_calendar_ids.length > 1 ? (
                <Field label={t('booking.field.assignment')} hint={t(`booking.assignment.${draft.assignment}Hint`)}>
                  {(id) => (
                    <Choice
                      id={id}
                      value={draft.assignment}
                      onChange={(v) => set('assignment', (v ?? 'round_robin') as BookingEventType['assignment'])}
                      options={(['round_robin', 'collective'] as const).map((a) => ({ value: a, label: t(`booking.assignment.${a}`) }))}
                    />
                  )}
                </Field>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard title={t('booking.editor.form')}>
            <div className="grid gap-4">
              <Field label={t('booking.field.phone')}>
                {(id) => (
                  <Choice id={id} value={draft.phone} onChange={(v) => set('phone', (v ?? 'optional') as BookingEventType['phone'])} options={(['hidden', 'optional', 'required'] as const).map((m) => ({ value: m, label: t(`booking.phone.${m}`) }))} />
                )}
              </Field>
              <QuestionsEditor questions={draft.questions} onChange={(questions) => set('questions', questions)} customFields={customFields} />
            </div>
          </SectionCard>

          <SectionCard title={t('booking.editor.crm')}>
            <p className="mb-2 text-xs text-muted-foreground">{t('booking.editor.tagsHint')}</p>
            <TagPicker
              value={draft.tag_ids}
              onChange={(tagIds) => set('tag_ids', tagIds)}
              ariaLabel={t('booking.editor.crm')}
              className="w-full"
            />
          </SectionCard>

          <SectionCard title={t('booking.editor.notifications')}>
            <div className="grid gap-4">
              <div className="grid gap-2">
                <span className="text-sm font-medium">{t('booking.editor.reminders')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  {draft.reminder_minutes.map((minutes) => (
                    <span key={minutes} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm">
                      {t('booking.editor.reminderBefore', { count: minutes })}
                      <button type="button" aria-label={t('booking.editor.removeReminder')} onClick={() => set('reminder_minutes', draft.reminder_minutes.filter((m) => m !== minutes))}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </span>
                  ))}
                  <Input type="number" min={5} max={20160} step={5} className="w-28" aria-label={t('booking.editor.reminderMinutes')} value={reminder} onChange={(e) => setReminder(e.target.value)} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={draft.reminder_minutes.length >= 5 || draft.reminder_minutes.includes(num(reminder, 0)) || num(reminder, 0) < 5}
                    onClick={() => set('reminder_minutes', [...draft.reminder_minutes, num(reminder, 60)].sort((a, b) => b - a))}
                  >
                    <Plus aria-hidden /> {t('booking.editor.addReminder')}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('booking.editor.messagesHint')}</p>
              {(['confirmation', 'reminder'] as const).map((kind) => (
                <div key={kind} className="grid gap-2">
                  <Field label={t(`booking.editor.${kind}Subject`)}>
                    {(id) => <Input id={id} value={draft.messages[`${kind}_subject`]} maxLength={300} placeholder={t('booking.editor.defaultText')} onChange={(e) => set('messages', { ...draft.messages, [`${kind}_subject`]: e.target.value })} />}
                  </Field>
                  <Field label={t(`booking.editor.${kind}Body`)}>
                    {(id) => <Textarea id={id} rows={5} value={draft.messages[`${kind}_body`]} placeholder={t('booking.editor.defaultText')} onChange={(e) => set('messages', { ...draft.messages, [`${kind}_body`]: e.target.value })} />}
                  </Field>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title={t('booking.editor.afterBooking')}>
            <div className="grid gap-3">
              <Field label={t('booking.field.successMessage')}>{(id) => <Textarea id={id} value={draft.success_message} maxLength={2000} onChange={(e) => set('success_message', e.target.value)} />}</Field>
              <Field label={t('booking.field.redirectUrl')} hint={t('booking.editor.redirectHint')}>
                {(id) => <Input id={id} type="url" value={draft.redirect_url} maxLength={2048} placeholder="https://" onChange={(e) => set('redirect_url', e.target.value)} />}
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={draft.turnstile_enabled} onCheckedChange={(v) => set('turnstile_enabled', v)} />
                {t('booking.editor.turnstile')}
              </label>
            </div>
          </SectionCard>
        </fieldset>
        <div className="grid content-start gap-4">
          <EmbedCard eventTypeId={initial.id} />
          <PreviewCard eventTypeId={initial.id} dirty={dirty} />
        </div>
      </PageBody>
    </>
  );
}

function EmbedCard({ eventTypeId }: { eventTypeId: string }) {
  const { t } = useI18n();
  const { slug, api } = useBooking();
  const embed = useQuery({ queryKey: bookingKeys.embed(slug, eventTypeId), queryFn: () => api.eventTypes.embed(eventTypeId) });
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success(t('booking.embed.copied')),
      () => toast.error(t('common.error')),
    );
  return (
    <SectionCard title={t('booking.embed.title')}>
      {embed.data === undefined ? null : (
        <div className="grid gap-3">
          <Field label={t('booking.embed.hostedLink')}>
            {(id) => (
              <div className="flex gap-1.5">
                <Input id={id} readOnly value={embed.data.hosted_url} />
                <Button type="button" size="icon" variant="outline" aria-label={t('booking.embed.copy')} onClick={() => copy(embed.data.hosted_url)}>
                  <Copy aria-hidden />
                </Button>
                <Button type="button" size="icon" variant="outline" aria-label={t('booking.embed.open')} onClick={() => window.open(embed.data.hosted_url, '_blank', 'noopener')}>
                  <ExternalLink aria-hidden />
                </Button>
              </div>
            )}
          </Field>
          <Field label={t('booking.embed.snippet')} hint={t('booking.embed.snippetHint')}>
            {(id) => <Textarea id={id} readOnly rows={4} className="font-mono text-xs" value={embed.data.snippet} />}
          </Field>
          <Button type="button" variant="outline" className="w-fit" onClick={() => copy(embed.data.snippet)}>
            <Copy aria-hidden /> {t('booking.embed.copySnippet')}
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function PreviewCard({ eventTypeId, dirty }: { eventTypeId: string; dirty: boolean }) {
  const { t, locale } = useI18n();
  const { slug, api } = useBooking();
  const [offset, setOffset] = useState(0);
  const from = isoDate(Date.now() + offset * 7 * 86_400_000);
  const to = isoDate(Date.now() + (offset * 7 + 6) * 86_400_000);
  const preview = useQuery({
    queryKey: bookingKeys.preview(slug, eventTypeId, from),
    queryFn: () => api.eventTypes.availability(eventTypeId, from, to, Intl.DateTimeFormat().resolvedOptions().timeZone),
  });
  useEffect(() => {
    if (!dirty) void preview.refetch();
  }, [dirty]);
  const days = useMemo(() => {
    const dayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
    const timeFormat = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
    const map = new Map<string, string[]>();
    for (const slot of preview.data?.slots ?? []) {
      const ms = Date.parse(slot.start);
      const key = dayFormat.format(ms);
      map.set(key, [...(map.get(key) ?? []), timeFormat.format(ms)]);
    }
    return [...map.entries()];
  }, [preview.data, locale]);
  return (
    <SectionCard
      title={t('booking.preview.title')}
      actions={
        <>
          <Button type="button" size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(offset - 1)}>
            ‹
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOffset(offset + 1)}>
            ›
          </Button>
        </>
      }
    >
      {dirty ? <p className="mb-2 text-xs text-amber-600">{t('booking.preview.unsaved')}</p> : null}
      {preview.isPending ? <p className="text-sm text-muted-foreground">{t('booking.preview.loading')}</p> : null}
      {!preview.isPending && days.length === 0 ? <p className="text-sm text-muted-foreground">{t('booking.preview.empty')}</p> : null}
      <div className="grid gap-2">
        {days.map(([day, times]) => (
          <div key={day} className="text-sm">
            <div className="font-medium capitalize">{day}</div>
            <div className="text-muted-foreground">{times.join(' · ')}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
