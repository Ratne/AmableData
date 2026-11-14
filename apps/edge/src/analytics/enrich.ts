import { isUnfilledMacro, type ServerEvent, type TrackerEvent } from '@amable/api-types';
import { classifyChannel } from './channels';
import { cookielessVisitorId, ipUaHash } from './cookieless';
import { deviceSighting } from './device-signals';
import { landingEmailHash } from './store/identity';
import { parseUserAgent } from './ua';
import type { AdIds, EnrichedEvent, ExtraValue, Geo, IdentityData, PaymentData } from './types';

/** What the edge needs to know about a site (cached per isolate). */
export interface EdgeSiteConfig {
  siteId: string;
  tenantId: string;
  hostnames: readonly string[];
  cookieless: boolean;
  /** Device signals module on (never on a cookieless site); events of the module are dropped otherwise. */
  deviceSignals?: boolean;
  allowLocalhost: boolean;
  currency: string;
  /** Hot window of raw rows in the site DO: older events stop at the age barrier. */
  retentionDays: number;
  /** SHA-256 hex of the site secret, null when none was issued. */
  secretHash: string | null;
  /** Today's cookieless salt (UTC day). */
  salt: { day: string; value: string };
  /** Newest tombstones (visitor ids, identity hashes): dropped before the archive. */
  suppressed: { visitors: readonly string[]; keys: readonly string[] };
}

export interface RequestContext {
  eid: string;
  now: number;
  /** When the event happened (client envelope, clamped); defaults to `now`. */
  ts?: number;
  ip: string;
  userAgent: string;
  geo: Geo;
  /** How the event reached the edge (browser ingest only). */
  collector?: Collector;
  /**
   * The event is not known to come straight from the browser (rewrite recipes,
   * a proxy without the key or a usable address): `ip` may be a server's.
   */
  relayed?: boolean;
}

export type Collector = 'first_party' | 'third_party' | 'proxy';

/** Client clocks ahead of the edge by more than this are ignored. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Event time from the client envelope: never in the future (beyond the skew,
 * the edge clock wins). Old values are kept as they are: the consumer's age
 * barrier decides whether they may still touch the site DO.
 */
export function occurredAt(at: number | string | undefined, now: number): number {
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return now;
  return ms > now + MAX_FUTURE_SKEW_MS ? now : Math.min(ms, now);
}

/**
 * Dedupe key of an event: the client id when present (stable across retries
 * and offline replays), scoped so tracker and server ids never collide; a fresh
 * id otherwise.
 */
export function eventIdOf(
  source: 'tracker' | 'server',
  type: string,
  clientId: string | undefined,
): string {
  if (clientId === undefined) return crypto.randomUUID();
  return source === 'tracker' ? `t:${clientId}` : `s:${type}:${clientId}`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** A hostname matches an entry when equal to it or one of its subdomains. */
export function hostAllowed(
  host: string,
  site: Pick<EdgeSiteConfig, 'hostnames' | 'allowLocalhost'>,
): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (LOCAL_HOSTS.has(h) || h.endsWith('.localhost')) return site.allowLocalhost;
  return site.hostnames.some((entry) => h === entry || h.endsWith(`.${entry}`));
}

/** Geo fields from `request.cf` (absent locally and in tests). */
export function geoFromCf(cf: Record<string, unknown> | undefined): Geo {
  const str = (k: string): string | null => {
    const v = cf?.[k];
    return typeof v === 'string' && v !== '' ? v : null;
  };
  const num = (k: string): number | null => {
    const v = Number(cf?.[k]);
    return cf?.[k] === undefined || !Number.isFinite(v) ? null : v;
  };
  const country = str('country');
  return {
    country: country === 'XX' || country === 'T1' ? null : country,
    region: str('region'),
    city: str('city'),
    latitude: num('latitude'),
    longitude: num('longitude'),
  };
}

function parseUrl(raw: string | null | undefined): URL | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Page path; the hash is kept only for hash-routed apps (`#/…`). */
function pathOf(u: URL): string {
  const hash = u.hash.startsWith('#/') ? (u.hash.split('?')[0] ?? '') : '';
  return `${u.pathname || '/'}${hash}`.slice(0, 1024);
}

const digitsByCurrency = new Map<string, number>();

function fractionDigits(currency: string): number {
  let digits = digitsByCurrency.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    if (digitsByCurrency.size < 500) digitsByCurrency.set(currency, digits);
  }
  return digits;
}

/** Major units (e.g. 19.99 EUR) to minor units (1999). */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** fractionDigits(currency));
}

const truthy = (v: ExtraValue | undefined): boolean =>
  v === true || v === 'true' || v === '1' || v === 1;
const text = (v: ExtraValue | undefined, max = 255): string | null =>
  v === undefined || v === '' ? null : String(v).slice(0, max);

/** Payment fields sent by the browser tracker as goal-style string params. */
export function paymentFromData(data: Record<string, ExtraValue> | undefined): PaymentData | null {
  if (data === undefined) return null;
  const amount = Number(data['amount']);
  const currency = String(data['currency'] ?? '').toUpperCase();
  const transactionId = text(data['transaction_id']);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !/^[A-Z]{3}$/.test(currency) ||
    transactionId === null
  )
    return null;
  return {
    amountMinor: toMinor(amount, currency),
    currency,
    transactionId,
    email: text(data['email'], 320),
    customerId: text(data['customer_id']),
    renewal: truthy(data['renewal']),
    refunded: truthy(data['refunded']),
    freeTrial: truthy(data['is_free_trial']) || truthy(data['free_trial']),
  };
}

export function identityFromData(
  data: Record<string, ExtraValue> | undefined,
): IdentityData | null {
  if (data === undefined) return null;
  const { user_id, email, name, ...rest } = data;
  const userId = text(user_id);
  const mail = text(email, 320);
  // A phone-only identify (form capture) keeps the phone in the traits.
  if (userId === null && mail === null && text(rest['phone'], 64) === null) return null;
  return {
    userId,
    email: mail === null ? null : mail.toLowerCase(),
    name: text(name),
    traits: Object.keys(rest).length > 0 ? rest : null,
  };
}

interface Attribution {
  url: URL | null;
  referrer: string | null;
  src: Record<string, string> | undefined;
  clk: Record<string, string> | undefined;
}

function baseEvent(
  site: EdgeSiteConfig,
  ctx: RequestContext,
  type: EnrichedEvent['type'],
  a: Attribution,
): Omit<EnrichedEvent, 'vid' | 'sid' | 'firstSeen' | 'sessionNumber' | 'cookieless' | 'server'> {
  const ua = parseUserAgent(ctx.userAgent);
  const ref = parseUrl(a.referrer);
  const refHost = ref?.hostname.toLowerCase() ?? null;
  // Internal navigation (same site) is not a referrer.
  const externalRefHost =
    refHost !== null && !hostAllowed(refHost, { hostnames: site.hostnames, allowLocalhost: true })
      ? refHost
      : null;
  const params = a.url?.searchParams;
  // Unfilled ad macros (`{{campaign.name}}` of preview clicks) are no value.
  const src = (k: string): string | null => {
    const v = a.src?.[k] ?? params?.get(k) ?? null;
    return v !== null && isUnfilledMacro(v) ? null : v;
  };
  const clickIds = a.clk !== undefined && Object.keys(a.clk).length > 0 ? a.clk : null;
  const channel = classifyChannel({
    referrerHost: externalRefHost,
    utmSource: src('utm_source'),
    utmMedium: src('utm_medium'),
    ref: src('ref'),
    source: src('source'),
    via: src('via'),
    clickIds,
  });
  return {
    eid: ctx.eid,
    ts: ctx.ts ?? ctx.now,
    site: site.siteId,
    type,
    url: a.url?.toString().slice(0, 2048) ?? null,
    hostname: a.url?.hostname.toLowerCase() ?? null,
    path: a.url === null ? null : pathOf(a.url),
    referrer: externalRefHost === null ? null : (a.referrer ?? '').slice(0, 2048),
    referrerHost: externalRefHost,
    channel: channel.channel,
    paid: channel.paid,
    source: channel.source,
    utm: {
      source: src('utm_source'),
      medium: src('utm_medium'),
      campaign: src('utm_campaign'),
      term: src('utm_term'),
      content: src('utm_content'),
    },
    clickIds,
    ad: adIds(src),
    geo: ctx.geo,
    device: ua.device,
    browser: ua.browser,
    os: ua.os,
    language: null,
    screenWidth: null,
    name: null,
    data: null,
    payment: null,
    identity: null,
  };
}

/** Enriches a browser tracker event. Returns null when the payload is unusable. */
export async function enrichTrackerEvent(
  payload: TrackerEvent,
  site: EdgeSiteConfig,
  ctx: RequestContext,
): Promise<EnrichedEvent | null> {
  const url = parseUrl(payload.url);
  if (url === null) return null;
  const base = baseEvent(site, ctx, payload.type, {
    url,
    referrer: payload.ref ?? null,
    src: payload.src,
    clk: payload.clk,
  });
  const cookieless = site.cookieless || payload.cl === 1 || payload.vid === undefined;
  if (payload.type === 'device' && (cookieless || site.deviceSignals !== true)) return null;
  const vid = cookieless
    ? await cookielessVisitorId(site.salt.value, site.siteId, ctx.ip, ctx.userAgent)
    : (payload.vid ?? '');
  const event: EnrichedEvent = {
    ...base,
    server: false,
    vid,
    sid: cookieless ? null : (payload.sid ?? null),
    firstSeen: cookieless ? null : (payload.fs ?? null),
    sessionNumber: cookieless ? null : (payload.sn ?? null),
    cookieless,
    language: payload.lang?.slice(0, 35) ?? null,
    screenWidth: payload.sw ?? null,
    collector: ctx.collector ?? null,
    ipUa:
      cookieless || payload.type !== 'pageview'
        ? null
        : await ipUaHash(site.salt.value, site.siteId, ctx.ip, ctx.userAgent),
  };
  switch (payload.type) {
    case 'goal': {
      const name = (payload.name ?? '').toLowerCase();
      if (!/^[a-z0-9_]{1,64}$/.test(name)) return null;
      event.name = name;
      event.data = payload.data ?? null;
      break;
    }
    case 'payment':
      event.payment = paymentFromData(payload.data);
      if (event.payment === null) return null;
      break;
    case 'identify':
      event.identity = identityFromData(payload.data);
      if (event.identity === null) return null;
      break;
    case 'device':
      event.deviceSighting = await deviceSighting(payload.data, {
        siteId: site.siteId,
        key: site.secretHash ?? site.siteId,
        // A server's address is everybody's network: the signals are kept, the rule sits out.
        ip: ctx.relayed === true ? '' : ctx.ip,
        ...(payload.sw === undefined ? {} : { sw: payload.sw }),
        ...(payload.sh === undefined ? {} : { sh: payload.sh }),
        ...(payload.tz === undefined ? {} : { tz: payload.tz }),
      });
      if (event.deviceSighting === null) return null;
      break;
    case 'external_link': {
      const target = parseUrl(
        typeof payload.data?.['url'] === 'string' ? payload.data['url'] : null,
      );
      if (target === null) return null;
      event.data = { url: target.toString().slice(0, 1024), host: target.hostname.toLowerCase() };
      break;
    }
    case 'pageview':
      if (payload.ct !== undefined && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(payload.ct)) {
        event.contactToken = payload.ct;
      }
      applyLandingParams(event, payload.la);
      break;
  }
  return event;
}

const LANDING_LABEL = /^[\p{L}\p{N} _.:@-]{1,64}$/u;

function landingLabel(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^@+/, '').replace(/\s+/g, ' ').slice(0, 64);
  return LANDING_LABEL.test(v) ? v : null;
}

/**
 * Email/SMS link params of a landing pageview, from the tracker (`la`) or the
 * page URL: `he` becomes the SHA-256 identity key and is removed from the
 * stored URL; `el` puts the session on the Email channel with source
 * `@<label>`, `sl` sets the source `@<name>` (an otherwise direct visit
 * becomes a referral).
 */
function applyLandingParams(event: EnrichedEvent, la: TrackerEvent['la']): void {
  if (event.type !== 'pageview') return;
  const url = parseUrl(event.url);
  const q = url?.searchParams;
  const he = la?.he ?? q?.get('he') ?? null;
  const sourceLabel = landingLabel(la?.sl ?? q?.get('sl'));
  const emailLabel = landingLabel(la?.el ?? q?.get('el'));
  if (url !== null && q?.has('he') === true) {
    q.delete('he');
    event.url = url.toString().slice(0, 2048);
  }
  const emailHash = he === null || he === '' ? null : landingEmailHash(he);
  if (emailHash === null && sourceLabel === null && emailLabel === null) return;
  event.landing = { emailHash, sourceLabel, emailLabel };
  if (emailLabel !== null) {
    event.channel = 'Email';
    event.source = `@${emailLabel}`;
  } else if (sourceLabel !== null) {
    event.source = `@${sourceLabel}`;
    if (event.channel === 'Direct') event.channel = 'Referral';
  }
}

/** Funnel page reached directly from an ad (`?f=…&ts=…&n=…[&p=…]`, no redirect). */
export interface DirectLinkView {
  funnelId: string;
  trafficSourceId: string;
  nodeId: string;
  pageId: string | null;
  /** Funnel visitor id: the tracker visitor of the page. */
  visitorId: string;
  sessionId: string;
  url: URL;
}

/**
 * Direct-link landing of a browser pageview. The tracker resends its funnel
 * context with every event, so only the landing itself counts: the page URL
 * must carry `f` and `ts`, and no `vid` (pages reached through an entrance
 * redirect already have their view).
 */
export function directLinkView(payload: TrackerEvent): DirectLinkView | null {
  const dl = payload.dl;
  if (
    payload.type !== 'pageview' ||
    dl?.f === undefined ||
    dl.ts === undefined ||
    dl.n === undefined
  )
    return null;
  if (payload.vid === undefined || payload.cl === 1) return null;
  const url = parseUrl(payload.url);
  if (url === null) return null;
  const q = url.searchParams;
  if (q.get('f') !== dl.f || q.get('ts') !== dl.ts || q.has('vid')) return null;
  return {
    funnelId: dl.f,
    trafficSourceId: dl.ts,
    nodeId: dl.n,
    pageId: dl.p ?? null,
    visitorId: payload.vid,
    sessionId: payload.sid ?? payload.vid,
    url,
  };
}

/** Enriches a server SDK event (`crawler` is handled before, as a bot hit). */
export async function enrichServerEvent(
  payload: Exclude<ServerEvent, { type: 'crawler' }>,
  site: EdgeSiteConfig,
  ctx: RequestContext,
): Promise<EnrichedEvent> {
  const url = 'url' in payload ? parseUrl(payload.url) : null;
  const referrer = payload.type === 'pageview' ? (payload.referrer ?? null) : null;
  const base = baseEvent(site, ctx, payload.type, {
    url,
    referrer,
    src: undefined,
    clk: undefined,
  });
  // A payment without visitor id is attributed by email in the DO ('' = unknown visitor).
  const vid =
    payload.visitor_id ??
    (payload.type === 'payment'
      ? ''
      : await cookielessVisitorId(site.salt.value, site.siteId, ctx.ip, ctx.userAgent));
  const event: EnrichedEvent = {
    ...base,
    server: true,
    vid,
    sid: null,
    firstSeen: null,
    sessionNumber: null,
    cookieless: payload.visitor_id === undefined,
  };
  if (payload.type !== 'pageview') {
    // Server-side calls carry the server's own UA/IP: no device or geo for the visitor.
    event.device = null;
    event.browser = null;
    event.os = null;
    event.geo = { country: null, region: null, city: null, latitude: null, longitude: null };
  }
  switch (payload.type) {
    case 'goal':
      event.name = payload.name;
      event.data = payload.params ?? null;
      break;
    case 'payment':
      event.payment = {
        amountMinor: toMinor(payload.amount, payload.currency),
        currency: payload.currency,
        transactionId: payload.transaction_id,
        email: payload.email?.toLowerCase() ?? null,
        customerId: payload.customer_id ?? null,
        renewal: payload.renewal ?? false,
        refunded: payload.refunded ?? false,
        freeTrial: payload.is_free_trial ?? false,
      };
      break;
    case 'identify':
      event.identity = {
        userId: payload.user_id,
        email: payload.email?.toLowerCase() ?? null,
        name: payload.name ?? null,
        traits: payload.traits ?? null,
      };
      break;
    case 'pageview':
      applyLandingParams(event, undefined);
      break;
  }
  return event;
}

/** Ad ids of the landing params; unfilled macros (previews, wrong field) are dropped. */
export function adIds(src: (k: string) => string | null): AdIds | null {
  const id = (k: string, max = 64): string | null => {
    const v = src(k)?.trim();
    return v === undefined || v === '' || isUnfilledMacro(v) ? null : v.slice(0, max);
  };
  const ad: AdIds = {
    campaignId: id('amb_cid') ?? id('utm_id'),
    adSetId: id('amb_asid'),
    adId: id('amb_adid'),
    placement: id('amb_pl'),
    keyword: id('amb_kw', 255),
    network: id('amb_net'),
  };
  return Object.values(ad).some((v) => v !== null) ? ad : null;
}
