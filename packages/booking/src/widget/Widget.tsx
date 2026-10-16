import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { groupSlotsByDay } from '../availability';
import type { BookResult, ManageView, PublicBookingConfig, PublicQuestion } from '../public';
import type { BookingWidgetStrings } from '../strings';
import { compareDates, type LocalDate } from '../tz';
import type { BookingLocale, SlotRejection } from '../types';
import { SLOT_REJECTIONS } from '../types';
import { validateAnswers, validateInvitee, type AnswerError } from '../validate';
import type { ApiFailure, BookingApi } from './api';
import { collectMeta, collectTracking } from './capture';
import {
  addMonths,
  browserTimeZone,
  dateKey,
  formatDay,
  formatFull,
  formatMonth,
  formatTime,
  lastDayOfMonth,
  monthCells,
  monthStart,
  timeZones,
  todayIn,
} from './format';
import { mountTurnstile, type TurnstileHandle } from './turnstile';

interface Slot {
  start: number;
  end: number;
}

interface Common {
  api: BookingApi;
  strings: BookingWidgetStrings;
  locale: BookingLocale;
}

function minutesLabel(strings: BookingWidgetStrings, n: number): string {
  return strings.minutes.replace('{n}', String(n));
}

function failureText(strings: BookingWidgetStrings, failure: ApiFailure): string {
  if (failure.status === 0) return strings.networkError;
  if (failure.status === 429) return strings.rateLimited;
  if (failure.error === 'turnstile_failed') return strings.turnstileFailed;
  if (failure.status === 409) {
    const reason = failure.details[0]?.message;
    if (reason !== undefined && (SLOT_REJECTIONS as readonly string[]).includes(reason)) {
      return strings.rejections[reason as SlotRejection];
    }
    return strings.slotTaken;
  }
  if (failure.status === 422) return strings.fixErrors;
  return strings.genericError;
}

function Header({ config, strings, extra }: { config: PublicBookingConfig; strings: BookingWidgetStrings; extra?: string }) {
  return (
    <div class="ab-head">
      {config.host_names.length > 0 ? <p class="ab-host">{config.host_names.join(', ')}</p> : null}
      <h2 class="ab-title">{config.title}</h2>
      <div class="ab-meta">
        <span>⏱ {minutesLabel(strings, config.duration_minutes)}</span>
        {config.location !== '' ? <span>📍 {config.location}</span> : null}
        {extra !== undefined ? <span>📅 {extra}</span> : null}
      </div>
      {config.description !== '' ? <p class="ab-desc">{config.description}</p> : null}
    </div>
  );
}

/** Month calendar + times of the selected day, live-refreshed while open. */
function Picker({
  api,
  strings,
  locale,
  config,
  timeZone,
  onTimeZone,
  onPick,
  error,
}: Common & {
  config: PublicBookingConfig;
  timeZone: string;
  onTimeZone: (tz: string) => void;
  onPick: (slot: Slot) => void;
  error: string;
}) {
  const today = useMemo(() => todayIn(timeZone), [timeZone]);
  const [month, setMonth] = useState<LocalDate>(() => monthStart(today));
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const version = useRef(-1);
  const request = useRef(0);

  const load = () => {
    const id = (request.current += 1);
    const from = compareDates(month, monthStart(today)) <= 0 ? today : month;
    void api.slots(config.slug, dateKey(from), dateKey(lastDayOfMonth(month)), timeZone).then((result) => {
      if (id !== request.current) return;
      if (!result.ok) {
        setLoadError(failureText(strings, result.failure));
        setSlots([]);
        return;
      }
      setLoadError('');
      version.current = result.value.version;
      setSlots(result.value.slots.map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end) })));
    });
  };

  useEffect(load, [month, timeZone, config.slug]);
  useEffect(
    () =>
      api.watch(config.slug, (next) => {
        if (next !== version.current) load();
      }),
    [config.slug, month, timeZone],
  );

  const days = useMemo(() => new Map(groupSlotsByDay(slots ?? [], timeZone).map((d) => [d.date, d.slots])), [slots, timeZone]);
  useEffect(() => {
    if (selected !== null && !days.has(selected)) setSelected(null);
  }, [days]);
  const maxMonth = addMonths(monthStart(todayIn(timeZone)), Math.ceil(config.max_days_ahead / 28) + 1);
  const daySlots = selected === null ? [] : (days.get(selected) ?? []);
  const zones = useMemo(() => timeZones(timeZone), [timeZone]);

  return (
    <div class="ab-body">
      <p class="ab-step">{strings.pickDate}</p>
      {error !== '' ? <div class="ab-err" role="alert">{error}</div> : null}
      {loadError !== '' ? <div class="ab-err" role="alert">{loadError}</div> : null}
      <div class="ab-cols">
        <div>
          <div class="ab-cal-head">
            <button
              type="button"
              class="ab-nav"
              aria-label={strings.previousMonth}
              disabled={compareDates(month, monthStart(today)) <= 0}
              onClick={() => setMonth(addMonths(month, -1))}
            >
              ‹
            </button>
            <span class="ab-month">{formatMonth(month, locale)}</span>
            <button
              type="button"
              class="ab-nav"
              aria-label={strings.nextMonth}
              disabled={compareDates(month, maxMonth) >= 0}
              onClick={() => setMonth(addMonths(month, 1))}
            >
              ›
            </button>
          </div>
          <div class="ab-grid">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <div class="ab-dow" key={d}>
                {strings.weekdaysShort[d]}
              </div>
            ))}
            {monthCells(month).map((cell, i) => {
              if (cell === null) return <div key={`p${String(i)}`} />;
              const key = dateKey(cell);
              const avail = days.has(key);
              return (
                <button
                  type="button"
                  key={key}
                  class={`ab-day${avail ? ' avail' : ''}${selected === key ? ' sel' : ''}`}
                  disabled={!avail}
                  aria-pressed={selected === key}
                  onClick={() => setSelected(key)}
                >
                  {cell.d}
                </button>
              );
            })}
          </div>
          {slots !== null && days.size === 0 && loadError === '' ? <p class="ab-muted">{strings.noSlotsMonth}</p> : null}
          {slots === null ? <p class="ab-muted">{strings.loading}</p> : null}
          <label class="ab-tz">
            <span class="ab-label">{strings.timeZone}</span>
            <select value={timeZone} onChange={(e) => onTimeZone((e.target as HTMLSelectElement).value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
        </div>
        {selected !== null ? (
          <div class="ab-slots">
            <p class="ab-slots-day">{formatDay(selected, locale)}</p>
            {daySlots.length === 0 ? <p class="ab-muted">{strings.noSlots}</p> : null}
            {daySlots.map((slot) => (
              <button type="button" class="ab-slot" key={slot.start} onClick={() => onPick(slot)}>
                {formatTime(slot.start, timeZone, locale)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
  strings,
}: {
  question: PublicQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
  strings: BookingWidgetStrings;
}) {
  const name = `q_${question.key}`;
  switch (question.kind) {
    case 'textarea':
      return (
        <textarea
          class="ab-textarea"
          name={name}
          value={typeof value === 'string' ? value : ''}
          placeholder={question.placeholder}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        />
      );
    case 'select':
      return (
        <select class="ab-select" name={name} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          <option value="">{strings.select}</option>
          {question.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'multicheck': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div>
          {question.options.map((o) => (
            <label class="ab-check" key={o}>
              <input
                type="checkbox"
                checked={list.includes(o)}
                onChange={(e) => onChange((e.target as HTMLInputElement).checked ? [...list, o] : list.filter((v) => v !== o))}
              />
              {o}
            </label>
          ))}
        </div>
      );
    }
    case 'checkbox':
      return (
        <label class="ab-check">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
          {question.placeholder !== '' ? question.placeholder : question.label}
        </label>
      );
    default:
      return (
        <input
          class="ab-input"
          name={name}
          type={question.kind === 'number' ? 'number' : question.kind === 'phone' ? 'tel' : 'text'}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          placeholder={question.placeholder}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      );
  }
}

function Field({
  label,
  required,
  error,
  strings,
  children,
}: {
  label: string;
  required: boolean;
  error: AnswerError | undefined;
  strings: BookingWidgetStrings;
  children: ComponentChildren;
}) {
  return (
    <div class="ab-field">
      <span class="ab-label">
        {label} {required ? <span class="ab-req">*</span> : null}
      </span>
      {children}
      {error !== undefined ? <span class="ab-ferr">{strings.fieldErrors[error]}</span> : null}
    </div>
  );
}

function prefill(param: string): string {
  try {
    return new URLSearchParams(location.search).get(param)?.slice(0, 200) ?? '';
  } catch {
    return '';
  }
}

export function BookingWidget({
  api,
  strings,
  locale,
  config,
  host,
  preview,
}: Common & { config: PublicBookingConfig; host: HTMLElement; preview: boolean }) {
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    given_name: prefill('name'),
    family_name: '',
    email: prefill('email'),
    phone: '',
  }));
  const [errors, setErrors] = useState<Record<string, AnswerError>>({});
  const [message, setMessage] = useState('');
  const [pickError, setPickError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<BookResult | null>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);

  useEffect(() => {
    if (slot === null || config.turnstile_site_key === null || preview) return undefined;
    const slotEl = document.createElement('div');
    slotEl.setAttribute('slot', 'turnstile');
    host.appendChild(slotEl);
    turnstile.current = mountTurnstile(slotEl, config.turnstile_site_key);
    return () => {
      turnstile.current?.remove();
      turnstile.current = null;
      slotEl.remove();
    };
  }, [slot !== null]);

  const set = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: Event) => {
    event.preventDefault();
    if (slot === null || busy || preview) return;
    const invitee = validateInvitee(
      {
        given_name: String(values['given_name'] ?? ''),
        family_name: String(values['family_name'] ?? ''),
        email: String(values['email'] ?? ''),
        phone: String(values['phone'] ?? ''),
      },
      config.phone,
    );
    const answers: Record<string, unknown> = {};
    for (const q of config.questions) answers[q.key] = values[`q_${q.key}`];
    const checked = validateAnswers(
      config.questions.map((q) => ({ ...q, map_to: null })),
      answers,
    );
    const nextErrors = { ...(invitee.ok ? {} : invitee.errors), ...(checked.ok ? {} : prefixed(checked.errors)) };
    setErrors(nextErrors);
    if (!invitee.ok || !checked.ok) {
      setMessage(strings.fixErrors);
      return;
    }
    setBusy(true);
    setMessage('');
    const result = await api.book(config.slug, {
      start: new Date(slot.start).toISOString(),
      time_zone: timeZone,
      locale,
      ...invitee.value,
      answers: checked.value,
      hp: String(values['hp'] ?? ''),
      turnstile_token: turnstile.current?.token() ?? '',
      tracking: collectTracking(),
      meta: collectMeta(host),
    });
    setBusy(false);
    if (result.ok) {
      if (result.value.redirect_url !== '') {
        location.href = result.value.redirect_url;
        return;
      }
      setDone(result.value);
      return;
    }
    turnstile.current?.reset();
    if (result.failure.status === 409) {
      setSlot(null);
      setPickError(failureText(strings, result.failure));
      return;
    }
    if (result.failure.status === 422) {
      const fieldErrors: Record<string, AnswerError> = {};
      for (const d of result.failure.details) {
        const key = d.path.startsWith('answers.') ? `q_${d.path.slice(8)}` : d.path;
        fieldErrors[key] = (d.message as AnswerError) in strings.fieldErrors ? (d.message as AnswerError) : 'invalid_value';
      }
      setErrors(fieldErrors);
    }
    setMessage(failureText(strings, result.failure));
  };

  if (done !== null) {
    return (
      <div class="ab">
        <div class="ab-done">
          <div class="ab-done-icon">✓</div>
          <h3>{strings.confirmedTitle}</h3>
          <p class="ab-when">{formatFull(Date.parse(done.start), timeZone, locale)}</p>
          <p>{done.success_message !== '' ? done.success_message : strings.confirmedText}</p>
          <p class="ab-muted">{strings.addToCalendarHint}</p>
          <p>
            <a class="ab-link" href={done.manage_url} target="_blank" rel="noopener">
              {strings.manageLink}
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div class="ab">
      <Header config={config} strings={strings} extra={slot === null ? undefined : formatFull(slot.start, timeZone, locale)} />
      {slot === null ? (
        <Picker
          api={api}
          strings={strings}
          locale={locale}
          config={config}
          timeZone={timeZone}
          onTimeZone={setTimeZone}
          error={pickError}
          onPick={(picked) => {
            setPickError('');
            setSlot(picked);
          }}
        />
      ) : (
        <form class="ab-body" onSubmit={(e) => void submit(e)} noValidate>
          <div class="ab-picked">
            {formatFull(slot.start, timeZone, locale)} · {timeZone.replace(/_/g, ' ')}
          </div>
          {message !== '' ? <div class="ab-err" role="alert">{message}</div> : null}
          <div class="ab-row">
            <Field label={strings.givenName} required error={errors['given_name']} strings={strings}>
              <input class="ab-input" autoComplete="given-name" value={String(values['given_name'] ?? '')} onInput={(e) => set('given_name', (e.target as HTMLInputElement).value)} />
            </Field>
            <Field label={strings.familyName} required={false} error={errors['family_name']} strings={strings}>
              <input class="ab-input" autoComplete="family-name" value={String(values['family_name'] ?? '')} onInput={(e) => set('family_name', (e.target as HTMLInputElement).value)} />
            </Field>
          </div>
          <Field label={strings.email} required error={errors['email']} strings={strings}>
            <input class="ab-input" type="email" autoComplete="email" value={String(values['email'] ?? '')} onInput={(e) => set('email', (e.target as HTMLInputElement).value)} />
          </Field>
          {config.phone !== 'hidden' ? (
            <Field label={strings.phone} required={config.phone === 'required'} error={errors['phone']} strings={strings}>
              <input class="ab-input" type="tel" autoComplete="tel" value={String(values['phone'] ?? '')} onInput={(e) => set('phone', (e.target as HTMLInputElement).value)} />
            </Field>
          ) : null}
          {config.questions.map((q) => (
            <Field key={q.key} label={q.label} required={q.required} error={errors[`q_${q.key}`]} strings={strings}>
              <QuestionInput question={q} value={values[`q_${q.key}`]} onChange={(v) => set(`q_${q.key}`, v)} strings={strings} />
            </Field>
          ))}
          <input type="text" name="company_website" tabIndex={-1} autoComplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px" value={String(values['hp'] ?? '')} onInput={(e) => set('hp', (e.target as HTMLInputElement).value)} />
          <slot name="turnstile" />
          <div class="ab-actions">
            <button type="button" class="ab-ghost" onClick={() => setSlot(null)}>
              {strings.back}
            </button>
            <button type="submit" class="ab-cta" disabled={busy || preview}>
              {busy ? strings.confirming : strings.confirm}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function prefixed(errors: Record<string, AnswerError>): Record<string, AnswerError> {
  const out: Record<string, AnswerError> = {};
  for (const [key, value] of Object.entries(errors)) out[`q_${key}`] = value;
  return out;
}

/** Hosted manage page: shows the booking, cancels it or picks a new time. */
export function ManageWidget({ api, strings, locale, view: initial, token }: Common & { view: ManageView; token: string }) {
  const [view, setView] = useState(initial);
  const [mode, setMode] = useState<'view' | 'cancel' | 'reschedule'>('view');
  const [timeZone, setTimeZone] = useState(() => (initial.time_zone !== '' ? initial.time_zone : browserTimeZone()));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rescheduled, setRescheduled] = useState(false);
  const config = view.config;

  const cancel = async () => {
    setBusy(true);
    const result = await api.cancel(token, reason.trim());
    setBusy(false);
    if (result.ok) {
      setView(result.value);
      setMode('view');
    } else setError(failureText(strings, result.failure));
  };

  const reschedule = async (slot: Slot) => {
    setBusy(true);
    const result = await api.reschedule(token, new Date(slot.start).toISOString(), timeZone);
    setBusy(false);
    if (result.ok) {
      setView(result.value);
      setRescheduled(true);
      setMode('view');
      setError('');
    } else setError(failureText(strings, result.failure));
  };

  if (mode === 'reschedule') {
    return (
      <div class="ab">
        <Header config={config} strings={strings} />
        <Picker
          api={api}
          strings={strings}
          locale={locale}
          config={config}
          timeZone={timeZone}
          onTimeZone={setTimeZone}
          error={error}
          onPick={(slot) => void (busy ? undefined : reschedule(slot))}
        />
        <div class="ab-body">
          <button type="button" class="ab-ghost" onClick={() => setMode('view')}>
            {strings.back}
          </button>
        </div>
      </div>
    );
  }

  const cancelled = view.status === 'cancelled';
  return (
    <div class="ab">
      <Header config={config} strings={strings} />
      <div class="ab-done">
        <div class="ab-done-icon">{cancelled ? '✕' : '✓'}</div>
        <h3>{cancelled ? strings.cancelledTitle : rescheduled ? strings.rescheduledTitle : strings.manageTitle}</h3>
        <p class="ab-when">{formatFull(Date.parse(view.start), timeZone, locale)}</p>
        <p class="ab-muted">{timeZone.replace(/_/g, ' ')}</p>
        {cancelled ? <p>{strings.cancelledText}</p> : null}
        {!cancelled && !view.can_change ? <p class="ab-muted">{strings.pastBooking}</p> : null}
        {error !== '' ? <div class="ab-err" role="alert">{error}</div> : null}
        {!cancelled && view.can_change && mode === 'view' ? (
          <div class="ab-actions" style="justify-content:center">
            <button type="button" class="ab-ghost" onClick={() => setMode('reschedule')}>
              {strings.reschedule}
            </button>
            <button type="button" class="ab-cta ab-danger" onClick={() => setMode('cancel')}>
              {strings.cancel}
            </button>
          </div>
        ) : null}
        {mode === 'cancel' ? (
          <div style="max-width:420px;margin:0 auto;text-align:left">
            <Field label={strings.cancelReason} required={false} error={undefined} strings={strings}>
              <textarea class="ab-textarea" maxLength={500} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} />
            </Field>
            <div class="ab-actions">
              <button type="button" class="ab-ghost" onClick={() => setMode('view')}>
                {strings.back}
              </button>
              <button type="button" class="ab-cta ab-danger" disabled={busy} onClick={() => void cancel()}>
                {strings.cancelConfirm}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
