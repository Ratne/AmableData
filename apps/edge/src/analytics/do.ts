import { DurableObject } from 'cloudflare:workers';
import type {
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
  FunnelResult,
  InstallCheck,
  PredictionModelInfo,
  SearchConsoleReport,
  Segment,
  SiteKey,
  SiteKeyScope,
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
  AnalyticsStore,
  type AdSpendRow,
  type AnalyticsResult,
  type ContactActivity,
  type ContactVisitor,
  type CoreWork,
  type CrmApplyResult,
  type CrmFact,
  type IngestResult,
  type IntegrationProviderId,
  type IntegrationRow,
  type SearchStatRow,
  type ShareRow,
  type SiteInit,
  type SiteRecord,
  type SyncCursor,
  type VisitorListQuery,
} from './store/index';
import { withEdgeErrorReporting } from '../errors';
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
    const audience = new URL(request.url).searchParams.get('audience') === 'public' ? 'public' : 'private';
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

  private async afterWrite(pending: boolean, live: IngestResult['live']): Promise<void> {
    this.hub.broadcast(live);
    if (!pending) return;
    const site = this.store.getSite();
    if (site !== null) await tenantSitesStub(this.env.ANALYTICS, site.tenantId).markDirtySite(site.site.id);
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

  purchases(range: AnalyticsRange, limit: number, anonymous?: boolean): AnalyticsResult<{ currency: string; data: AnalyticsPurchase[] }> {
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
  createAlert(input: CreateAlertInput, webhookSecret: string | null): { alert: Alert; webhook_secret: string | null } {
    return this.store.createAlert(input, webhookSecret);
  }
  updateAlert(id: string, patch: UpdateAlertInput, webhookSecret: string | null): { alert: Alert; webhook_secret: string | null } | null {
    return this.store.updateAlert(id, patch, webhookSecret);
  }
  deleteAlert(id: string): boolean {
    return this.store.deleteAlert(id);
  }
  async testAlert(id: string): Promise<boolean> {
    const ok = this.store.testAlert(id);
    if (ok) await this.afterWrite(true, []);
    return ok;
  }
  recordAlertDelivery(alertId: string, deliveries: Array<{ channel: 'email' | 'webhook'; ok: boolean }>): void {
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
  createSiteKey(input: { id: string; name: string; prefix: string; hash: string; scopes: SiteKeyScope[] }): SiteKey {
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

  knownVisitors(ids: string[]): string[] {
    return this.store.knownVisitors(ids);
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

  /** Daily: retention (archive + purge raw rows), then retrain the conversion model. */
  override async alarm(): Promise<void> {
    await withEdgeErrorReporting(this.env, { source: 'durable_object', module: 'analytics', route: 'alarm' }, async () => {
      if (this.store.getSite() === null) return;
      const sink = this.env.FILES === undefined ? null : r2ArchiveSink(this.env.FILES);
      await this.store.retention(sink);
      this.store.trainPrediction();
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
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
