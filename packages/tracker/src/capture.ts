import {
  ACTION_LINK_ATTR,
  DIRECT_LINK_PARAMS,
  type ConversionData,
  type DirectLink,
  type LinkAttribution,
} from './protocol';
import { sanitizeValue } from './sanitize';

/** Contact values captured from forms or links, already normalized. */
export interface Contact {
  email?: string;
  phone?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTEXT_ID_RE = /^[\w-]{1,64}$/;
const VISITOR_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
// Matched against name + id + autocomplete: such fields are never read.
const SENSITIVE_RE = /pass|pwd|card|cc-|cvc|cvv|iban|secret|otp|one-time/i;
const EMAIL_HINT_RE = /mail/i;
const PHONE_HINT_RE = /phone|mobile|cellul|telef|whatsapp|(^|[^a-z])(tel|cell)([^a-z]|$)/i;
const ACTION_PATH_RE = /\/a\/\d+\/?$/;

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

/** Which contact value an input holds; undefined for anything else (passwords and cards included). */
export function fieldKind(el: Element | null): keyof Contact | undefined {
  if (el?.tagName !== 'INPUT') return undefined;
  const input = el as HTMLInputElement;
  const type = input.type.toLowerCase();
  if (type !== 'text' && type !== 'email' && type !== 'tel') return undefined;
  if (input.closest('[data-amb-ignore]') !== null) return undefined;
  const ac = (input.getAttribute('autocomplete') ?? '').toLowerCase();
  const hints = `${input.name} ${input.id} ${ac}`;
  if (SENSITIVE_RE.test(hints)) return undefined;
  if (type === 'email' || /(^|\s)email/.test(ac)) return 'email';
  if (type === 'tel' || /(^|\s)tel/.test(ac)) return 'phone';
  if (EMAIL_HINT_RE.test(hints)) return 'email';
  if (PHONE_HINT_RE.test(hints)) return 'phone';
  return undefined;
}

export function readField(el: Element | null): Contact | undefined {
  const kind = fieldKind(el);
  if (kind === undefined) return undefined;
  const raw = (el as HTMLInputElement).value;
  const value = kind === 'email' ? normalizeEmail(raw) : normalizePhone(raw);
  return value === undefined ? undefined : { [kind]: value };
}

/**
 * Dedupes contact values: `emit` runs only when a value not seen before shows up,
 * with the latest email and phone known on the page.
 */
export function contactSink(emit: (contact: Contact) => void): (found: Contact) => void {
  const seen = new Set<string>();
  const last: Contact = {};
  return (found) => {
    let fresh = false;
    for (const key of ['email', 'phone'] as const) {
      const value = found[key];
      if (value === undefined) continue;
      last[key] = value;
      if (!seen.has(`${key}:${value}`)) {
        seen.add(`${key}:${value}`);
        fresh = true;
      }
    }
    if (fresh) emit({ ...last });
  };
}

/** Captures email/phone as soon as a field is left or changed, and again on submit. */
export function watchForms(doc: Document, offer: (found: Contact) => void): void {
  const onField = (event: Event): void => {
    const found = readField(event.target as Element | null);
    if (found !== undefined) offer(found);
  };
  doc.addEventListener('change', onField, true);
  doc.addEventListener('blur', onField, true);
  doc.addEventListener(
    'submit',
    (event) => {
      const form = event.target as HTMLFormElement | null;
      const found: Contact = {};
      for (const el of Array.from(form?.elements ?? [])) Object.assign(found, readField(el));
      offer(found);
    },
    true,
  );
}

/** `he` (plain email or SHA-256 hex), `sl` and `el` of a landing URL. */
export function readLinkAttribution(params: URLSearchParams): LinkAttribution | undefined {
  const out: LinkAttribution = {};
  // Unencoded `+` aliases arrive as spaces.
  const he = String(params.get('he')).trim().toLowerCase().replace(/ /g, '+');
  const email = SHA256_RE.test(he) ? he : normalizeEmail(he);
  if (email !== undefined) out.he = email;
  for (const key of ['sl', 'el'] as const) {
    const value = sanitizeValue(params.get(key) ?? '').slice(0, 128);
    if (value !== '') out[key] = value;
  }
  return isEmpty(out) ? undefined : out;
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

/** Validates `amb('conversion', {value, currency, tx})`; undefined when malformed. */
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
