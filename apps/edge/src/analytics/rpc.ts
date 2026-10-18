import type { AnalyticsDO } from './do';

/**
 * Addressing of AnalyticsDO instances — the only place that knows the naming.
 * Imported by apps/core too (via `@amable/app-edge/analytics`).
 */
export type AnalyticsNamespace = DurableObjectNamespace<AnalyticsDO>;

export function siteStub(ns: AnalyticsNamespace, siteId: string): DurableObjectStub<AnalyticsDO> {
  return ns.get(ns.idFromName(`site:${siteId}`));
}

export function tenantSitesStub(
  ns: AnalyticsNamespace,
  tenantId: string,
): DurableObjectStub<AnalyticsDO> {
  return ns.get(ns.idFromName(`tenant:${tenantId}`));
}

/** Public site ids: `st_` + 20 lowercase base32 chars. */
export const SITE_ID_RE = /^st_[a-z2-7]{20}$/;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function randomBase32(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}

export function newSiteId(): string {
  return `st_${randomBase32(20)}`;
}

/** Site secret for server SDKs: `amb_sk_<siteId>.<random>`; only its SHA-256 is stored. */
export function newSiteSecret(siteId: string): string {
  return `amb_sk_${siteId}.${randomBase32(40)}`;
}

/** Site id embedded in a site secret, or null when malformed. */
export function siteIdOfSecret(secret: string): string | null {
  const m = /^amb_sk_(st_[a-z2-7]{20})\.[a-z2-7]{40}$/.exec(secret);
  return m?.[1] ?? null;
}

/** Read/write analytics API key of one site: `amb_ak_<siteId>.<random>`; only its SHA-256 is stored. */
export function newSiteKey(siteId: string): string {
  return `amb_ak_${siteId}.${randomBase32(40)}`;
}

/** Site id embedded in a site API key, or null when malformed. */
export function siteIdOfSiteKey(key: string): string | null {
  const m = /^amb_ak_(st_[a-z2-7]{20})\.[a-z2-7]{40}$/.exec(key);
  return m?.[1] ?? null;
}

export type { AnalyticsDO } from './do';
export type {
  AnalyticsResult,
  SiteInit,
  SiteRecord,
  IngestResult,
  CrmFact,
  CrmApplyResult,
  CrmLinkSource,
  CoreWork,
  IdentityItem,
  AutomationItem,
  AlertItem,
  AlertTarget,
  ContactActivity,
  ContactVisitor,
  SyncCursor,
  ShareRow,
  IntegrationRow,
  IntegrationProviderId,
  AdSpendRow,
  SearchStatRow,
  VisitorListQuery,
} from './store/index';
export type {
  AdConnectionInput,
  AdConnectionRecord,
  AdEntityQuery,
  AdEntityRecord,
  AdSpendQuery,
} from './store/ad-entities';
export type { TouchQuery, ConversionInput, ConversionRecord, ConversionQuery } from './store/touches';
export type { OutboundEnqueueInput, OutboundOutcome, OutboundQuery } from './store/outbound';
export type { IdentityKeyRef } from './store/identity';
export type { UpdateFunnelGraphOutcome } from './store/funnel-graphs';
export { crmTransactionId } from './store/crm';
export { enrichServerEvent, type EdgeSiteConfig, type RequestContext } from './enrich';
export type { EnrichedEvent, BotHit } from './types';
export type { Channel } from './channels';
export { CRAWLER_LIST_VERSION } from './crawlers';
export { CRAWLER_RANGES_VERSION } from './crawler-ip';
