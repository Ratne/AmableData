import {
  ACTION_LINK_ATTR,
  DIRECT_LINK_PARAMS,
  type ConversionData,
  type DirectLink,
  type LinkAttribution,
} from './protocol';
import { sanitizeValue } from './sanitize';

/** Kinds of form values the tracker captures (names follow the registry profile). */
export const FIELD_KINDS = [
  'email',
  'phone',
  'coupon',
  'given_name',
  'family_name',
  'full_name',
  'address',
  'street',
  'city',
  'region',
  'country',
  'postal_code',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Values captured from forms or links, already normalized. */
export type Contact = Partial<Record<FieldKind, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTEXT_ID_RE = /^[\w-]{1,64}$/;
const VISITOR_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
// Matched against name + id + autocomplete: such fields are never read.
const SENSITIVE_RE =
  /pass|pwd|card|cc-|cvc|cvv|iban|secret|otp|one-time|ssn|tax|fiscal|vat|(^|[^a-z])pin([^a-z]|$)/i;
const PHONE_HINT_RE = /phone|mobile|cellul|telef|whatsapp|(^|[^a-z])(tel|cell)([^a-z]|$)/i;
const ACTION_PATH_RE = /\/a\/\d+\/?$/;

/** `autocomplete` tokens (WHATWG) → kind. */
const AUTOCOMPLETE: ReadonlyArray<[RegExp, FieldKind]> = [
  [/(^|\s)email/, 'email'],
  [/(^|\s)tel/, 'phone'],
  [/given-name/, 'given_name'],
  [/family-name/, 'family_name'],
  [/(^|\s)name($|\s)/, 'full_name'],
  [/street-address/, 'address'],
  [/address-line/, 'street'],
  [/address-level2/, 'city'],
  [/address-level1/, 'region'],
  [/country/, 'country'],
  [/postal-code/, 'postal_code'],
];

/**
 * Name / id / placeholder / label hints → kind (it, en, es, fr, de, pt). Order
 * matters: the first match wins, the specific before the generic.
 */
const HINTS: ReadonlyArray<[RegExp, FieldKind]> = [
  [/mail/i, 'email'],
  [PHONE_HINT_RE, 'phone'],
  [/coupon|promo|voucher|discount|sconto|gutschein|cup[oó]n|r[eé]duction/i, 'coupon'],
  [
    /full.?name|fullname|nome.?(e.?)?cognome|nome.?completo|nombre.?completo|nom.?complet|your.?name|^name$|^nominativo$/i,
    'full_name',
  ],
  [/last.?name|lname|surname|family|cognome|nachname|apellido|sobrenome|^nom$/i, 'family_name'],
  [/first.?name|fname|given|^nome$|vorname|pr[eé]nom|^nombre$|primeiro/i, 'given_name'],
  [
    /zip|postal|post.?code|^cap$|(^|[^a-z])cap([^a-z]|$)|plz|c[oó]digo.?postal|code.?postal|cep/i,
    'postal_code',
  ],
  [/city|town|citt[aà]|comune|ciudad|ville|stadt|cidade|locality/i, 'city'],
  [
    /(^|[^a-z])state([^a-z]|$)|province|provincia|regione?|region|county|bundesland|estado/i,
    'region',
  ],
  [/country|nazione|paese|pa[ií]s|pays|(^|[^a-z])land([^a-z]|$)|nation/i, 'country'],
  [
    /address.?(line)?.?[12]|addr1|street|(^|[^a-z])via([^a-z]|$)|strasse|stra[sß]e|calle|rue|rua/i,
    'street',
  ],
  [/address|indirizzo|direcci[oó]n|adresse|anschrift|endere[cç]o/i, 'address'],
];

const TEXT_TYPES = new Set(['text', 'email', 'tel', 'search', '']);

/** Kind of a field known only by its name or label (embedded form providers). */
export function kindOfLabel(label: string): FieldKind | undefined {
  const v = label.trim();
  return v === '' || SENSITIVE_RE.test(v) ? undefined : HINTS.find(([re]) => re.test(v))?.[1];
}

/** Normalized value of a kind; undefined when it does not fit. */
export function normalizeValue(kind: FieldKind, raw: string): string | undefined {
  return kind === 'email'
    ? normalizeEmail(raw)
    : kind === 'phone'
      ? normalizePhone(raw)
      : normalizeText(raw);
}

export function normalizeEmail(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : undefined;
}

/** Best-effort E.164: drops separators, `00` becomes `+`; numbers without prefix keep their digits. */
export function normalizePhone(raw: string): string | undefined {
  let v = raw.trim().replace(/[\s().\-/]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  return /^\+?\d{6,15}$/.test(v) ? v : undefined;
}

function labelOf(el: Element): string {
  const label = (el as HTMLInputElement).labels?.[0] ?? el.closest('label');
  return `${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('aria-label') ?? ''} ${label?.textContent ?? ''}`;
}

/** Which value a field holds; undefined for anything else (passwords and cards included). */
export function fieldKind(el: Element | null): FieldKind | undefined {
  if (el === null) return undefined;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return undefined;
  const type = tag === 'INPUT' ? (el as HTMLInputElement).type.toLowerCase() : tag.toLowerCase();
  if (tag === 'INPUT' && !TEXT_TYPES.has(type)) return undefined;
  if (el.closest('[data-amb-ignore]') !== null) return undefined;
  const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
  const own = `${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''} ${ac}`;
  if (SENSITIVE_RE.test(own)) return undefined;
  let kind: FieldKind | undefined;
  if (type === 'email') kind = 'email';
  else if (type === 'tel') kind = 'phone';
  else kind = AUTOCOMPLETE.find(([re]) => re.test(ac))?.[1];
  if (kind === undefined) {
    const names = [el.getAttribute('name') ?? '', el.getAttribute('id') ?? ''];
    for (const hint of [...names, labelOf(el)]) {
      kind = HINTS.find(([re]) => re.test(hint.trim()))?.[1];
      if (kind !== undefined) break;
    }
  }
  if (kind === undefined) return undefined;
  // Free text only for postal addresses; lists only for places.
  if (tag === 'TEXTAREA' && kind !== 'address' && kind !== 'street') return undefined;
  if (tag === 'SELECT' && kind !== 'country' && kind !== 'region') return undefined;
  return kind;
}

function normalizeText(raw: string): string | undefined {
  const v = raw.trim().replace(/\s+/g, ' ').slice(0, 128);
  return v === '' || v.includes('@') ? undefined : v;
}

export function readField(el: Element | null): Contact | undefined {
  const kind = fieldKind(el);
  if (kind === undefined) return undefined;
  const value = normalizeValue(kind, (el as HTMLInputElement).value);
  return value === undefined ? undefined : { [kind]: value };
}

/** Form a field belongs to (its own form, else its shadow root or document): the capture scope. */
export function scopeOf(el: Element): object {
  return (el as HTMLInputElement).form ?? el.closest('form') ?? el.getRootNode();
}

/**
 * Per-form capture: values are kept per scope, so an email and a phone are
 * sent together only when they come from the same form (the identity graph
 * then treats them as one person); `emit` runs when a scope holding an email
 * or phone changes.
 */
export function contactSink(
  emit: (contact: Contact) => void,
): (scope: object, found: Contact) => Contact {
  const scopes = new WeakMap<object, { values: Contact; sent: string }>();
  return (scope, found) => {
    let state = scopes.get(scope);
    if (state === undefined) {
      state = { values: {}, sent: '' };
      scopes.set(scope, state);
    }
    Object.assign(state.values, found);
    const v = state.values;
    if (v.email !== undefined || v.phone !== undefined) {
      const snapshot = JSON.stringify(v);
      if (snapshot !== state.sent) {
        state.sent = snapshot;
        emit({ ...v });
      }
    }
    return { ...v };
  };
}

export interface FormWatchOptions {
  listen?: AddEventListenerOptions;
  /** Also capture while typing (debounced), for visitors who never leave the field. */
  typing?: boolean;
  /** A form was submitted: its id, its captured values and (opt-in) its other fields. */
  onSubmit?: (form: HTMLFormElement, values: Contact) => void;
}

const TYPING_DEBOUNCE_MS = 3000;

/** Real target of an event, inside open shadow roots too. */
export function eventTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return ((path[0] as Element | undefined) ?? (event.target as Element | null)) || null;
}

/** Captures values as soon as a field is left or changed, and again on submit. */
export function watchForms(
  root: Document | ShadowRoot,
  offer: (scope: object, found: Contact) => Contact,
  options: FormWatchOptions = {},
  watched: WeakSet<object> = new WeakSet(),
): void {
  if (watched.has(root)) return;
  watched.add(root);
  const listen = options.listen ?? { capture: true };
  // Open shadow roots (web components, embedded widgets) are watched from their first focus:
  // `change` and `submit` do not cross the shadow boundary.
  root.addEventListener(
    'focusin',
    (event) => {
      for (const node of event.composedPath()) {
        const n = node as Node & { host?: unknown };
        if (n.nodeType === 11 && n.host !== undefined)
          watchForms(n as ShadowRoot, offer, options, watched);
      }
    },
    listen,
  );
  const onField = (el: Element | null): void => {
    if (el === null) return;
    const found = readField(el);
    if (found !== undefined) offer(scopeOf(el), found);
  };
  const onEvent = (event: Event): void => onField(eventTarget(event));
  root.addEventListener('change', onEvent, listen);
  root.addEventListener('blur', onEvent, listen);
  if (options.typing === true) {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    root.addEventListener(
      'input',
      (event) => {
        const el = eventTarget(event);
        if (el === null || fieldKind(el) === undefined) return;
        clearTimeout(timers.get(el));
        timers.set(
          el,
          setTimeout(() => onField(el), TYPING_DEBOUNCE_MS),
        );
      },
      listen,
    );
  }
  root.addEventListener(
    'submit',
    (event) => {
      const form = eventTarget(event) as HTMLFormElement | null;
      if (form === null) return;
      const found: Contact = {};
      for (const el of Array.from(form.elements ?? [])) Object.assign(found, readField(el));
      const values = offer(form, found);
      options.onSubmit?.(form, values);
    },
    listen,
  );
}

const PAYLOAD_MAX = 15;
const PAYLOAD_TYPES = new Set([
  'text',
  'number',
  'radio',
  'checkbox',
  'select-one',
  'textarea',
  'range',
  'date',
]);

/** Form label: its id, else its name, else its action path. */
export function formName(form: HTMLFormElement): string {
  const label = form.getAttribute('id') ?? form.getAttribute('name');
  if (label !== null && label !== '') return label.slice(0, 64);
  try {
    return new URL(form.getAttribute('action') ?? '', form.ownerDocument.baseURI).pathname.slice(
      0,
      64,
    );
  } catch {
    return 'form';
  }
}

/**
 * `form_submit` goal data: the form, the captured kinds (values travel in the
 * identify) and, opt-in, the other answers (`f_<name>`) without anything that
 * looks like a contact, a secret or a hidden value.
 */
export function formSubmitData(
  form: HTMLFormElement,
  values: Contact,
  payload: boolean,
): Record<string, string> {
  const data: Record<string, string> = {
    form: formName(form),
    fields: Object.keys(values).sort().join(','),
  };
  if (!payload && !form.hasAttribute('data-amb-payload')) return data;
  let n = 0;
  for (const el of Array.from(form.elements ?? []) as HTMLInputElement[]) {
    const name = (el.getAttribute('name') ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (name === '' || n >= PAYLOAD_MAX || !PAYLOAD_TYPES.has(el.type)) continue;
    if (fieldKind(el) !== undefined || SENSITIVE_RE.test(name) || el.closest('[data-amb-ignore]'))
      continue;
    if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
    const v = el.value.trim().slice(0, 255);
    if (v === '' || v.includes('@') || /\d{6,}/.test(v.replace(/[\s().\-/]/g, ''))) continue;
    const key = `f_${name}`.slice(0, 64);
    data[key] = key in data ? `${data[key]},${v}`.slice(0, 255) : v;
    n++;
  }
  return data;
}

/** URL params that carry the visitor's email (ESPs, schedulers, checkouts, form tools). */
export const EMAIL_URL_PARAMS = [
  'he',
  'email',
  'e_mail',
  'email_address',
  'emailaddress',
  'invitee_email',
  'payer_email',
  'checkoutemail',
  'wj_lead_email',
  'ew_email',
  'cemail',
  'user_email',
  'contact_email',
  'lead_email',
  'customer_email',
  'subscriber_email',
  'buyer_email',
  'inf_field_email',
  'your_email',
];
/** URL params that carry the visitor's phone. */
export const PHONE_URL_PARAMS = [
  'phone',
  'phone_number',
  'invitee_phone',
  'payer_phone',
  'contact_phone',
  'customer_phone',
  'lead_phone',
  'inf_field_phone1',
  'telephone',
  'mobile',
];
const CONTACT_URL_PARAMS = new Set([...EMAIL_URL_PARAMS, ...PHONE_URL_PARAMS]);

const urlEmail = (raw: string): string | undefined => {
  // Unencoded `+` aliases arrive as spaces.
  const v = raw.trim().toLowerCase().replace(/ /g, '+');
  return SHA256_RE.test(v) ? v : normalizeEmail(v);
};

const firstOf = <T>(
  params: URLSearchParams,
  names: readonly string[],
  read: (v: string) => T | undefined,
): T | undefined => {
  for (const [key, value] of params) {
    if (!names.includes(key.toLowerCase())) continue;
    const v = read(value);
    if (v !== undefined) return v;
  }
  return undefined;
};

/** Email (plain or SHA-256 hex, from `he` or an alias), `sl` and `el` of a landing URL. */
export function readLinkAttribution(params: URLSearchParams): LinkAttribution | undefined {
  const out: LinkAttribution = {};
  const email = firstOf(params, EMAIL_URL_PARAMS, urlEmail);
  if (email !== undefined) out.he = email;
  for (const key of ['sl', 'el'] as const) {
    const value = sanitizeValue(params.get(key) ?? '').slice(0, 128);
    if (value !== '') out[key] = value;
  }
  return isEmpty(out) ? undefined : out;
}

/** Phone of a landing URL (`phone` and its aliases). */
export const readUrlPhone = (params: URLSearchParams): string | undefined =>
  firstOf(params, PHONE_URL_PARAMS, normalizePhone);

/** The URL without its email / phone params: they never leave the browser in clear. */
export function withoutContactParams(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const drop = [...url.searchParams.keys()].filter((k) => CONTACT_URL_PARAMS.has(k.toLowerCase()));
  if (drop.length === 0) return href;
  for (const k of drop) url.searchParams.delete(k);
  return url.toString();
}

export const isEmpty = (o: object): boolean => Object.keys(o).length === 0;

/**
 * Direct-link context of a landing URL. Read only when `f` (funnel) or a
 * well-formed `vid` is present, so generic `?p=` / `?n=` params are not mistaken
 * for funnel ids. A `vid` without `f` refines the stored context.
 */
export function readDirectLink(params: URLSearchParams, stored: DirectLink): DirectLink {
  const own = (key: string): string | undefined => {
    const v = params.get(key);
    return v !== null && CONTEXT_ID_RE.test(v) ? v : undefined;
  };
  const f = own('f');
  const vid = params.get('vid');
  const hasVid = vid !== null && VISITOR_ID_RE.test(vid);
  if (f === undefined && !hasVid) return stored;
  const out: DirectLink = f === undefined ? { ...stored } : {};
  for (const key of DIRECT_LINK_PARAMS) {
    const v = own(key);
    if (v !== undefined) out[key] = v;
  }
  if (hasVid) out.vid = vid;
  return out;
}

/** Parses a stored or user-supplied context as JSON, dropping anything malformed. */
export function parseDirectLink(raw: string | null | undefined): DirectLink {
  const out: DirectLink = {};
  try {
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    for (const key of [...DIRECT_LINK_PARAMS, 'vid'] as const) {
      const v = value[key];
      if (typeof v === 'string' && CONTEXT_ID_RE.test(v)) out[key] = v;
    }
  } catch {
    // not JSON, or null
  }
  return out;
}

/**
 * Appends `vid` and `rn` to an action link (`…/a/N` or `data-amb-action`).
 * Keys already present are left alone, so decorating twice is a no-op.
 * Returns whether the anchor is an action link.
 */
export function decorateAction(
  a: HTMLAnchorElement,
  base: string,
  vid: string | undefined,
  rn: string | undefined,
): boolean {
  let url: URL;
  try {
    url = new URL(a.getAttribute('href') ?? '', base);
  } catch {
    return false;
  }
  if (!a.hasAttribute(ACTION_LINK_ATTR) && !ACTION_PATH_RE.test(url.pathname)) return false;
  const p = url.searchParams;
  let changed = false;
  if (vid !== undefined && !p.has('vid')) {
    p.set('vid', vid);
    changed = true;
  }
  if (rn !== undefined && !p.has('rn')) {
    p.set('rn', rn);
    changed = true;
  }
  if (changed) a.href = url.toString();
  return true;
}

/** Validates `amable('conversion', {value, currency, tx})`; undefined when malformed. */
export function conversionOf(input: unknown): ConversionData | undefined {
  const { value, currency, tx } = Object(input) as Record<string, unknown>;
  const out: ConversionData = {};
  if (value != null && value !== '') {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return undefined;
    out.value = v;
  }
  if (currency !== undefined) {
    const c = String(currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) return undefined;
    out.currency = c;
  }
  const t = tx == null ? '' : sanitizeValue(tx);
  if (t !== '') out.tx = t;
  return out;
}
