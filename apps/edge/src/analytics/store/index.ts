import type {
  AdEntity,
  AdPlatform,
  AdSpendDay,
  AdsReport,
  Alert,
  AnalyticsBreakdown,
  AnalyticsBreakdownDimension,
  AnalyticsInsights,
  AnalyticsInterval,
  AnalyticsOverview,
  AnalyticsPurchase,
  AnalyticsRange,
  AnalyticsRealtime,
  AnalyticsTimeseries,
  AttributionDimension,
  AttributionModel,
  AttributionReport,
  BotsReport,
  CreateAlertInput,
  CreateFunnelInput,
  CreateSegmentInput,
  Funnel,
  FunnelGraph,
  FunnelGraphInput,
  FunnelGraphSummary,
  FunnelGraphUpdate,
  FunnelResult,
  FunnelStatus,
  FunnelTouch,
  IdentityKey,
  IdentityKeyType,
  InstallCheck,
  OutboundConversionJob,
  PredictionModelInfo,
  SearchConsoleReport,
  Segment,
  SiteKey,
  SiteKeyScope,
  TrafficSource,
  TrafficSourceInput,
  UpdateAlertInput,
  UpdateFunnelInput,
  UpdateSegmentInput,
  UpdateSiteInput,
  VisitorProfile,
  VisitorsList,
} from '@amable/api-types';
import {
  adEntitySchema,
  adSpendDaySchema,
  analyticsRangeSchema,
  ATTRIBUTION_MODELS,
  funnelGraphInputSchema,
  funnelGraphUpdateSchema,
  funnelTouchSchema,
  identityKeySchema,
  trafficSourceInputSchema,
} from '@amable/api-types';
import type { z } from 'zod';
import * as adData from './ad-entities';
import * as funnelGraphs from './funnel-graphs';
import * as identity from './identity';
import * as outbound from './outbound';
import * as touches from './touches';
import * as trafficSources from './traffic-sources';
import { attributeRevenue, attributeRevenueByModel, isAttributionDimension } from './attribution';
import {
  adsReport,
  botsReport,
  getIntegration,
  listIntegrations,
  removeIntegration,
  saveIntegration,
  searchConsoleReport,
  storeAdSpend,
  storeSearchStats,
  type AdSpendRow,
  type IntegrationProviderId,
  type IntegrationRow,
  type SearchStatRow,
} from './bots';
import * as config from './config';
import {
  ackCoreWork,
  applyCrmFacts,
  knownVisitors,
  pendingCoreWork,
  pullCoreWork,
  recordAlertDelivery,
  type CoreWork,
  type CrmApplyResult,
  type CrmFact,
} from './crm';
import { funnelResult } from './funnels';
import { insights } from './insights';
import { loadModel, modelInfo, trainSiteModel } from './prediction';
import { realtimeSnapshot } from './realtime';
import * as registry from './registry';
import {
  contactActivity,
  listVisitors,
  purchases,
  visitorProfile,
  type ContactActivity,
  type VisitorListQuery,
} from './visitors';
import type { SqlDb } from '../db/sql';
import type { EdgeSiteConfig } from '../enrich';
import type { BotHit, EnrichedEvent } from '../types';
import { ingestBatch, type IngestResult } from './ingest';
import { breakdown, overview, resolveRange, timeseries, type ResolvedRange } from './query';
import { runRetention, type ArchiveSink, type RetentionResult } from './retention';
import { refreshRollups } from './rollups';
import {
  deleteSite,
  edgeConfig,
  getSiteRecord,
  indexAdd,
  indexList,
  indexRemove,
  initSite,
  setSecretHash,
  updateSite,
  type SiteInit,
  type SiteRecord,
} from './site';

export type { SiteInit, SiteRecord } from './site';
export type { IngestResult } from './ingest';
export type { ArchiveSink, RetentionResult } from './retention';
export type { CrmFact, CrmApplyResult, CoreWork, IdentityItem, AutomationItem, AlertItem, AlertTarget, CrmLinkSource } from './crm';
export type { ContactActivity, VisitorListQuery } from './visitors';
export type { StoredAlert, ShareRow } from './config';
export type { IntegrationRow, IntegrationProviderId, AdSpendRow, SearchStatRow } from './bots';
export type { ContactVisitor, SyncCursor } from './registry';
export { crmTransactionId } from './crm';
export type { AdConnectionInput, AdConnectionRecord, AdEntityQuery, AdEntityRecord, AdSpendQuery } from './ad-entities';
export type { ConversionInput, ConversionQuery, ConversionRecord, ConversionStatus, TouchQuery } from './touches';
export type { OutboundEnqueueInput, OutboundOutcome, OutboundQuery } from './outbound';
export type { IdentityKeyRef } from './identity';

export type AnalyticsResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: 'not_found' | 'invalid_range' | 'validation_failed' | 'conflict'; message: string };
    };

/** Parses `input` with a contract schema, as an AnalyticsResult. */
function parse<S extends z.ZodType>(schema: S, input: unknown): AnalyticsResult<z.output<S>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
  return { ok: false, error: { code: 'validation_failed', message: `${path}${issue?.message ?? 'invalid input'}` } };
}

/** Parses every item; the first invalid one fails the whole batch. */
function parseAll<S extends z.ZodType>(schema: S, items: readonly unknown[]): AnalyticsResult<z.output<S>[]> {
  const out: z.output<S>[] = [];
  for (const [i, item] of items.entries()) {
    const r = parse(schema, item);
    if (!r.ok) return { ok: false, error: { ...r.error, message: `[${i}] ${r.error.message}` } };
    out.push(r.value);
  }
  return { ok: true, value: out };
}

const notFound = (what: string): AnalyticsResult<never> => ({
  ok: false,
  error: { code: 'not_found', message: `${what} not found` },
});

/**
 * Everything one AnalyticsDO instance can do, over the synchronous SQL port.
 * The DO delegates every RPC here; tests drive it on node:sqlite.
 */
export class AnalyticsStore {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  // --- site configuration (site:<id> instances)
  initSite(init: SiteInit): SiteRecord {
    return this.db.transaction(() => initSite(this.db, init, this.now()));
  }

  getSite(): SiteRecord | null {
    return getSiteRecord(this.db);
  }

  updateSite(patch: UpdateSiteInput): SiteRecord | null {
    return this.db.transaction(() => updateSite(this.db, patch, this.now()));
  }

  setSecretHash(hash: string): boolean {
    return setSecretHash(this.db, hash, this.now());
  }

  deleteSite(): boolean {
    return deleteSite(this.db, this.now());
  }

  edgeConfig(): EdgeSiteConfig | null {
    return this.db.transaction(() => edgeConfig(this.db, this.now()));
  }

  // --- ingest
  ingest(events: readonly EnrichedEvent[], bots: readonly BotHit[]): IngestResult {
    const site = getSiteRecord(this.db);
    if (site === null)
      return { ingested: 0, duplicates: 0, skipped: events.length, bots: 0, pending: false, live: [] };
    const result = ingestBatch(this.db, events, bots, { currency: site.site.currency });
    refreshRollups(this.db, site.site.timezone, site.site.currency);
    return result;
  }

  // --- queries
  private range(
    input: AnalyticsRange,
  ): AnalyticsResult<{ range: ResolvedRange; site: SiteRecord }> {
    const site = getSiteRecord(this.db);
    if (site === null || site.deleted)
      return { ok: false, error: { code: 'not_found', message: 'site not found' } };
    const parsed = analyticsRangeSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'validation_failed',
          message: parsed.error.issues[0]?.message ?? 'invalid query',
        },
      };
    }
    try {
      return { ok: true, value: { range: resolveRange(parsed.data, site.site.timezone), site } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'invalid_range',
          message: error instanceof Error ? error.message : 'invalid range',
        },
      };
    }
  }

  overview(input: AnalyticsRange): AnalyticsResult<AnalyticsOverview> {
    const r = this.range(input);
    if (!r.ok) return r;
    return {
      ok: true,
      value: overview(this.db, r.value.range, r.value.site.site.currency, this.now()),
    };
  }

  timeseries(
    input: AnalyticsRange,
    interval: AnalyticsInterval,
  ): AnalyticsResult<AnalyticsTimeseries> {
    const r = this.range(input);
    if (!r.ok) return r;
    const { site } = r.value;
    return {
      ok: true,
      value: timeseries(this.db, r.value.range, interval, site.site.timezone, site.site.currency),
    };
  }

  breakdown(
    input: AnalyticsRange,
    dimension: AnalyticsBreakdownDimension,
    limit = 50,
    model?: AttributionModel,
  ): AnalyticsResult<AnalyticsBreakdown> {
    const r = this.range(input);
    if (!r.ok) return r;
    const max = Math.min(Math.max(limit, 1), 1000);
    if (!isAttributionDimension(dimension)) {
      return { ok: true, value: breakdown(this.db, r.value.range, dimension, max, r.value.site.site.currency) };
    }
    // All values first: credited revenue may belong to values outside the top rows.
    const result = breakdown(this.db, r.value.range, dimension, 1000);
    const site = r.value.site.site;
    const used = model ?? site.attribution_model;
    const credited = attributeRevenue(this.db, r.value.range, dimension, used, site.currency);
    const seen = new Set<string | null>();
    for (const row of result.rows) {
      const c = credited.get(row.value);
      row.revenue_minor = c?.revenue ?? 0;
      row.conversions = c?.conversions ?? 0;
      seen.add(row.value);
    }
    // Values credited by older touches (sessions before the range) still get their revenue.
    for (const [value, c] of credited) {
      if (seen.has(value) || c.revenue === 0) continue;
      result.rows.push({ value, visitors: 0, sessions: 0, revenue_minor: c.revenue, conversions: c.conversions });
    }
    return { ok: true, value: { ...result, rows: result.rows.slice(0, max), model: used } };
  }

  /** Revenue credited to the values of one source dimension, per attribution model. */
  attribution(
    input: AnalyticsRange,
    dimension: AttributionDimension = 'channel',
    models: readonly AttributionModel[] = ATTRIBUTION_MODELS,
    limit = 50,
  ): AnalyticsResult<AttributionReport> {
    const r = this.range(input);
    if (!r.ok) return r;
    const site = r.value.site.site;
    const used = models.length === 0 ? ATTRIBUTION_MODELS : models;
    const pass = attributeRevenueByModel(this.db, r.value.range, dimension, used, site.currency);
    const values = new Map<string | null, number>();
    for (const out of pass.byModel.values()) {
      for (const [value, v] of out) values.set(value, Math.max(values.get(value) ?? 0, v.revenue));
    }
    const rows = [...values.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, Math.min(Math.max(limit, 1), 1000))
      .map(([value]) => ({
        value,
        credits: used.map((model) => {
          const v = pass.byModel.get(model)?.get(value);
          return { model, revenue_minor: v?.revenue ?? 0, conversions: v?.conversions ?? 0 };
        }),
      }));
    return {
      ok: true,
      value: {
        dimension,
        currency: site.currency,
        models: [...used],
        default_model: site.attribution_model,
        total_revenue_minor: pass.totalRevenue,
        total_conversions: pass.totalConversions,
        rows,
      },
    };
  }

  // --- second wave: attribution, insights, visitors, realtime, saved objects

  private site(): SiteRecord | null {
    const site = getSiteRecord(this.db);
    return site === null || site.deleted ? null : site;
  }

  purchases(input: AnalyticsRange, limit: number, anonymous = false): AnalyticsResult<{ currency: string; data: AnalyticsPurchase[] }> {
    const r = this.range(input);
    if (!r.ok) return r;
    return {
      ok: true,
      value: {
        currency: r.value.site.site.currency,
        data: purchases(this.db, r.value.range, Math.min(Math.max(limit, 1), 500), anonymous),
      },
    };
  }

  insights(input: AnalyticsRange, interval: 'week' | 'month'): AnalyticsResult<AnalyticsInsights> {
    const r = this.range(input);
    if (!r.ok) return r;
    return { ok: true, value: insights(this.db, r.value.range, r.value.site.site.currency, interval) };
  }

  visitors(input: AnalyticsRange, query: VisitorListQuery): AnalyticsResult<VisitorsList> {
    const r = this.range(input);
    if (!r.ok) return r;
    return {
      ok: true,
      value: listVisitors(this.db, r.value.range, query, r.value.site.site.currency, this.now()),
    };
  }

  visitorProfile(visitorId: string): VisitorProfile | null {
    const site = this.site();
    if (site === null) return null;
    return visitorProfile(this.db, visitorId, site.site.currency, site.site.timezone, this.now());
  }

  contactActivity(contactId: string, limit: number): ContactActivity | null {
    const site = this.site();
    if (site === null) return null;
    return contactActivity(this.db, site.site.id, contactId, site.site.currency, limit, this.now());
  }

  realtime(): AnalyticsRealtime | null {
    const site = this.site();
    if (site === null) return null;
    return realtimeSnapshot(this.db, site.site.id, site.site.currency, this.now());
  }

  installCheck(): InstallCheck | null {
    const site = this.site();
    if (site === null) return null;
    const since = this.now() - 86_400_000;
    const n = (sql: string): number => this.db.all<{ n: number }>(sql, since)[0]?.n ?? 0;
    const events =
      n(`SELECT COUNT(*) AS n FROM pageviews WHERE ts >= ?`) + n(`SELECT COUNT(*) AS n FROM goals WHERE ts >= ?`);
    return {
      site_id: site.site.id,
      receiving: site.lastEventAt !== null && site.lastEventAt >= since,
      last_event_at: site.lastEventAt === null ? null : new Date(site.lastEventAt).toISOString(),
      last_event_url: site.lastEventUrl,
      events_24h: events,
      has_secret: site.site.has_secret,
      hostnames: site.site.hostnames,
    };
  }

  bots(input: AnalyticsRange): AnalyticsResult<BotsReport> {
    const r = this.range(input);
    if (!r.ok) return r;
    return { ok: true, value: botsReport(this.db, r.value.range) };
  }

  // funnels
  listFunnels(): Funnel[] {
    return config.listFunnels(this.db);
  }
  getFunnel(id: string): Funnel | null {
    return config.getFunnel(this.db, id);
  }
  createFunnel(input: CreateFunnelInput): Funnel {
    return config.createFunnel(this.db, input, this.now());
  }
  updateFunnel(id: string, patch: UpdateFunnelInput): Funnel | null {
    return config.updateFunnel(this.db, id, patch, this.now());
  }
  deleteFunnel(id: string): boolean {
    return config.deleteFunnel(this.db, id);
  }
  funnelResult(id: string, input: AnalyticsRange): AnalyticsResult<FunnelResult> {
    const r = this.range(input);
    if (!r.ok) return r;
    const funnel = config.getFunnel(this.db, id);
    if (funnel === null) return { ok: false, error: { code: 'not_found', message: 'funnel not found' } };
    return { ok: true, value: funnelResult(this.db, funnel, r.value.range) };
  }

  // segments
  listSegments(): Segment[] {
    return config.listSegments(this.db);
  }
  createSegment(input: CreateSegmentInput): Segment {
    return config.createSegment(this.db, input, this.now());
  }
  updateSegment(id: string, patch: UpdateSegmentInput): Segment | null {
    return config.updateSegment(this.db, id, patch, this.now());
  }
  deleteSegment(id: string): boolean {
    return config.deleteSegment(this.db, id);
  }

  // alerts
  listAlerts(): Alert[] {
    return config.listAlerts(this.db, this.now()).map(config.publicAlert);
  }
  createAlert(input: CreateAlertInput, webhookSecret: string | null): { alert: Alert; webhook_secret: string | null } {
    const a = config.createAlert(this.db, input, webhookSecret, this.now());
    return { alert: config.publicAlert(a), webhook_secret: a.webhook_secret };
  }
  updateAlert(id: string, patch: UpdateAlertInput, webhookSecret: string | null): { alert: Alert; webhook_secret: string | null } | null {
    const r = config.updateAlert(this.db, id, patch, webhookSecret, this.now());
    return r === null ? null : { alert: config.publicAlert(r.alert), webhook_secret: r.newSecret };
  }
  deleteAlert(id: string): boolean {
    return config.deleteAlert(this.db, id);
  }
  testAlert(id: string): boolean {
    return config.queueAlertTest(this.db, id, this.now());
  }
  recordAlertDelivery(alertId: string, deliveries: Array<{ channel: 'email' | 'webhook'; ok: boolean }>): void {
    recordAlertDelivery(this.db, alertId, deliveries, this.now());
  }

  // shares
  listShares(): config.ShareRow[] {
    return config.listShares(this.db);
  }
  createShare(name: string): config.ShareRow {
    return config.createShare(this.db, name, this.now());
  }
  revokeShare(id: string): boolean {
    return config.revokeShare(this.db, id, this.now());
  }
  useShare(id: string): config.ShareRow | null {
    return this.site() === null ? null : config.useShare(this.db, id, this.now());
  }

  // site keys
  listSiteKeys(): SiteKey[] {
    return config.listSiteKeys(this.db);
  }
  createSiteKey(input: { id: string; name: string; prefix: string; hash: string; scopes: SiteKeyScope[] }): SiteKey {
    return config.createSiteKey(this.db, input, this.now());
  }
  revokeSiteKey(id: string): boolean {
    return config.revokeSiteKey(this.db, id, this.now());
  }
  verifySiteKey(hash: string): SiteKeyScope[] | null {
    return this.site() === null ? null : config.verifySiteKey(this.db, hash, this.now());
  }

  // prediction
  predictionInfo(): PredictionModelInfo | null {
    const site = this.site();
    return site === null ? null : modelInfo(loadModel(this.db), site.site.currency);
  }
  trainPrediction(): PredictionModelInfo | null {
    const site = this.site();
    if (site === null) return null;
    return modelInfo(
      this.db.transaction(() => trainSiteModel(this.db, site.site.currency, this.now())),
      site.site.currency,
    );
  }

  // integrations
  listIntegrations(): IntegrationRow[] {
    return listIntegrations(this.db);
  }
  getIntegration(provider: IntegrationProviderId): IntegrationRow | null {
    return getIntegration(this.db, provider);
  }
  saveIntegration(row: IntegrationRow): void {
    saveIntegration(this.db, row);
  }
  removeIntegration(provider: IntegrationProviderId): void {
    removeIntegration(this.db, provider);
  }
  storeAdSpend(rows: AdSpendRow[]): void {
    storeAdSpend(this.db, 'meta_ads', rows);
  }
  storeSearchStats(rows: SearchStatRow[]): void {
    storeSearchStats(this.db, rows);
  }
  /** Campaign names seen in `utm_campaign` (the dev ads provider mirrors them). */
  campaignNames(limit = 20): string[] {
    return this.db
      .all<{ c: string }>(
        `SELECT utm_campaign AS c FROM sessions WHERE utm_campaign IS NOT NULL GROUP BY utm_campaign
         ORDER BY COUNT(*) DESC, utm_campaign LIMIT ?`,
        limit,
      )
      .map((r) => r.c);
  }
  /** Most visited paths (the dev search provider mirrors them). */
  topPaths(limit = 20): string[] {
    return this.db
      .all<{ p: string }>(`SELECT path AS p FROM pageviews GROUP BY path ORDER BY COUNT(*) DESC, path LIMIT ?`, limit)
      .map((r) => r.p);
  }
  ads(input: AnalyticsRange, model?: AttributionModel): AnalyticsResult<AdsReport> {
    const r = this.range(input);
    if (!r.ok) return r;
    const site = r.value.site.site;
    return { ok: true, value: adsReport(this.db, r.value.range, site.currency, model ?? site.attribution_model) };
  }
  searchConsole(input: AnalyticsRange): AnalyticsResult<SearchConsoleReport> {
    const r = this.range(input);
    if (!r.ok) return r;
    return { ok: true, value: searchConsoleReport(this.db, r.value.range) };
  }

  // CRM facts and the core work queues
  applyCrmFacts(facts: readonly CrmFact[]): CrmApplyResult | null {
    const site = this.site();
    if (site === null) return null;
    const result = applyCrmFacts(this.db, facts, site.site.currency);
    refreshRollups(this.db, site.site.timezone, site.site.currency);
    return result;
  }
  knownVisitors(ids: readonly string[]): string[] {
    return knownVisitors(this.db, ids);
  }
  pullCoreWork(limit = 200): CoreWork {
    return pullCoreWork(this.db, Math.min(Math.max(limit, 1), 500));
  }
  ackCoreWork(ack: { identities?: number[]; automation?: number[]; alerts?: number[] }): void {
    ackCoreWork(this.db, ack);
  }
  hasCoreWork(): boolean {
    return pendingCoreWork(this.db);
  }

  // tenant instance: CRM sync state and the contact registry
  syncCursor(): registry.SyncCursor | null {
    return registry.getCursor(this.db);
  }
  setSyncCursor(cursor: registry.SyncCursor): void {
    registry.setCursor(this.db, cursor);
  }
  claimEvents(ids: readonly string[]): string[] {
    return registry.claimEvents(this.db, ids, this.now());
  }
  registerLinks(links: readonly registry.ContactVisitor[]): void {
    registry.registerLinks(this.db, links);
  }
  mergeContactLinks(from: readonly string[], to: string): void {
    registry.mergeContacts(this.db, from, to);
  }
  visitorsOfContact(contactId: string): registry.ContactVisitor[] {
    return registry.visitorsOfContact(this.db, contactId);
  }
  contactsOfVisitors(ids: readonly string[]): registry.ContactVisitor[] {
    return registry.contactsOfVisitors(this.db, ids);
  }
  markDirtySite(siteId: string): void {
    registry.markDirtySite(this.db, siteId, this.now());
  }
  dirtySites(): string[] {
    return registry.dirtySites(this.db);
  }
  clearDirtySite(siteId: string, before: number): void {
    registry.clearDirtySite(this.db, siteId, before);
  }
  acquireSyncLease(holder: string, ttlMs: number): boolean {
    return registry.acquireLease(this.db, holder, this.now(), ttlMs);
  }
  releaseSyncLease(holder: string): void {
    registry.releaseLease(this.db, holder);
  }

  // --- funnel graphs (link-routed funnels; `funnels` above are the step funnels)
  listFunnelGraphs(status?: FunnelStatus): FunnelGraphSummary[] {
    return funnelGraphs.listFunnelGraphs(this.db, status);
  }
  getFunnelGraph(id: string, version?: number): FunnelGraph | null {
    return version === undefined
      ? funnelGraphs.getFunnelGraph(this.db, id)
      : funnelGraphs.getFunnelGraphVersion(this.db, id, version);
  }
  createFunnelGraph(input: FunnelGraphInput): AnalyticsResult<FunnelGraph> {
    const body = parse(funnelGraphInputSchema, input);
    if (!body.ok) return body;
    return { ok: true, value: this.db.transaction(() => funnelGraphs.createFunnelGraph(this.db, body.value, this.now())) };
  }
  /** `input.version` must be the stored version, else `conflict`. */
  updateFunnelGraph(id: string, input: FunnelGraphUpdate): AnalyticsResult<FunnelGraph> {
    const body = parse(funnelGraphUpdateSchema, input);
    if (!body.ok) return body;
    const r = this.db.transaction(() => funnelGraphs.updateFunnelGraph(this.db, id, body.value, this.now()));
    if (r.ok) return { ok: true, value: r.graph };
    if (r.reason === 'not_found') return notFound('funnel');
    return {
      ok: false,
      error: { code: 'conflict', message: `funnel changed: current version is ${r.current_version}` },
    };
  }
  archiveFunnelGraph(id: string): FunnelGraph | null {
    return funnelGraphs.setFunnelGraphStatus(this.db, id, 'archived', this.now());
  }
  restoreFunnelGraph(id: string): FunnelGraph | null {
    return funnelGraphs.setFunnelGraphStatus(this.db, id, 'active', this.now());
  }

  // --- traffic sources
  listTrafficSources(status?: TrafficSource['status']): TrafficSource[] {
    return trafficSources.listTrafficSources(this.db, status);
  }
  getTrafficSource(id: string): TrafficSource | null {
    return trafficSources.getTrafficSource(this.db, id);
  }
  createTrafficSource(input: TrafficSourceInput): AnalyticsResult<TrafficSource> {
    const body = parse(trafficSourceInputSchema, input);
    if (!body.ok) return body;
    return { ok: true, value: trafficSources.createTrafficSource(this.db, body.value, this.now()) };
  }
  /** Full replace of the source configuration. */
  updateTrafficSource(id: string, input: TrafficSourceInput): AnalyticsResult<TrafficSource> {
    const body = parse(trafficSourceInputSchema, input);
    if (!body.ok) return body;
    const updated = this.db.transaction(() => trafficSources.updateTrafficSource(this.db, id, body.value, this.now()));
    return updated === null ? notFound('traffic source') : { ok: true, value: updated };
  }
  archiveTrafficSource(id: string): TrafficSource | null {
    return trafficSources.setTrafficSourceStatus(this.db, id, 'archived', this.now());
  }
  restoreTrafficSource(id: string): TrafficSource | null {
    return trafficSources.setTrafficSourceStatus(this.db, id, 'active', this.now());
  }

  // --- touches (funnel click-log) and conversions received by postback
  recordTouch(touch: FunnelTouch): AnalyticsResult<{ id: string; created: boolean }> {
    const t = parse(funnelTouchSchema, touch);
    if (!t.ok) return t;
    return { ok: true, value: { id: t.value.id, created: touches.insertTouch(this.db, t.value) } };
  }
  recordTouches(list: readonly FunnelTouch[]): AnalyticsResult<{ inserted: number; duplicates: number }> {
    const all = parseAll(funnelTouchSchema, list);
    if (!all.ok) return all;
    return this.db.transaction(() => {
      let inserted = 0;
      for (const t of all.value) if (touches.insertTouch(this.db, t)) inserted += 1;
      return { ok: true, value: { inserted, duplicates: all.value.length - inserted } };
    });
  }
  getTouch(id: string): FunnelTouch | null {
    return touches.getTouch(this.db, id);
  }
  /** Touches of one or more visitors (e.g. an origin and its merged children), oldest first. */
  listTouchesByVisitor(visitorIds: string | readonly string[], limit = 1000): FunnelTouch[] {
    const ids = typeof visitorIds === 'string' ? [visitorIds] : visitorIds;
    return touches.touchesByVisitor(this.db, ids, Math.min(Math.max(limit, 1), 10_000));
  }
  listTouches(query: touches.TouchQuery): FunnelTouch[] {
    return touches.listTouches(this.db, query);
  }
  /** Idempotent on hit + tx (+ event): same key updates, another tx is another conversion. */
  recordConversionFromPostback(input: touches.ConversionInput): AnalyticsResult<{ id: string; created: boolean }> {
    const c = parse(touches.conversionInputSchema, input);
    if (!c.ok) return c;
    return { ok: true, value: this.db.transaction(() => touches.upsertConversion(this.db, c.value, this.now())) };
  }
  getConversion(id: string): touches.ConversionRecord | null {
    return touches.getConversion(this.db, id);
  }
  listConversions(query: touches.ConversionQuery = {}): touches.ConversionRecord[] {
    return touches.listConversions(this.db, query);
  }

  // --- ad platforms: connections, entities, daily spend
  upsertAdConnection(input: adData.AdConnectionInput): AnalyticsResult<adData.AdConnectionRecord> {
    const c = parse(adData.adConnectionInputSchema, input);
    if (!c.ok) return c;
    return { ok: true, value: adData.upsertAdConnection(this.db, c.value, this.now()) };
  }
  getAdConnection(id: string): adData.AdConnectionRecord | null {
    return adData.getAdConnection(this.db, id);
  }
  listAdConnections(platform?: AdPlatform): adData.AdConnectionRecord[] {
    return adData.listAdConnections(this.db, platform);
  }
  upsertAdEntities(entities: readonly AdEntity[], connectionId: string | null = null): AnalyticsResult<{ upserted: number }> {
    const all = parseAll(adEntitySchema, entities);
    if (!all.ok) return all;
    const upserted = this.db.transaction(() => adData.upsertAdEntities(this.db, all.value, connectionId, this.now()));
    return { ok: true, value: { upserted } };
  }
  listAdEntities(query: adData.AdEntityQuery = {}): adData.AdEntityRecord[] {
    return adData.listAdEntities(this.db, query);
  }
  /** Overwrites the (platform, entity, day) rows: re-syncing a day replaces it. */
  upsertAdSpend(rows: readonly AdSpendDay[], connectionId: string | null = null): AnalyticsResult<{ upserted: number }> {
    const all = parseAll(adSpendDaySchema, rows);
    if (!all.ok) return all;
    const upserted = this.db.transaction(() => adData.upsertAdSpend(this.db, all.value, connectionId, this.now()));
    return { ok: true, value: { upserted } };
  }
  listAdSpend(query: adData.AdSpendQuery): AdSpendDay[] {
    return adData.listAdSpend(this.db, query);
  }

  // --- outbound conversions (queue consumed by the DO alarm)
  enqueueOutbound(input: outbound.OutboundEnqueueInput): AnalyticsResult<{ id: string; created: boolean }> {
    const job = parse(outbound.outboundEnqueueSchema, input);
    if (!job.ok) return job;
    return { ok: true, value: outbound.enqueueOutbound(this.db, job.value, this.now()) };
  }
  claimOutboundBatch(now: number, limit = 50): OutboundConversionJob[] {
    return this.db.transaction(() => outbound.claimOutboundBatch(this.db, now, Math.min(Math.max(limit, 1), 500)));
  }
  settleOutbound(id: string, outcome: outbound.OutboundOutcome): OutboundConversionJob | null {
    return outbound.settleOutbound(this.db, id, outcome, this.now());
  }
  getOutbound(id: string): OutboundConversionJob | null {
    return outbound.getOutbound(this.db, id);
  }
  listOutbound(query: outbound.OutboundQuery = {}): OutboundConversionJob[] {
    return outbound.listOutbound(this.db, query);
  }

  // --- identity keys, merges, tags, blacklist
  upsertIdentityKeys(keys: readonly IdentityKey[]): AnalyticsResult<{ added: number }> {
    const all = parseAll(identityKeySchema, keys);
    if (!all.ok) return all;
    return { ok: true, value: { added: this.db.transaction(() => identity.upsertIdentityKeys(this.db, all.value)) } };
  }
  findVisitorsByKey(keyType: IdentityKeyType, keyValue: string): IdentityKey[] {
    return identity.findVisitorsByKey(this.db, keyType, keyValue);
  }
  listIdentityKeys(visitorIds: string | readonly string[]): IdentityKey[] {
    return identity.identityKeysOf(this.db, typeof visitorIds === 'string' ? [visitorIds] : visitorIds);
  }
  /** Flags the visitors' touches as identified (kept past the anonymous retention). */
  markTouchesIdentified(visitorIds: readonly string[]): void {
    touches.markTouchesIdentified(this.db, visitorIds);
  }
  applyVisitorTags(visitorId: string, add: readonly string[], remove: readonly string[] = []): string[] {
    return this.db.transaction(() => identity.applyVisitorTags(this.db, visitorId, add, remove, this.now()));
  }
  listVisitorTags(visitorId: string): string[] {
    return identity.visitorTags(this.db, visitorId);
  }
  addToBlacklist(keys: readonly identity.IdentityKeyRef[]): void {
    this.db.transaction(() => identity.addToBlacklist(this.db, keys, this.now()));
  }
  removeFromBlacklist(keys: readonly identity.IdentityKeyRef[]): void {
    identity.removeFromBlacklist(this.db, keys);
  }
  isBlacklisted(keys: readonly identity.IdentityKeyRef[]): boolean {
    return identity.isBlacklisted(this.db, keys);
  }
  listBlacklist(): Array<identity.IdentityKeyRef & { created_at: number }> {
    return identity.listBlacklist(this.db);
  }

  // --- retention (+ nightly prediction training)
  async retention(sink: ArchiveSink | null): Promise<(RetentionResult & { anonymous_touches: number }) | null> {
    const site = getSiteRecord(this.db);
    if (site === null) return null;
    const result = await runRetention(this.db, sink, site.site.id, site.site.retention_days, this.now());
    return { ...result, anonymous_touches: touches.purgeAnonymousTouches(this.db, this.now()) };
  }

  // --- tenant index (tenant:<id> instances)
  indexAdd(siteId: string): void {
    indexAdd(this.db, siteId, this.now());
  }

  indexRemove(siteId: string): void {
    indexRemove(this.db, siteId);
  }

  indexList(): string[] {
    return indexList(this.db);
  }
}
