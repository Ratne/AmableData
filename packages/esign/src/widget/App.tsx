import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fill, SIGNING_STRINGS, type SigningStrings } from '../strings';
import { SIGNING_IMAGE_TYPES, type SigningOwnField, type SigningPage, type SigningView } from '../types';
import type { ApiFailure, SigningApi } from './api';
import { ImageDialog, type ImageMethod } from './SignaturePad';

type Value = string | boolean;

const NUMBER_RE = /^-?\d{1,15}(?:[.,]\d{1,6})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isImage = (field: SigningOwnField) => SIGNING_IMAGE_TYPES.includes(field.type);

function fieldError(field: SigningOwnField, value: Value | undefined, s: SigningStrings): string | null {
  if (field.type === 'signed_date') return null;
  const empty = value === undefined || value === '' || value === false;
  if (empty) return field.required ? s.required : null;
  if (field.type === 'number' && typeof value === 'string' && !NUMBER_RE.test(value.trim())) return s.invalidNumber;
  if (field.type === 'date' && typeof value === 'string' && !DATE_RE.test(value)) return s.invalidDate;
  if ((field.type === 'select' || field.type === 'radio') && typeof value === 'string' && !field.options.includes(value)) return s.chooseOption;
  return null;
}

function today(locale: string): string {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}

function failureText(failure: ApiFailure, s: SigningStrings): string {
  if (failure.status === 0) return s.networkError;
  if (failure.status === 429) return s.rateLimited;
  if (failure.status === 404) return s.notFound;
  return failure.message !== '' ? failure.message : s.genericError;
}

/** Width of an element, kept in sync (field text scales with the rendered page). */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = (el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (el === null) return;
    setWidth(el.getBoundingClientRect().width);
    observer.current = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.current.observe(el);
  };
  return [ref, width];
}

function OwnField(props: {
  field: SigningOwnField;
  value: Value | undefined;
  editable: boolean;
  invalid: boolean;
  focused: boolean;
  pageHeight: number;
  locale: string;
  strings: SigningStrings;
  onChange: (value: Value) => void;
  onPickImage: () => void;
  onFocus: () => void;
}) {
  const { field, value, strings: s } = props;
  const filled = field.type === 'signed_date' || !(value === undefined || value === '' || value === false);
  const fontSize = Math.max(9, Math.min(18, field.h * props.pageHeight * 0.55));
  const classes = ['sg-f', field.required && field.type !== 'signed_date' ? 'req' : '', filled ? 'filled' : '', props.invalid ? 'err' : '', props.focused ? 'focus' : '']
    .filter((c) => c !== '')
    .join(' ');
  const style = {
    left: `${String(field.x * 100)}%`,
    top: `${String(field.y * 100)}%`,
    width: `${String(field.w * 100)}%`,
    height: `${String(field.h * 100)}%`,
    fontSize: `${String(fontSize)}px`,
  };
  const title = field.label !== '' ? field.label : undefined;
  let content;
  if (isImage(field)) {
    content =
      typeof value === 'string' && value !== '' ? (
        <button type="button" class="sg-pick" disabled={!props.editable} onClick={props.onPickImage} title={s.edit}>
          <img class="sg-val" src={value} alt="" />
        </button>
      ) : (
        <button type="button" class="sg-pick" disabled={!props.editable} onClick={props.onPickImage}>
          {field.label !== '' ? field.label : field.type === 'initials' ? s.initialsTitle : field.type === 'image' ? s.imageTitle : s.signatureTitle}
        </button>
      );
  } else if (field.type === 'signed_date') {
    content = <span>{today(props.locale)}</span>;
  } else if (field.type === 'checkbox') {
    content = (
      <input
        type="checkbox"
        aria-label={field.label || s.checked}
        checked={value === true}
        disabled={!props.editable}
        onFocus={props.onFocus}
        onChange={(event) => props.onChange((event.currentTarget as HTMLInputElement).checked)}
      />
    );
  } else if (field.type === 'select') {
    content = (
      <select
        aria-label={field.label}
        value={typeof value === 'string' ? value : ''}
        disabled={!props.editable}
        onFocus={props.onFocus}
        onChange={(event) => props.onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">{field.label !== '' ? field.label : '—'}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'radio') {
    content = (
      <div class="sg-radio" role="radiogroup" aria-label={field.label}>
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={field.id}
              checked={value === option}
              disabled={!props.editable}
              onFocus={props.onFocus}
              onChange={() => props.onChange(option)}
            />
            {option}
          </label>
        ))}
      </div>
    );
  } else {
    content = (
      <input
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        aria-label={field.label}
        placeholder={field.label}
        value={typeof value === 'string' ? value : ''}
        disabled={!props.editable}
        maxLength={1000}
        onFocus={props.onFocus}
        onInput={(event) => props.onChange((event.currentTarget as HTMLInputElement).value)}
      />
    );
  }
  return (
    <div class={classes} style={style} title={title} data-field={field.id}>
      {content}
    </div>
  );
}

function Page(props: {
  page: SigningPage;
  total: number;
  api: SigningApi;
  view: SigningView;
  values: Record<string, Value>;
  editable: boolean;
  invalid: ReadonlySet<string>;
  focused: string | null;
  strings: SigningStrings;
  onChange: (id: string, value: Value) => void;
  onPickImage: (field: SigningOwnField) => void;
  onFocus: (id: string) => void;
}) {
  const [ref, width] = useWidth();
  const height = width * (props.page.height / props.page.width);
  const own = props.view.fields.filter((f) => f.page === props.page.index);
  const others = props.view.others.filter((f) => f.page === props.page.index);
  return (
    <div ref={ref} class="sg-page" style={{ aspectRatio: `${String(props.page.width)} / ${String(props.page.height)}`, maxWidth: '100%' }}>
      <img class="sg-bg" src={props.api.pageUrl(props.page.index)} alt={fill(props.strings.pageOf, { n: props.page.index + 1, total: props.total })} loading="lazy" />
      {others.map((f) => (
        <div
          key={f.id}
          class={`sg-f other${f.filled ? ' filled' : ''}`}
          style={{
            left: `${String(f.x * 100)}%`,
            top: `${String(f.y * 100)}%`,
            width: `${String(f.w * 100)}%`,
            height: `${String(f.h * 100)}%`,
            fontSize: `${String(Math.max(8, Math.min(16, f.h * height * 0.5)))}px`,
            ...(f.color === null || f.filled ? {} : { borderColor: f.color }),
          }}
        >
          {f.filled ? (f.text ?? '✓') : f.party_name}
        </div>
      ))}
      {own.map((f) => (
        <OwnField
          key={f.id}
          field={f}
          value={props.values[f.id]}
          editable={props.editable}
          invalid={props.invalid.has(f.id)}
          focused={props.focused === f.id}
          pageHeight={height}
          locale={props.view.locale}
          strings={props.strings}
          onChange={(v) => props.onChange(f.id, v)}
          onPickImage={() => props.onPickImage(f)}
          onFocus={() => props.onFocus(f.id)}
        />
      ))}
      <span class="sg-page-n">{fill(props.strings.pageOf, { n: props.page.index + 1, total: props.total })}</span>
    </div>
  );
}

function OtpDialog(props: { api: SigningApi; view: SigningView; strings: SigningStrings; onVerified: () => void; onCancel: () => void }) {
  const s = props.strings;
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const send = async () => {
    setBusy(true);
    const result = await props.api.sendCode();
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.failure, s));
      return;
    }
    setSent(result.value.sent || sent);
    setWait(result.value.retry_after);
    if (!result.value.sent) setError(fill(s.otpResendIn, { n: result.value.retry_after }));
    else setError(null);
  };

  useEffect(() => {
    void send();
  }, []);

  const verify = async () => {
    setBusy(true);
    const result = await props.api.verifyCode(code);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.failure, s));
      return;
    }
    if (result.value.verified) props.onVerified();
    else setError(result.value.expired ? s.otpExpired : fill(s.otpInvalid, { n: result.value.attempts_left }));
  };

  return (
    <div class="sg-modal" role="dialog" aria-modal="true">
      <div class="sg-dialog">
        <h3>{s.otpTitle}</h3>
        <p>{fill(s.otpText, { email: props.view.otp.email_hint })}</p>
        <input
          class="sg-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-label={s.otpCode}
          value={code}
          onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6))}
        />
        {error === null ? null : <p class="sg-err">{error}</p>}
        <div class="sg-actions">
          <button type="button" class="sg-btn" disabled={busy || wait > 0} onClick={() => void send()}>
            {wait > 0 ? fill(s.otpResendIn, { n: wait }) : sent ? s.otpResend : s.otpSend}
          </button>
          <button type="button" class="sg-btn" onClick={props.onCancel}>
            {s.cancel}
          </button>
          <button type="button" class="sg-btn primary" disabled={busy || code.length !== 6} onClick={() => void verify()}>
            {s.otpVerify}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeclineDialog(props: { strings: SigningStrings; busy: boolean; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const s = props.strings;
  const [reason, setReason] = useState('');
  return (
    <div class="sg-modal" role="dialog" aria-modal="true">
      <div class="sg-dialog">
        <h3>{s.declineTitle}</h3>
        <p>{s.declineText}</p>
        <textarea aria-label={s.declineReason} placeholder={s.declineReason} maxLength={500} value={reason} onInput={(event) => setReason((event.currentTarget as HTMLTextAreaElement).value)} />
        <div class="sg-actions">
          <button type="button" class="sg-btn" onClick={props.onCancel}>
            {s.cancel}
          </button>
          <button type="button" class="sg-btn primary" style={{ background: '#dc2626', borderColor: '#dc2626' }} disabled={props.busy} onClick={() => props.onConfirm(reason)}>
            {s.declineConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function Banner(props: { view: SigningView; strings: SigningStrings; api: SigningApi }) {
  const { view, strings: s } = props;
  const download = view.document_ready ? (
    <p style={{ marginTop: '10px' }}>
      <a class="sg-btn primary" href={props.api.documentUrl()} style={{ textDecoration: 'none', display: 'inline-block' }}>
        {s.download}
      </a>
    </p>
  ) : null;
  switch (view.state) {
    case 'waiting':
      return (
        <div class="sg-banner">
          <h2>{s.waitingTitle}</h2>
          <p>{s.waitingText}</p>
        </div>
      );
    case 'signed':
      return (
        <div class="sg-banner ok">
          <h2>{s.signedTitle}</h2>
          <p>{s.signedText}</p>
        </div>
      );
    case 'completed':
      return (
        <div class="sg-banner ok">
          <h2>{s.completedTitle}</h2>
          <p>{s.completedText}</p>
          {download}
        </div>
      );
    case 'declined':
      return (
        <div class="sg-banner bad">
          <h2>{s.declinedTitle}</h2>
          <p>{s.declinedText}</p>
        </div>
      );
    case 'closed':
      return (
        <div class="sg-banner bad">
          <p>{view.closed_reason === 'voided' ? s.closedVoided : view.closed_reason === 'expired' ? s.closedExpired : s.closedDeclined}</p>
        </div>
      );
    default:
      return null;
  }
}

export function App(props: { initial: SigningView; api: SigningApi }) {
  const [view, setView] = useState(props.initial);
  const s = SIGNING_STRINGS[view.locale];
  const [values, setValues] = useState<Record<string, Value>>({ ...props.initial.values });
  const [methods, setMethods] = useState<Record<string, ImageMethod>>({});
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [picking, setPicking] = useState<SigningOwnField | null>(null);
  const [otpOpen, setOtpOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = view.state === 'ready';

  useEffect(() => {
    void props.api.open().then((result) => {
      if (result.ok) setView(result.value);
    });
  }, []);

  const ordered = useMemo(() => [...view.fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x), [view.fields]);
  const missing = ordered.filter((f) => fieldError(f, values[f.id], s) !== null);
  const requiredLeft = missing.filter((f) => f.required).length;

  const goTo = (field: SigningOwnField) => {
    setFocused(field.id);
    const el = document.querySelector(`[data-field="${field.id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = el?.querySelector('input,select,button') as HTMLElement | null | undefined;
    if (isImage(field)) setPicking(field);
    else input?.focus({ preventScroll: true });
  };

  const change = (id: string, value: Value) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    setInvalid((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const submit = async (otpVerified = view.otp.verified) => {
    setError(null);
    if (missing.length > 0) {
      setInvalid(new Set(missing.map((f) => f.id)));
      setError(s.fixFields);
      goTo(missing[0]!);
      return;
    }
    if (!consent) {
      setError(s.consentRequired);
      return;
    }
    if (view.otp.required && !otpVerified) {
      setOtpOpen(true);
      return;
    }
    setBusy(true);
    const own: Record<string, Value> = {};
    for (const field of view.fields) {
      const value = values[field.id];
      if (value !== undefined && field.type !== 'signed_date') own[field.id] = typeof value === 'string' && !isImage(field) ? value.trim() : value;
    }
    const result = await props.api.complete({ values: own, methods, consent: true, consent_version: view.consent.version });
    setBusy(false);
    if (!result.ok) {
      const bad = new Set(result.failure.details.map((d) => d.path.replace(/^values\./, '')));
      if (bad.size > 0) setInvalid(bad);
      setError(result.failure.status === 409 && result.failure.message.includes('consent') ? s.consentChanged : failureText(result.failure, s));
      return;
    }
    setView(result.value);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const decline = async (reason: string) => {
    setBusy(true);
    const result = await props.api.decline(reason);
    setBusy(false);
    setDeclineOpen(false);
    if (!result.ok) {
      setError(failureText(result.failure, s));
      return;
    }
    setView(result.value);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const expires =
    view.expires_at === null
      ? null
      : fill(s.expiresOn, {
          date: new Intl.DateTimeFormat(view.locale === 'it' ? 'it-IT' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(view.expires_at)),
        });

  return (
    <div class="sg">
      <header class="sg-head">
        <div class="sg-head-in">
          <div>
            <h1 class="sg-title">{view.request_name}</h1>
            <p class="sg-sub">{fill(s.requestFrom, { tenant: view.tenant_name })}</p>
            <p class="sg-sub">
              {fill(s.signingAs, { name: view.signer.name !== '' ? view.signer.name : view.signer.email, party: view.signer.party_name })}
              {expires !== null && editable ? ` · ${expires}` : ''}
            </p>
          </div>
          {editable ? (
            <button type="button" class="sg-btn danger" onClick={() => setDeclineOpen(true)}>
              {s.decline}
            </button>
          ) : null}
        </div>
      </header>
      <main class="sg-main">
        <Banner view={view} strings={s} api={props.api} />
        {editable && view.message.trim() !== '' ? <div class="sg-note">{view.message}</div> : null}
        {view.pages.map((page) => (
          <Page
            key={page.index}
            page={page}
            total={view.pages.length}
            api={props.api}
            view={view}
            values={values}
            editable={editable}
            invalid={invalid}
            focused={focused}
            strings={s}
            onChange={change}
            onPickImage={(field) => setPicking(field)}
            onFocus={setFocused}
          />
        ))}
      </main>
      {editable ? (
        <div class="sg-bar">
          <div class="sg-bar-in">
            <label class="sg-consent">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent((event.currentTarget as HTMLInputElement).checked)} />
              <span>
                <strong>{s.consentLabel}.</strong> {view.consent.text}
              </span>
            </label>
            <div class="sg-progress">
              {requiredLeft > 0 ? fill(s.fieldsLeft, { n: requiredLeft }) : s.allFilled}
              {error === null ? null : <p class="sg-err">{error}</p>}
            </div>
            {missing.length > 0 ? (
              <button type="button" class="sg-btn" onClick={() => goTo(missing[0]!)}>
                {s.nextField}
              </button>
            ) : null}
            <button type="button" class="sg-btn primary" disabled={busy} onClick={() => void submit()}>
              {busy ? s.signing : s.finish}
            </button>
          </div>
        </div>
      ) : null}
      {picking === null ? null : (
        <ImageDialog
          type={picking.type}
          signerName={view.signer.name}
          strings={s}
          onCancel={() => setPicking(null)}
          onApply={(result) => {
            change(picking.id, result.dataUrl);
            setMethods((prev) => ({ ...prev, [picking.id]: result.method }));
            const reuse = view.fields.filter((f) => f.type === picking.type && f.id !== picking.id && (values[f.id] === undefined || values[f.id] === ''));
            if (picking.type !== 'image') {
              for (const f of reuse) {
                change(f.id, result.dataUrl);
                setMethods((prev) => ({ ...prev, [f.id]: result.method }));
              }
            }
            setPicking(null);
          }}
        />
      )}
      {otpOpen ? (
        <OtpDialog
          api={props.api}
          view={view}
          strings={s}
          onCancel={() => setOtpOpen(false)}
          onVerified={() => {
            setOtpOpen(false);
            setView((prev) => ({ ...prev, otp: { ...prev.otp, verified: true } }));
            void submit(true);
          }}
        />
      ) : null}
      {declineOpen ? <DeclineDialog strings={s} busy={busy} onCancel={() => setDeclineOpen(false)} onConfirm={(reason) => void decline(reason)} /> : null}
    </div>
  );
}
