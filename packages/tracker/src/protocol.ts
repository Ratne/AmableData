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
}
