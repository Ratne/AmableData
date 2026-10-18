import type { FunnelGraph, FunnelTouch, TouchKind, TrafficSource } from '@amable/api-types';
import { isReservedUrlParam, type FunnelVisitContext } from '../funnel-engine';
import { geoFromCf, toMinor } from '../enrich';
import { parseUserAgent } from '../ua';

/** Funnel visitor id: query `vid`, this cookie, or a new one. */
export const VISITOR_COOKIE = 'amb_fvid';
export const VISITOR_COOKIE_MAX_AGE_S = 30 * 24 * 3600;

const VISITOR_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const OBJECT_ID_RE = /^[A-Za-z0-9_]{1,64}$/;

export const validVisitorId = (v: string | null | undefined): string | null =>
  v != null && VISITOR_ID_RE.test(v) ? v : null;
export const validNodeId = (v: string | null | undefined): string | null =>
  v != null && NODE_ID_RE.test(v) ? v : null;
export const validObjectId = (v: string | null | undefined): string | null =>
  v != null && OBJECT_ID_RE.test(v) ? v : null;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Hit id of a touch (the `hit` of postbacks): 26 lowercase base32 chars. */
export function newHitId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = '';
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}

export function newVisitorId(): string {
  return crypto.randomUUID();
}

// ------------------------------------------------------------ tracking fields

/** What a link hit tells about its traffic: stored fields and the never-stored data buffer. */
export interface CapturedTracking {
  campaign: string | null;
  external: string | null;
  /** Configured custom fields by slot (`c1`…`c20`): stored on the touches. */
  slots: Record<string, string>;
  /** The same values by field name, for `{data-name}` tokens and conditions. */
  names: Record<string, string>;
  /** Every non-reserved URL parameter of the hit: tokens only, never stored. */
  data: Record<string, string>;
}

const MAX_DATA_PARAMS = 50;

function clip(value: string | null, max: number): string | null {
  return value === null || value === '' ? null : value.slice(0, max);
}

/** Splits the URL parameters into the source's tracking fields and the data buffer. */
export function captureTracking(source: TrafficSource | null, params: URLSearchParams): CapturedTracking {
  const data: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.keys(data).length >= MAX_DATA_PARAMS) break;
    if (isReservedUrlParam(key) || key in data || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    data[key] = value.slice(0, 512);
  }
  const out: CapturedTracking = { campaign: null, external: null, slots: {}, names: {}, data };
  if (source === null) return out;
  out.campaign = clip(params.get(source.reserved_fields.campaign.url_param), 255);
  out.external = clip(params.get(source.reserved_fields.external.url_param), 512);
  for (const field of source.fields) {
    const value = clip(params.get(field.url_param), 512);
    if (value === null) continue;
    out.slots[field.slot] = value;
    out.names[field.name] = value;
  }
  return out;
}

/** Field names → values from stored slots (session of an action link). */
export function namesOfSlots(source: TrafficSource | null, slots: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (source === null || slots === null) return out;
  for (const field of source.fields) {
    const value = slots[field.slot];
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}

// ------------------------------------------------------------------- cost

const DECIMAL_RE = /^\d{1,9}(?:\.\d{1,9})?$/;

/**
 * Entrance cost in minor units: the link's `c=` (`0.004`, or `cpm_12.34` =
 * per mille), else the source default, else the funnel default; then the
 * source's incoming cost modifier. An unresolved platform macro counts as absent.
 */
export function entranceCostMinor(
  raw: string | null,
  source: TrafficSource | null,
  graph: Pick<FunnelGraph, 'default_cost_minor'> | null,
  currency: string,
): number | null {
  let cost: number | null = null;
  if (raw !== null) {
    const cpm = raw.toLowerCase().startsWith('cpm_');
    const value = cpm ? raw.slice(4) : raw;
    if (DECIMAL_RE.test(value)) cost = toMinor(Number(value) / (cpm ? 1000 : 1), currency);
  }
  if (cost === null && source?.cost_type !== 'none') {
    cost = source?.default_cost_minor ?? graph?.default_cost_minor ?? null;
  }
  if (cost === null) return null;
  const pct = source?.cost_modifier_pct ?? 0;
  return Math.max(0, Math.round(cost * (1 + pct / 100)));
}

// ---------------------------------------------------------- visit context

export interface RequestFacts {
  userAgent: string;
  cf: Record<string, unknown> | undefined;
  referrer: string | null;
  language: string | null;
}

export function requestFacts(raw: Request): RequestFacts {
  return {
    userAgent: raw.headers.get('user-agent') ?? '',
    cf: (raw as Request & { cf?: Record<string, unknown> }).cf,
    referrer: raw.headers.get('referer'),
    language: raw.headers.get('accept-language'),
  };
}

export interface VisitIds {
  hitId: string;
  visitorId: string;
  funnelId: string;
  trafficSourceId: string | null;
  timezone: string;
}

/** Condition attributes and token values of one link hit. */
export function visitContext(facts: RequestFacts, ids: VisitIds, tracking: CapturedTracking): FunnelVisitContext {
  const geo = geoFromCf(facts.cf);
  const ua = parseUserAgent(facts.userAgent);
  return {
    hitId: ids.hitId,
    visitorId: ids.visitorId,
    funnelId: ids.funnelId,
    trafficSourceId: ids.trafficSourceId,
    campaign: tracking.campaign,
    external: tracking.external,
    fields: tracking.names,
    slots: tracking.slots,
    data: tracking.data,
    country: geo.country,
    region: geo.region,
    city: geo.city,
    device: ua.device,
    browser: ua.browser,
    os: ua.os,
    language: facts.language,
    referrer: facts.referrer,
    timezone: ids.timezone,
  };
}

export interface TouchBase {
  ts: number;
  visitorId: string;
  sessionId: string;
  funnelId: string;
  trafficSourceId: string | null;
  campaign: string | null;
  external: string | null;
  slots: Record<string, string> | null;
}

export function touchOf(
  base: TouchBase,
  kind: TouchKind,
  id: string,
  nodeId: string,
  extra: { pageId?: string | null; action?: number | null; costMinor?: number | null; order?: number } = {},
): FunnelTouch {
  return {
    id,
    // Touches of one step are 1 ms apart so the click-log replays in order.
    ts: base.ts + (extra.order ?? 0),
    visitor_id: base.visitorId,
    session_id: base.sessionId,
    funnel_id: base.funnelId,
    node_id: nodeId,
    page_id: extra.pageId ?? null,
    traffic_source_id: base.trafficSourceId,
    kind,
    action_number: extra.action ?? null,
    campaign: base.campaign,
    external_click_id: base.external,
    fields: base.slots === null || Object.keys(base.slots).length === 0 ? null : base.slots,
    cost_minor: extra.costMinor ?? null,
  };
}
