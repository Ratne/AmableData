/** Event types of the tracker protocol (v1). */
export type EventType = 'pageview' | 'goal' | 'identify' | 'payment' | 'external_link';

/** Ad-platform click ids captured from the landing URL. */
export const CLICK_ID_PARAMS = [
  'gclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'twclid',
  'li_fat_id',
  'wbraid',
  'gbraid',
] as const;

/** Source/campaign params captured from the landing URL. */
export const SOURCE_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'source',
  'via',
] as const;

/** Signed contact identity appended by email click tracking (verified server-side). */
export const CONTACT_TOKEN_PARAM = '_amb_c';

/** Direct-link params of a funnel page URL: funnel, traffic source, node, page. */
export const DIRECT_LINK_PARAMS = ['f', 'ts', 'n', 'p'] as const;

/** Anchors with this attribute are action links even when the href is not `…/a/N`. */
export const ACTION_LINK_ATTR = 'data-amb-action';

/**
 * Goal name of `amable('conversion', …)`: sent as `type: 'goal'` with
 * `data: ConversionData` so the v1 ingest schema accepts it unchanged.
 */
export const CONVERSION_GOAL = 'conversion';

export interface ConversionData {
  /** Major units (12.99), like `payment.amount`. */
  value?: number;
  /** ISO 4217, upper case. */
  currency?: string;
  /** External transaction id (idempotency key). */
  tx?: string;
}

/**
 * Funnel context of the session: read from the landing URL (`f`, `ts`, `n`, `p`
 * and the funnel `vid` appended by entrance redirects) or set through
 * `amable('context', …)`; kept for the session and sent with every event.
 */
export interface DirectLink {
  f?: string;
  ts?: string;
  n?: string;
  p?: string;
  vid?: string;
}

/** Email/SMS link params of the landing URL (first pageview only). */
export interface LinkAttribution {
  /** Plain email (lower-cased) or SHA-256 hex (lower-cased). */
  he?: string;
  /** Custom source name. */
  sl?: string;
  /** Email source label. */
  el?: string;
}

export type ExtraValue = string | number | boolean;

/** Body of `POST /e` (sent as text/plain JSON to stay a CORS-simple request). */
export interface EventPayload {
  type: EventType;
  /** Public site id from `data-site`. */
  site: string;
  /** Full page URL (hash included only by the hash-routing build). */
  url: string;
  ref?: string;
  /** Viewport and screen size. */
  vw: number;
  vh: number;
  sw: number;
  sh: number;
  lang?: string;
  tz?: string;
  /** Visitor id, session id, visitor first-seen (ms) and session number — cookie builds only. */
  vid?: string;
  sid?: string;
  fs?: number;
  sn?: number;
  /** 1 = cookieless build: the server derives a daily visitor hash. */
  cl?: 1;
  clk?: Record<string, string>;
  src?: Record<string, string>;
  /** Goal name (type goal). */
  name?: string;
  /** Goal params, identify traits, payment fields, external link target. */
  data?: Record<string, ExtraValue>;
  /** `_amb_c` contact token of the landing URL (first pageview only). */
  ct?: string;
  /** Direct-link context (every event once known). */
  dl?: DirectLink;
  /** `he` / `sl` / `el` of the landing URL (first pageview only). */
  la?: LinkAttribution;
}
