import type { AnalyticsEventType } from '@amable/api-types';
import type { Channel } from './channels';
import type { BotCategory } from './crawlers';
import type { DeviceType } from './ua';

export type ExtraValue = string | number | boolean;

export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PaymentData {
  amountMinor: number;
  currency: string;
  transactionId: string;
  email: string | null;
  customerId: string | null;
  renewal: boolean;
  refunded: boolean;
  freeTrial: boolean;
}

export interface IdentityData {
  userId: string | null;
  email: string | null;
  name: string | null;
  traits: Record<string, ExtraValue> | null;
}

/** One event after edge enrichment — the unit carried by the `analytics` queue. */
export interface EnrichedEvent {
  /** Unique id assigned at the edge (dedupes at-least-once queue delivery). */
  eid: string;
  ts: number;
  site: string;
  type: AnalyticsEventType;
  /** Sent by a server SDK (`/e/server`) rather than the browser tracker. */
  server: boolean;
  vid: string;
  /** Null for cookieless and server events: the DO sessionizes by inactivity. */
  sid: string | null;
  firstSeen: number | null;
  sessionNumber: number | null;
  cookieless: boolean;
  url: string | null;
  hostname: string | null;
  path: string | null;
  referrer: string | null;
  referrerHost: string | null;
  channel: Channel;
  paid: boolean;
  source: string | null;
  utm: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
    term: string | null;
    content: string | null;
  };
  clickIds: Record<string, string> | null;
  geo: Geo;
  device: DeviceType | null;
  browser: string | null;
  os: string | null;
  language: string | null;
  screenWidth: number | null;
  /** Goal name (goal events). */
  name: string | null;
  /** Goal params / external link target. */
  data: Record<string, ExtraValue> | null;
  payment: PaymentData | null;
  identity: IdentityData | null;
  /**
   * Signed contact token (`_amb_c` of an email click) seen on the landing page.
   * Never verified at the edge: the core verifies it (it holds the signing
   * secret) when it drains the site's identity queue.
   */
  contactToken?: string | null;
  /** Email/SMS link params of the landing page (`he`, `sl`, `el`). */
  landing?: LandingParams | null;
}

export interface LandingParams {
  /** SHA-256 of the normalized `he` email: the clear address is never kept. */
  emailHash: string | null;
  /** `sl`: custom source name, reported as `@<name>`. */
  sourceLabel: string | null;
  /** `el`: email/SMS source label (`email`, a campaign name…), reported as `@<label>` on the Email channel. */
  emailLabel: string | null;
}

/** A request recognised as a bot or crawler (aggregated, never a visitor). */
export interface BotHit {
  site: string;
  ts: number;
  name: string;
  provider: string;
  category: BotCategory;
  path: string;
  /** IP check against the provider's published ranges (absent = not checked). */
  verification?: 'verified' | 'spoofed' | 'unknown';
}

export type AnalyticsMessage =
  { kind: 'event'; event: EnrichedEvent } | { kind: 'bot'; hit: BotHit };
