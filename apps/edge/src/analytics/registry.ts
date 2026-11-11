import type { EdgeSiteConfig } from './enrich';
import type { EnrichedEvent, ExtraValue } from './types';
import {
  landingEmailHash,
  normalizeEmailKey,
  normalizePhoneKey,
  phoneKeyHash,
} from './store/identity';

/**
 * Registry channel: the contact data of an event (clear email, phone, names,
 * address) goes to the workspace registry (TenantDb, via the `registry`
 * queue consumed by the core) and never into the analytics pipeline. The
 * analytics event keeps SHA-256 keys only, so the site DO, the WAL and the R2
 * archive are free of clear PII by construction.
 *
 * Contract v1, additive only: new optional fields and profile keys may be
 * added; existing ones keep their meaning.
 */
export interface RegistryMessage {
  v: 1;
  /** Event id: idempotency key of the registration. */
  eid: string;
  tenantId: string;
  /** Site of `visitorId` ('' with no visitor: workspace API calls). */
  siteId: string;
  /** Null for a server-side payment without visitor id. */
  visitorId: string | null;
  ts: number;
  /** `lead` / `sale`: the workspace server API (`/v1`), produced by the core only. */
  source: 'identify' | 'payment' | 'lead' | 'sale';
  /** Normalized (trimmed, lower-cased). */
  email: string | null;
  /** E.164. */
  phone: string | null;
  userId: string | null;
  /** Profile fields, see PROFILE_FIELDS; each carries the event time for latest-wins updates. */
  profile: Partial<Record<ProfileField, string>>;
}

export const PROFILE_FIELDS = [
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
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const ALIASES: Readonly<Record<string, ProfileField>> = {
  first_name: 'given_name',
  firstname: 'given_name',
  given_name: 'given_name',
  nome: 'given_name',
  last_name: 'family_name',
  lastname: 'family_name',
  family_name: 'family_name',
  surname: 'family_name',
  cognome: 'family_name',
  name: 'full_name',
  full_name: 'full_name',
  fullname: 'full_name',
  nome_completo: 'full_name',
  address: 'address',
  full_address: 'address',
  indirizzo: 'address',
  street: 'street',
  address1: 'street',
  address_line1: 'street',
  via: 'street',
  city: 'city',
  citta: 'city',
  town: 'city',
  state: 'region',
  region: 'region',
  province: 'region',
  provincia: 'region',
  country: 'country',
  nazione: 'country',
  paese: 'country',
  zip: 'postal_code',
  postal_code: 'postal_code',
  postcode: 'postal_code',
  cap: 'postal_code',
};

/** Keys of contact data besides the profile fields: never kept in analytics. */
const CONTACT_KEY =
  /^(e_?mail|email_address|phone|phone_number|tel|telephone|telefono|mobile|cellulare|birthday|birth_date|data_di_nascita)$/i;
const EMAIL_IN_VALUE = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** True for a param that carries contact data (by key or by an email in the value). */
export function isContactParam(key: string, value: ExtraValue): boolean {
  return (
    CONTACT_KEY.test(key) ||
    profileField(key) !== undefined ||
    (typeof value === 'string' && EMAIL_IN_VALUE.test(value))
  );
}

const clean = (v: ExtraValue | undefined, max = 200): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

function profileField(key: string): ProfileField | undefined {
  return ALIASES[key.toLowerCase().replace(/[\s-]+/g, '_')];
}

/** Without the keys that look like contact data (goal params, link data). */
function withoutPii(record: Record<string, ExtraValue> | null): Record<string, ExtraValue> | null {
  if (record === null) return null;
  const kept = Object.entries(record).filter(([k, v]) => !isContactParam(k, v));
  return kept.length > 0 ? Object.fromEntries(kept) : null;
}

/**
 * Splits the contact data off an enriched event, in place: the event keeps
 * hashed email/phone keys (`identity.email`, `traits.phone`, `payment.email`),
 * loses names and profile traits; the clear values are returned for the
 * registry (null when the event carries none).
 */
const suppressedSets = new WeakMap<EdgeSiteConfig['suppressed'], Set<string>>();

/**
 * Edge pre-filter of an event already split (hashed identities): its visitor
 * or one of its hashes is a tombstone of the site. Exact check in the DO.
 */
export function suppressedAtEdge(
  config: Pick<EdgeSiteConfig, 'suppressed'>,
  event: EnrichedEvent,
): boolean {
  const s = config.suppressed;
  if (s.visitors.length === 0 && s.keys.length === 0) return false;
  let set = suppressedSets.get(s);
  if (set === undefined) {
    set = new Set([...s.visitors, ...s.keys]);
    suppressedSets.set(s, set);
  }
  const phone = event.identity?.traits?.['phone'];
  return (
    set.has(event.vid) ||
    [event.identity?.email, event.payment?.email, typeof phone === 'string' ? phone : null].some(
      (k) => typeof k === 'string' && set.has(k),
    )
  );
}

/** URL params named like a contact field (the tracker's email/phone aliases included). */
const CONTACT_URL_KEY =
  /^(he|e_?mail|email_address|emailaddress|\w*_email|checkoutemail|cemail|phone|phone_number|\w*_phone\d?|telephone|mobile)$/i;

/** The URL without query params carrying contact data; unparsable URLs are kept as they are. */
export function scrubUrl(raw: string | null): string | null {
  if (raw === null || !raw.includes('?')) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const drop = [...url.searchParams].filter(
    ([k, v]) => CONTACT_URL_KEY.test(k) || EMAIL_IN_VALUE.test(v) || profileField(k) !== undefined,
  );
  if (drop.length === 0) return raw;
  for (const [k] of drop) url.searchParams.delete(k);
  return url.toString();
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function splitPii(event: EnrichedEvent, tenantId: string): RegistryMessage | null {
  let email: string | null = null;
  let phone: string | null = null;
  const profile: RegistryMessage['profile'] = {};
  event.url = scrubUrl(event.url);
  event.referrer = scrubUrl(event.referrer);
  const id = event.identity;
  if (id !== null && id.userId !== null && EMAIL_SHAPE.test(id.userId.trim())) {
    // An email used as user id is contact data like any other.
    if (id.email === null) id.email = id.userId.trim().toLowerCase();
    id.userId = null;
  }
  if (id !== null) {
    const clear = id.email === null ? null : normalizeEmailKey(id.email);
    if (clear !== null) email = clear;
    id.email = id.email === null ? null : landingEmailHash(id.email);
    const full = clean(id.name ?? undefined);
    if (full !== null) profile.full_name = full;
    id.name = null;
    if (id.traits !== null) {
      const traits: Record<string, ExtraValue> = {};
      for (const [key, value] of Object.entries(id.traits)) {
        if (key === 'phone') {
          const raw = clean(value, 64);
          if (raw !== null) {
            phone = normalizePhoneKey(raw) ?? phone;
            const hash = phoneKeyHash(raw);
            if (hash !== null) traits['phone'] = hash;
          }
          continue;
        }
        const field = profileField(key);
        if (field !== undefined) {
          const v = clean(value);
          if (v !== null) profile[field] = v;
          continue;
        }
        if (!isContactParam(key, value)) traits[key] = value;
      }
      id.traits = Object.keys(traits).length > 0 ? traits : null;
    }
  }
  if (event.payment !== null && event.payment.email !== null) {
    const clear = normalizeEmailKey(event.payment.email);
    if (email === null && clear !== null) email = clear;
    event.payment.email = landingEmailHash(event.payment.email);
  }
  event.data = withoutPii(event.data);
  if (email === null && phone === null && Object.keys(profile).length === 0) return null;
  return {
    v: 1,
    eid: event.eid,
    tenantId,
    siteId: event.site,
    visitorId: event.vid === '' ? null : event.vid,
    ts: event.ts,
    source: id !== null ? 'identify' : 'payment',
    email,
    phone,
    userId: id?.userId ?? null,
    profile,
  };
}
