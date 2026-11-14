import { DurableObject } from 'cloudflare:workers';
import type {
  ConversionReport,
  ConversionReportQuery,
  ConversionRule,
  CreateConversionRuleInput,
  UpdateConversionRuleInput,
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
  TrackingCoverageReport,
  ConditionSuggestAttr,
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
import { createDoSqliteMigrationStore, runMigrations } from '@amable/db';
import type { Env } from '../env';
import { createDoSqlDb } from './db/do-sql';
import type { EdgeSiteConfig } from './enrich';
import { analyticsMigrations } from './migrations';
import { tenantSitesStub } from './rpc';
import { RealtimeHub } from './store/realtime';
import { r2ArchiveSink } from './store/retention';
import {
  DO_STORAGE_LIMIT_BYTES,
  shrunkRetentionDays,
  storagePressure,
  type StoragePressure,
} from './store/storage';
import {
  AnalyticsStore,
  type AdConnectionInput,
  type AdConnectionRecord,
  type AdEntityQuery,
  type AdEntityRecord,
  type AdSpendQuery,
  type AdSpendRow,
  type AnalyticsResult,
  type ContactActivity,
  type ContactVisitor,
  type ConversionInput,
  type ConversionQuery,
  type ConversionRecord,
  type CoreWork,
  type CrmApplyResult,
  type CrmFact,
  type IdentityKeyRef,
  type IdentityMergeSettings,
  type VisitorIdentityGraph,
  type VisitorIdentityInput,
  type IngestResult,
  type IntegrationProviderId,
  type IntegrationRow,
  type OutboundEnqueueInput,
  type OutboundOutcome,
  type OutboundQuery,
  type SearchStatRow,
  type ShareRow,
  type SiteInit,
  type SiteRecord,
  type SyncCursor,
  type TouchQuery,
  type VisitorListQuery,
} from './store/index';
import type { TrackingQualityQuery } from './store/index';
import type { SuppressInput, SuppressResult } from './store/suppression';
import type {
  CohortQuery,
  CohortReport,
  JourneyQuery,
  JourneyReport,
  LtvQuery,
  LtvReport,
  PerformanceQuery,
  PerformanceReport,
  TrackingQuality,
} from '@amable/api-types';
import { reportEdgeError, withEdgeErrorReporting } from '../errors';
import {
  coreProviderResolver,
  type ConversionOutboundRequest,
  type EnqueueForConversionResult,
  type OutboundRunResult,
  type ProviderResolver,
} from './outbound-worker';
import type { OutboundResendFilter, OutboundStats } from './store/outbound';
import type {
  FunnelLinkContext,
  FunnelLinkQuery,
  FunnelSessionRecord,
  FunnelStepInput,
  FunnelStepResult,
} from './store/funnel-sessions';
import type { DeviceSignalsReport, VisitorMerge } from '@amable/api-types';
import type { FunnelVisitorLink } from './store/identity';
import { DAY_MS } from './time';
import type { BotHit, EnrichedEvent } from './types';

/**
 * AnalyticsDO — SQLite Durable Object holding one site's analytics (`site:<id>`)
 * or one tenant's site index and CRM sync state (`tenant:<id>`). Kept apart
 * from the TenantDb so web traffic never slows the CRM down.
 *
 * Reached only from the edge worker (ingest, queue consumer) and from the core
 * worker after auth + tenant + permission guards (cross-script binding). Migrates
 * itself at first access, like the TenantDb. Realtime viewers connect through
 * the core with a WebSocket upgrade forwarded to `fetch()` (hibernation API).
 */
export class AnalyticsDO extends DurableObject<Env> {
  private schemaVersion = 0;
  private readonly store: AnalyticsStore;
  private readonly hub: RealtimeHub;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new AnalyticsStore(createDoSqlDb(ctx.storage));
    this.hub = new RealtimeHub(
      (tag) => ctx.getWebSockets(tag),
      () => this.store.realtime() ?? emptySnapshot(),
    );
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = await runMigrations(
        createDoSqliteMigrationStore(ctx.storage, { metaTable: 'analytics_meta' }),
        analyticsMigrations,
      );
      // Sites from before the registry split: one page per start, the alarm finishes the rest.
      if (!this.store.hashLegacyIdentities() && this.store.getSite() !== null)
        await ctx.storage.setAlarm(Date.now() + LEGACY_CONTINUE_MS);
    });
  }

  getSchemaVersion(): number {
    return this.schemaVersion;
  }

  // ------------------------------------------------------------ realtime socket

  /**
   * `GET /ws?audience=private|public` with `Upgrade: websocket`, forwarded by
   * the core after authorizing the viewer (session or share link).
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (this.store.getSite() === null) return new Response('not found', { status: 404 });
    const audience =
      new URL(request.url).searchParams.get('audience') === 'public' ? 'public' : 'private';
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [audience]);
    this.hub.greet(server, audience === 'public');
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.hub.onMessage(ws, message, this.ctx.getTags(ws).includes('public'));
  }

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------ site instance

  async initSite(init: SiteInit): Promise<SiteRecord> {
    const record = this.store.initSite(init);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    return record;
  }

  getSite(): SiteRecord | null {
    return this.store.getSite();
  }

  updateSite(patch: UpdateSiteInput): SiteRecord | null {
    return this.store.updateSite(patch);
  }

  setSecretHash(hash: string): boolean {
    return this.store.setSecretHash(hash);
  }

  deleteSite(): boolean {
    return this.store.deleteSite();
  }

  /** Called by the edge on cache miss: config + today's cookieless salt. */
  edgeConfig(): EdgeSiteConfig | null {
    return this.store.edgeConfig();
  }

  async ingest(events: EnrichedEvent[], bots: BotHit[]): Promise<IngestResult> {
    const result = this.store.ingest(events, bots);
    await this.afterWrite(result.pending, result.live);
    return { ...result, live: [] };
  }

  /** Facts from the CRM (links, payments, refunds, lifecycle goals), pushed by the core. */
  async applyCrmFacts(facts: CrmFact[]): Promise<CrmApplyResult | null> {
    const result = this.store.applyCrmFacts(facts);
    if (result === null) return null;
    await this.afterWrite(result.pending, result.live);
    return { ...result, live: [] };
  }

  /**
   * Realtime broadcast, then the "core work pending" signal to the tenant
   * index. The write is already committed: a failed signal is remembered and
   * retried on the next write or alarm instead of failing the caller (whose
   * retry would be deduped and would never send it).
   */
  private async afterWrite(pending: boolean, live: IngestResult['live']): Promise<void> {
    this.hub.broadcast(live);
    const owed = (await this.ctx.storage.get<boolean>(DIRTY_SIGNAL_KEY)) === true;
    if (!pending && !owed) return;
    const site = this.store.getSite();
    if (site === null) return;
    try {
      await tenantSitesStub(this.env.ANALYTICS, site.tenantId).markDirtySite(site.site.id);
      if (owed) await this.ctx.storage.delete(DIRTY_SIGNAL_KEY);
    } catch (error) {
      await this.ctx.storage.put(DIRTY_SIGNAL_KEY, true);
      console.error('analytics: dirty-site signal deferred', error);
    }
  }

  overview(range: AnalyticsRange): AnalyticsResult<AnalyticsOverview> {
    return this.store.overview(range);
  }

  timeseries(
    range: AnalyticsRange,
    interval: AnalyticsInterval,
  ): AnalyticsResult<AnalyticsTimeseries> {
    return this.store.timeseries(range, interval);
  }

  breakdown(
    range: AnalyticsRange,
    dimension: AnalyticsBreakdownDimension,
    limit: number,
    model?: AttributionModel,
  ): AnalyticsResult<AnalyticsBreakdown> {
    return this.store.breakdown(range, dimension, limit, model);
  }

  attribution(
    range: AnalyticsRange,
    dimension?: AttributionDimension,
    models?: readonly AttributionModel[],
    limit?: number,
  ): AnalyticsResult<AttributionReport> {
    return this.store.attribution(range, dimension, models, limit);
  }

  purchases(
    range: AnalyticsRange,
    limit: number,
    anonymous?: boolean,
  ): AnalyticsResult<{ currency: string; data: AnalyticsPurchase[] }> {
    return this.store.purchases(range, limit, anonymous);
  }

  insights(range: AnalyticsRange, interval: 'week' | 'month'): AnalyticsResult<AnalyticsInsights> {
    return this.store.insights(range, interval);
  }

  visitors(range: AnalyticsRange, query: VisitorListQuery): AnalyticsResult<VisitorsList> {
    return this.store.visitors(range, query);
  }

  visitorProfile(visitorId: string): VisitorProfile | null {
    return this.store.visitorProfile(visitorId);
  }

  contactActivity(contactId: string, limit: number): ContactActivity | null {
    return this.store.contactActivity(contactId, limit);
  }

  realtime(): AnalyticsRealtime | null {
    return this.store.realtime();
  }

  installCheck(): InstallCheck | null {
    return this.store.installCheck();
  }

  bots(range: AnalyticsRange): AnalyticsResult<BotsReport> {
    return this.store.bots(range);
  }

  trackingCoverage(range: AnalyticsRange): AnalyticsResult<TrackingCoverageReport> {
    return this.store.trackingCoverage(range);
  }

  listFunnels(): Funnel[] {
    return this.store.listFunnels();
  }
  getFunnel(id: string): Funnel | null {
    return this.store.getFunnel(id);
  }
  createFunnel(input: CreateFunnelInput): Funnel {
    return this.store.createFunnel(input);
  }
  updateFunnel(id: string, patch: UpdateFunnelInput): Funnel | null {
    return this.store.updateFunnel(id, patch);
  }
  deleteFunnel(id: string): boolean {
    return this.store.deleteFunnel(id);
  }
  funnelResult(id: string, range: AnalyticsRange): AnalyticsResult<FunnelResult> {
    return this.store.funnelResult(id, range);
  }

  listConversionRules(): ConversionRule[] {
    return this.store.listConversionRules();
  }
  createConversionRule(input: CreateConversionRuleInput): AnalyticsResult<ConversionRule> {
    return this.store.createConversionRule(input);
  }
  updateConversionRule(id: string, patch: UpdateConversionRuleInput): AnalyticsResult<ConversionRule> {
    return this.store.updateConversionRule(id, patch);
  }
  deleteConversionRule(id: string): boolean {
    return this.store.deleteConversionRule(id);
  }
  conversionReport(
    range: AnalyticsRange,
    query: ConversionReportQuery,
  ): AnalyticsResult<ConversionReport> {
    return this.store.conversionReport(range, query);
  }

  listSegments(): Segment[] {
    return this.store.listSegments();
  }
  createSegment(input: CreateSegmentInput): Segment {
    return this.store.createSegment(input);
  }
  updateSegment(id: string, patch: UpdateSegmentInput): Segment | null {
    return this.store.updateSegment(id, patch);
  }
  deleteSegment(id: string): boolean {
    return this.store.deleteSegment(id);
  }

  listAlerts(): Alert[] {
    return this.store.listAlerts();
  }
  createAlert(
    input: CreateAlertInput,
    webhookSecret: string | null,
  ): { alert: Alert; webhook_secret: string | null } {
    return this.store.createAlert(input, webhookSecret);
  }
  updateAlert(
    id: string,
    patch: UpdateAlertInput,
    webhookSecret: string | null,
  ): { alert: Alert; webhook_secret: string | null } | null {
    return this.store.updateAlert(id, patch, webhookSecret);
  }
  rotateAlertSecret(id: string, secret: string): { alert: Alert; webhook_secret: string } | null {
    return this.store.rotateAlertSecret(id, secret);
  }
  deleteAlert(id: string): boolean {
    return this.store.deleteAlert(id);
  }
  async testAlert(id: string): Promise<boolean> {
    const ok = this.store.testAlert(id);
    if (ok) await this.afterWrite(true, []);
    return ok;
  }
  recordAlertDelivery(
    alertId: string,
    deliveries: Array<{ channel: 'email' | 'webhook'; ok: boolean }>,
  ): void {
    this.store.recordAlertDelivery(alertId, deliveries);
  }

  listShares(): ShareRow[] {
    return this.store.listShares();
  }
  createShare(name: string): ShareRow {
    return this.store.createShare(name);
  }
  revokeShare(id: string): boolean {
    return this.store.revokeShare(id);
  }
  useShare(id: string): ShareRow | null {
    return this.store.useShare(id);
  }

  listSiteKeys(): SiteKey[] {
    return this.store.listSiteKeys();
  }
  createSiteKey(input: {
    id: string;
    name: string;
    prefix: string;
    hash: string;
    scopes: SiteKeyScope[];
  }): SiteKey {
    return this.store.createSiteKey(input);
  }
  revokeSiteKey(id: string): boolean {
    return this.store.revokeSiteKey(id);
  }
  verifySiteKey(hash: string): SiteKeyScope[] | null {
    return this.store.verifySiteKey(hash);
  }

  predictionInfo(): PredictionModelInfo | null {
    return this.store.predictionInfo();
  }
  trainPrediction(): PredictionModelInfo | null {
    return this.store.trainPrediction();
  }

  listIntegrations(): IntegrationRow[] {
    return this.store.listIntegrations();
  }
  getIntegration(provider: IntegrationProviderId): IntegrationRow | null {
    return this.store.getIntegration(provider);
  }
  saveIntegration(row: IntegrationRow): void {
    this.store.saveIntegration(row);
  }
  removeIntegration(provider: IntegrationProviderId): void {
    this.store.removeIntegration(provider);
  }
  storeAdSpend(rows: AdSpendRow[]): void {
    this.store.storeAdSpend(rows);
  }
  storeSearchStats(rows: SearchStatRow[]): void {
    this.store.storeSearchStats(rows);
  }
  campaignNames(limit?: number): string[] {
    return this.store.campaignNames(limit);
  }
  topPaths(limit?: number): string[] {
    return this.store.topPaths(limit);
  }
  ads(range: AnalyticsRange, model?: AttributionModel): AnalyticsResult<AdsReport> {
    return this.store.ads(range, model);
  }
  searchConsole(range: AnalyticsRange): AnalyticsResult<SearchConsoleReport> {
    return this.store.searchConsole(range);
  }

  listFunnelGraphs(status?: FunnelStatus): FunnelGraphSummary[] {
    return this.store.listFunnelGraphs(status);
  }
  getFunnelGraph(id: string, version?: number): FunnelGraph | null {
    return this.store.getFunnelGraph(id, version);
  }
  conditionValues(attr: ConditionSuggestAttr, limit?: number): string[] {
    return this.store.conditionValues(attr, limit);
  }
  createFunnelGraph(input: FunnelGraphInput): AnalyticsResult<FunnelGraph> {
    return this.store.createFunnelGraph(input);
  }
  updateFunnelGraph(id: string, input: FunnelGraphUpdate): AnalyticsResult<FunnelGraph> {
    return this.store.updateFunnelGraph(id, input);
  }
  archiveFunnelGraph(id: string): FunnelGraph | null {
    return this.store.archiveFunnelGraph(id);
  }
  restoreFunnelGraph(id: string): FunnelGraph | null {
    return this.store.restoreFunnelGraph(id);
  }

  listTrafficSources(status?: TrafficSource['status']): TrafficSource[] {
    return this.store.listTrafficSources(status);
  }
  getTrafficSource(id: string): TrafficSource | null {
    return this.store.getTrafficSource(id);
  }
  createTrafficSource(input: TrafficSourceInput): AnalyticsResult<TrafficSource> {
    return this.store.createTrafficSource(input);
  }
  updateTrafficSource(id: string, input: TrafficSourceInput): AnalyticsResult<TrafficSource> {
    return this.store.updateTrafficSource(id, input);
  }
  archiveTrafficSource(id: string): TrafficSource | null {
    return this.store.archiveTrafficSource(id);
  }
  restoreTrafficSource(id: string): TrafficSource | null {
    return this.store.restoreTrafficSource(id);
  }

  recordTouch(touch: FunnelTouch): AnalyticsResult<{ id: string; created: boolean }> {
    return this.store.recordTouch(touch);
  }
  recordTouches(touches: FunnelTouch[]): AnalyticsResult<{ inserted: number; duplicates: number }> {
    return this.store.recordTouches(touches);
  }
  getTouch(id: string): FunnelTouch | null {
    return this.store.getTouch(id);
  }
  listTouchesByVisitor(visitorIds: string | string[], limit?: number): FunnelTouch[] {
    return this.store.listTouchesByVisitor(visitorIds, limit);
  }
  listTouches(query: TouchQuery): FunnelTouch[] {
    return this.store.listTouches(query);
  }
  recordConversionFromPostback(
    input: ConversionInput,
  ): AnalyticsResult<{ id: string; created: boolean }> {
    return this.store.recordConversionFromPostback(input);
  }
  getConversion(id: string): ConversionRecord | null {
    return this.store.getConversion(id);
  }
  listConversions(query?: ConversionQuery): ConversionRecord[] {
    return this.store.listConversions(query);
  }

  // ---- funnel link routing (/go, /a/:n, direct links)
  funnelLinkContext(query: FunnelLinkQuery): AnalyticsResult<FunnelLinkContext> {
    return this.store.funnelLinkContext(query);
  }
  getFunnelSession(visitorId: string, funnelId?: string | null): FunnelSessionRecord | null {
    return this.store.getFunnelSession(visitorId, funnelId);
  }
  recordFunnelStep(step: FunnelStepInput): AnalyticsResult<FunnelStepResult> {
    return this.store.recordFunnelStep(step);
  }
  linkFunnelVisitor(link: FunnelVisitorLink): AnalyticsResult<VisitorMerge | null> {
    return this.store.linkFunnelVisitor(link);
  }

  upsertAdConnection(input: AdConnectionInput): AnalyticsResult<AdConnectionRecord> {
    return this.store.upsertAdConnection(input);
  }
  getAdConnection(id: string): AdConnectionRecord | null {
    return this.store.getAdConnection(id);
  }
  listAdConnections(platform?: AdPlatform): AdConnectionRecord[] {
    return this.store.listAdConnections(platform);
  }
  upsertAdEntities(
    entities: AdEntity[],
    connectionId?: string | null,
  ): AnalyticsResult<{ upserted: number }> {
    return this.store.upsertAdEntities(entities, connectionId ?? null);
  }
  listAdEntities(query?: AdEntityQuery): AdEntityRecord[] {
    return this.store.listAdEntities(query);
  }
  upsertAdSpend(
    rows: AdSpendDay[],
    connectionId?: string | null,
  ): AnalyticsResult<{ upserted: number }> {
    return this.store.upsertAdSpend(rows, connectionId ?? null);
  }
  listAdSpend(query: AdSpendQuery): AdSpendDay[] {
    return this.store.listAdSpend(query);
  }

  enqueueOutbound(input: OutboundEnqueueInput): AnalyticsResult<{ id: string; created: boolean }> {
    return this.store.enqueueOutbound(input);
  }
  claimOutboundBatch(now: number, limit?: number): OutboundConversionJob[] {
    return this.store.claimOutboundBatch(now, limit);
  }
  settleOutbound(id: string, outcome: OutboundOutcome): OutboundConversionJob | null {
    return this.store.settleOutbound(id, outcome);
  }
  getOutbound(id: string): OutboundConversionJob | null {
    return this.store.getOutbound(id);
  }
  listOutbound(query?: OutboundQuery): OutboundConversionJob[] {
    return this.store.listOutbound(query);
  }

  // ---- outbound conversions: enqueue from traffic source mapping, sending, resend
  async enqueueConversionOutbound(
    input: ConversionOutboundRequest,
  ): Promise<AnalyticsResult<EnqueueForConversionResult>> {
    const result = await this.store.enqueueConversionOutbound(input);
    await this.scheduleOutboundAlarm();
    return result;
  }
  async resendOutbound(ids: string[]): Promise<{ requeued: number }> {
    const result = this.store.resendOutbound(ids);
    await this.scheduleOutboundAlarm();
    return result;
  }
  async resendFailedOutbound(
    filter?: OutboundResendFilter,
  ): Promise<AnalyticsResult<{ requeued: number }>> {
    const result = this.store.resendFailedOutbound(filter);
    await this.scheduleOutboundAlarm();
    return result;
  }
  outboundStats(query?: Omit<OutboundQuery, 'status' | 'limit'>): OutboundStats {
    return this.store.outboundStats(query);
  }
  /** Sends the due jobs now (the alarm does the same on its own). */
  async processOutbound(now?: number): Promise<OutboundRunResult | null> {
    const site = this.store.getSite();
    if (site === null) return null;
    const result = await this.store.processOutbound(this.outboundResolver(site), now ?? Date.now());
    await this.scheduleOutboundAlarm();
    return result;
  }

  protected outboundResolver(site: SiteRecord): ProviderResolver {
    return coreProviderResolver(this.env, { tenantId: site.tenantId, siteId: site.site.id });
  }

  /** Brings the alarm forward to the next due outbound job; never pushes it back. */
  private async scheduleOutboundAlarm(): Promise<void> {
    const next = this.store.nextOutboundAttemptAt();
    if (next === null) return;
    const at = Math.max(next, Date.now() + OUTBOUND_MIN_ALARM_GAP_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  upsertIdentityKeys(keys: IdentityKey[]): AnalyticsResult<{ added: number }> {
    return this.store.upsertIdentityKeys(keys);
  }
  findVisitorsByKey(keyType: IdentityKeyType, keyValue: string): IdentityKey[] {
    return this.store.findVisitorsByKey(keyType, keyValue);
  }
  listIdentityKeys(visitorIds: string | string[]): IdentityKey[] {
    return this.store.listIdentityKeys(visitorIds);
  }
  applyVisitorTags(visitorId: string, add: string[], remove?: string[]): string[] {
    return this.store.applyVisitorTags(visitorId, add, remove);
  }
  listVisitorTags(visitorId: string): string[] {
    return this.store.listVisitorTags(visitorId);
  }
  addToBlacklist(keys: IdentityKeyRef[]): void {
    this.store.addToBlacklist(keys);
  }
  removeFromBlacklist(keys: IdentityKeyRef[]): void {
    this.store.removeFromBlacklist(keys);
  }
  isBlacklisted(keys: IdentityKeyRef[]): boolean {
    return this.store.isBlacklisted(keys);
  }
  listBlacklist(): Array<IdentityKeyRef & { created_at: number }> {
    return this.store.listBlacklist();
  }

  // ---- identity merge
  identifyVisitors(
    items: VisitorIdentityInput[],
  ): AnalyticsResult<{ added: number; merged: number; skipped: number }> {
    return this.store.identifyVisitors(items);
  }
  mergeVisitors(
    originVisitorId: string,
    childVisitorId: string,
  ): AnalyticsResult<VisitorIdentityGraph> {
    return this.store.mergeVisitors(originVisitorId, childVisitorId);
  }
  unmergeVisitors(
    childVisitorId: string,
  ): AnalyticsResult<{ child: VisitorIdentityGraph; origin: VisitorIdentityGraph }> {
    return this.store.unmergeVisitors(childVisitorId);
  }
  reprocessVisitors(range: {
    from: number;
    to: number;
  }): AnalyticsResult<{ keys: number; merges: number; visitors: number }> {
    return this.store.reprocessVisitors(range);
  }
  visitorIdentityGraph(visitorId: string): VisitorIdentityGraph | null {
    return this.store.visitorIdentityGraph(visitorId);
  }
  resolveVisitorGroup(visitorId: string): string[] {
    return this.store.resolveVisitorGroup(visitorId);
  }
  getIdentitySettings(): IdentityMergeSettings {
    return this.store.getIdentitySettings();
  }
  updateIdentitySettings(
    patch: Partial<IdentityMergeSettings>,
  ): AnalyticsResult<IdentityMergeSettings> {
    return this.store.updateIdentitySettings(patch);
  }
  deviceSignalsReport(): DeviceSignalsReport {
    return this.store.deviceSignalsReport();
  }
  unmergeDeviceMerges(childVisitorIds: string[] | null): number {
    return this.store.unmergeDeviceMerges(childVisitorIds);
  }
  blacklistVisitorKeys(visitorId: string): number {
    return this.store.blacklistVisitorKeys(visitorId);
  }

  knownVisitors(ids: string[]): string[] {
    return this.store.knownVisitors(ids);
  }
  visitorsLastSeen(ids: string[]): Array<{ visitorId: string; lastSeen: number }> {
    return this.store.visitorsLastSeen(ids);
  }
  /** Payment already on the site with this transaction id (the browser may have sent it). */
  paymentOf(transactionId: string): { visitorId: string | null } | null {
    return this.store.paymentOf(transactionId);
  }
  /** Tombstones the visitors (and carriers of the hashed identities); `purge` also erases their data. */
  async suppressVisitors(input: SuppressInput): Promise<SuppressResult> {
    const result = this.store.suppressVisitors(input);
    const at = this.store.nextPurgeAt();
    if (at !== null) {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    }
    return result;
  }
  purgeJobs(): ReturnType<AnalyticsStore['purgeJobs']> {
    return this.store.purgeJobs();
  }
  pullCoreWork(limit?: number): CoreWork {
    return this.store.pullCoreWork(limit);
  }
  ackCoreWork(ack: { identities?: number[]; automation?: number[]; alerts?: number[] }): void {
    this.store.ackCoreWork(ack);
  }
  hasCoreWork(): boolean {
    return this.store.hasCoreWork();
  }

  // ---------------------------------------------------- ad attribution reports
  adsPerformanceReport(query: PerformanceQuery): AnalyticsResult<PerformanceReport> {
    return this.store.adsPerformanceReport(query);
  }
  adsLtvReport(query: LtvQuery): AnalyticsResult<LtvReport> {
    return this.store.adsLtvReport(query);
  }
  adsCohortReport(query: CohortQuery): AnalyticsResult<CohortReport> {
    return this.store.adsCohortReport(query);
  }
  adsJourneyReport(query: JourneyQuery): AnalyticsResult<JourneyReport> {
    return this.store.adsJourneyReport(query);
  }
  trackingQuality(range: TrackingQualityQuery): AnalyticsResult<TrackingQuality> {
    return this.store.trackingQuality(range);
  }

  /** Storage telemetry (AE `do_storage` points) and an alert when the DO nears its size limit. */
  private reportStorage(
    siteId: string,
    bytes: number,
    pressure: StoragePressure,
    shrunkTo: number | undefined,
  ): void {
    this.env.AE?.writeDataPoint({
      blobs: ['do_storage', siteId, pressure],
      doubles: [bytes],
      indexes: [siteId],
    });
    if (pressure === 'ok') return;
    const pct = Math.round((bytes / DO_STORAGE_LIMIT_BYTES) * 100);
    const action = shrunkTo === undefined ? 'no action' : `retention shrunk to ${shrunkTo} days`;
    this.ctx.waitUntil(
      reportEdgeError(
        this.env,
        new Error(`analytics DO ${siteId} storage at ${pct}% of the limit (${action})`),
        { source: 'durable_object', module: 'analytics', route: 'storage' },
      ),
    );
  }

  /** Daily: retention (archive + purge raw rows), then retrain the conversion model. */
  override async alarm(): Promise<void> {
    await withEdgeErrorReporting(
      this.env,
      { source: 'durable_object', module: 'analytics', route: 'alarm' },
      async () => {
        const site = this.store.getSite();
        if (site === null) return;
        let legacyDone = false;
        for (let page = 0; page < LEGACY_PAGES_PER_ALARM && !legacyDone; page++)
          legacyDone = this.store.hashLegacyIdentities();
        // The alarm also wakes up for outbound jobs: daily work runs only when its own deadline passed.
        let dailyAt = (await this.ctx.storage.get<number>(DAILY_WORK_AT_KEY)) ?? 0;
        if (Date.now() >= dailyAt) {
          const sink = this.env.FILES === undefined ? null : r2ArchiveSink(this.env.FILES);
          const bytes = this.ctx.storage.sql.databaseSize;
          const pressure = storagePressure(bytes);
          const days =
            pressure === 'shrink' ? shrunkRetentionDays(site.site.retention_days) : undefined;
          const purged = await this.store.retention(sink, days);
          this.reportStorage(site.site.id, bytes, pressure, days);
          // A capped pass leaves work: come back shortly, train once it is done.
          const more = purged !== null && (purged.more || purged.touches_more);
          if (!more) this.store.trainPrediction();
          dailyAt = Date.now() + (more ? RETENTION_CONTINUE_MS : DAY_MS);
          await this.ctx.storage.put(DAILY_WORK_AT_KEY, dailyAt);
        }
        await this.afterWrite(false, []);
        await this.store.processOutbound(this.outboundResolver(site), Date.now());
        let nextPurge: number | null;
        try {
          const purgeMore =
            this.env.FILES !== undefined && (await this.store.runPurge(this.env.FILES));
          nextPurge = purgeMore ? Date.now() + PURGE_CONTINUE_MS : this.store.nextPurgeAt();
        } catch (error) {
          // R2 unavailable: the job keeps its progress; the other alarm work must not stop.
          console.error('purge pass failed', error);
          nextPurge = Date.now() + PURGE_RETRY_MS;
        }
        const nextOutbound = this.store.nextOutboundAttemptAt();
        let next = legacyDone ? dailyAt : Date.now() + LEGACY_CONTINUE_MS;
        if (nextOutbound !== null)
          next = Math.min(next, Math.max(nextOutbound, Date.now() + OUTBOUND_MIN_ALARM_GAP_MS));
        if (nextPurge !== null)
          next = Math.min(next, Math.max(nextPurge, Date.now() + OUTBOUND_MIN_ALARM_GAP_MS));
        await this.ctx.storage.setAlarm(next);
      },
    );
  }

  // ---------------------------------------------------------- tenant instance

  indexAdd(siteId: string): void {
    this.store.indexAdd(siteId);
  }

  indexRemove(siteId: string): void {
    this.store.indexRemove(siteId);
  }

  indexList(): string[] {
    return this.store.indexList();
  }

  syncCursor(): SyncCursor | null {
    return this.store.syncCursor();
  }
  setSyncCursor(cursor: SyncCursor): void {
    this.store.setSyncCursor(cursor);
  }
  claimEvents(ids: string[]): string[] {
    return this.store.claimEvents(ids);
  }
  registerLinks(links: ContactVisitor[]): void {
    this.store.registerLinks(links);
  }
  unlinkVisitors(siteId: string, visitorIds: string[]): void {
    this.store.unlinkVisitors(siteId, visitorIds);
  }
  mergeContactLinks(from: string[], to: string): void {
    this.store.mergeContactLinks(from, to);
  }
  visitorsOfContact(contactId: string): ContactVisitor[] {
    return this.store.visitorsOfContact(contactId);
  }
  contactsOfVisitors(ids: string[]): ContactVisitor[] {
    return this.store.contactsOfVisitors(ids);
  }
  markDirtySite(siteId: string): void {
    this.store.markDirtySite(siteId);
  }
  dirtySites(): string[] {
    return this.store.dirtySites();
  }
  clearDirtySite(siteId: string, before: number): void {
    this.store.clearDirtySite(siteId, before);
  }
  acquireSyncLease(holder: string, ttlMs: number): boolean {
    return this.store.acquireSyncLease(holder, ttlMs);
  }
  releaseSyncLease(holder: string): void {
    this.store.releaseSyncLease(holder);
  }
}

/** Storage key of the next retention + training run (the alarm also fires for outbound jobs). */
const DAILY_WORK_AT_KEY = 'daily_work_at';
/** A dirty-site signal that failed after its write committed (retried by the next write or alarm). */
const DIRTY_SIGNAL_KEY = 'dirty_signal_owed';
const RETENTION_CONTINUE_MS = 60_000;
/** Pre-registry contact data still to hash: pages per alarm, then the next alarm soon after. */
const LEGACY_PAGES_PER_ALARM = 10;
const LEGACY_CONTINUE_MS = 30_000;
const PURGE_RETRY_MS = 60_000;
const PURGE_CONTINUE_MS = 5_000;
const OUTBOUND_MIN_ALARM_GAP_MS = 1_000;

function emptySnapshot(): AnalyticsRealtime {
  return {
    site_id: '',
    currency: 'EUR',
    online: 0,
    window_minutes: 30,
    visitors: [],
    events: [],
    countries: [],
    pages: [],
    referrers: [],
  };
}
