import { MAX_FUNNEL_ACTION, trackerEventSchema, type FunnelGraph, type FunnelNodeOf, type TrackerEvent } from '@amable/api-types';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { detectBot } from './crawlers';
import { directLinkView, type DirectLinkView } from './enrich';
import {
  buildDirectUrl,
  executeStep,
  FunnelEngineError,
  type FunnelEvent,
  type FunnelSessionState,
  type FunnelStepResult,
  type FunnelVisitContext,
  type Rng,
} from './funnel-engine';
import { registerPostbackRoutes } from './links/postback';
import { resolveHostedPageUrl, withHostedPages, type HostedPageLookup } from './links/hosted-pages';
import { DEFAULT_LINK_SITE_RESOLVERS, requestLinkSite, SITE_PATH_PREFIX, type LinkSite, type LinkSiteResolver } from './links/site';
import {
  captureTracking,
  entranceCostMinor,
  namesOfSlots,
  newHitId,
  newVisitorId,
  requestFacts,
  touchOf,
  validNodeId,
  validObjectId,
  validVisitorId,
  visitContext,
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE_S,
  type CapturedTracking,
  type RequestFacts,
  type TouchBase,
} from './links/visit';
import { deliverWebhook, WEBHOOK_TIMEOUT_MS, type WebhookEffect } from './links/webhooks';
import { MAX_EVENT_BYTES } from './routes';
import { siteStub, SITE_ID_RE } from './rpc';
import type { FunnelLinkContext, FunnelLinkQuery, FunnelSessionInput, FunnelStepInput } from './store/funnel-sessions';

/**
 * Funnel tracking links on tracking hostnames:
 * - `GET /go/{funnelId}-{sourceId}[/{nodeId}[/{pageId}]]` — entrance: captures the
 *   source's tracking fields, runs the funnel and redirects (302) with `vid`;
 * - `GET /a/{n}` and `GET /go/{funnelId}/{nodeId}/a/{n}` — action links: the origin
 *   is `vid`+`rn`, else the referrer (`vid`, `n`, page URL), else the visitor
 *   cookie, else the default funnel/node of the path (only without a session);
 * - `GET /pb`, `GET /pb/event` — conversion and custom-event postbacks.
 * On custom tracking hostnames the site comes from the hostname; on the shared
 * edge host every route is prefixed with `/s/{siteId}`.
 * Routing state lives in the site's AnalyticsDO (`funnel_sessions` + `visitor_tags`);
 * URL parameters that are not tracking fields only feed `{data-*}` tokens.
 */

type Ctx = Context<{ Bindings: Env }>;

export interface LinkRoutesOptions {
  /** Hostname → site lookups, tried in order. */
  resolvers?: readonly LinkSiteResolver[];
  /** Webhook transport. */
  fetch?: typeof fetch;
  rng?: Rng;
  now?: () => number;
  webhookTimeoutMs?: number;
  /** Public URL of a page built with the page builder (default: core gateway lookup). */
  hostedPages?: (env: Env) => HostedPageLookup;
}

interface Deps {
  resolvers: readonly LinkSiteResolver[];
  fetch: typeof fetch;
  rng: Rng;
  now: () => number;
  webhookTimeoutMs: number;
  hostedPages: (env: Env) => HostedPageLookup;
}

const LINK_RE = /^([A-Za-z0-9_]{1,64})-([A-Za-z0-9_]{1,64})$/;
const LINK_PARAM = ':link{[A-Za-z0-9_]+-[A-Za-z0-9_]+}';

function notFound(c: Ctx): Response {
  return c.text('Not found', 404, { 'cache-control': 'no-store' });
}

function unavailable(c: Ctx): Response {
  return c.text('Funnel unavailable', 502, { 'cache-control': 'no-store' });
}

/** Never delays the response; without an ExecutionContext (tests) the task just runs. */
function background(c: Ctx, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

function redirect(c: Ctx, site: LinkSite, url: string, visitorId: string): Response {
  setCookie(c, VISITOR_COOKIE, visitorId, {
    // On the shared edge host every site has its own visitor cookie.
    path: site.basePath === '' ? '/' : site.basePath,
    maxAge: VISITOR_COOKIE_MAX_AGE_S,
    sameSite: 'Lax',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
  });
  c.header('cache-control', 'no-store');
  return c.redirect(url, 302);
}

function runStep(
  graph: FunnelGraph,
  state: FunnelSessionState,
  event: FunnelEvent,
  ctx: FunnelVisitContext,
  deps: Deps,
): FunnelStepResult | null {
  try {
    return executeStep(graph, state, event, ctx, deps.rng, deps.now());
  } catch (error) {
    if (!(error instanceof FunnelEngineError)) throw error;
    console.error('[links] funnel without destination', graph.id, error.code, error.nodeId ?? '');
    return null;
  }
}

/** Destination URL; page destinations also carry their node (`n`) for referrer-based action links. */
function destinationUrl(step: FunnelStepResult): string | null {
  const { destination } = step;
  if (destination.url === '') return null;
  if (destination.kind !== 'page') return destination.url;
  const query = destination.url.split('#')[0]!.split('?')[1] ?? '';
  if (query.split('&').some((p) => p === 'n' || p.startsWith('n='))) return destination.url;
  return buildDirectUrl(destination.url, `n=${encodeURIComponent(destination.nodeId)}`);
}

function tagChange(visitorId: string, before: readonly string[], step: FunnelStepResult): FunnelStepInput['tags'] {
  if (!step.effects.some((e) => e.type === 'tag')) return null;
  const after = step.nextState.tags;
  return {
    visitor_id: visitorId,
    add: after.filter((t) => !before.includes(t)),
    remove: before.filter((t) => !after.includes(t)),
  };
}

function deliverEffects(c: Ctx, step: FunnelStepResult, deps: Deps): void {
  const hooks = step.effects.filter((e): e is WebhookEffect => e.type === 'webhook');
  if (hooks.length === 0) return;
  background(c, Promise.all(hooks.map((h) => deliverWebhook(h, deps.fetch, deps.webhookTimeoutMs))));
}

async function saveStep(stub: ReturnType<typeof siteStub>, step: FunnelStepInput): Promise<void> {
  try {
    const result = await stub.recordFunnelStep(step);
    if (!result.ok) console.error('[links] funnel step rejected', result.error.message);
  } catch (error) {
    // The visitor is redirected anyway.
    console.error('[links] funnel step not recorded', error instanceof Error ? error.message : String(error));
  }
}

function sessionInput(
  visitorId: string,
  funnelId: string,
  step: FunnelStepResult,
  context: Pick<TouchBase, 'trafficSourceId' | 'campaign' | 'external' | 'slots'>,
): FunnelSessionInput {
  return {
    visitor_id: visitorId,
    funnel_id: funnelId,
    current_node_id: step.nextState.currentNodeId,
    current_page_id: step.nextState.currentPageId,
    rotations: step.nextState.rotations,
    traffic_source_id: context.trafficSourceId,
    campaign: context.campaign,
    external_click_id: context.external,
    fields: context.slots === null || Object.keys(context.slots).length === 0 ? null : context.slots,
  };
}

async function linkSite(c: Ctx, deps: Deps): Promise<LinkSite | null> {
  return requestLinkSite(c, deps.resolvers);
}

/** The graph with its hosted pages resolved (unresolvable ones paused) and the URL lookup for the engine. */
async function routableGraph(
  c: Ctx,
  deps: Deps,
  ctx: FunnelLinkContext & { graph: FunnelGraph },
): Promise<{ graph: FunnelGraph; hostedPageUrl: (id: string) => string | undefined }> {
  const { graph, urls } = await withHostedPages(ctx.graph, ctx.tenant_id, deps.hostedPages(c.env));
  return { graph, hostedPageUrl: (id) => urls.get(id) };
}

async function linkContext(c: Ctx, site: LinkSite, query: FunnelLinkQuery): Promise<FunnelLinkContext | null> {
  const res = await siteStub(c.env.ANALYTICS, site.siteId).funnelLinkContext(query);
  return res.ok ? (res.value as FunnelLinkContext) : null;
}

// ---------------------------------------------------------------- entrance

async function entrance(c: Ctx, deps: Deps): Promise<Response> {
  const link = LINK_RE.exec(c.req.param('link') ?? '');
  const nodeParam = c.req.param('nodeId');
  const pageParam = c.req.param('pageId');
  const nodeId = nodeParam === undefined ? undefined : validNodeId(nodeParam);
  const pageId = pageParam === undefined ? undefined : validNodeId(pageParam);
  if (link === null || nodeId === null || pageId === null) return notFound(c);
  const funnelId = link[1]!;
  const sourceId = link[2]!;
  const site = await linkSite(c, deps);
  if (site === null) return notFound(c);

  const q = new URL(c.req.url).searchParams;
  const visitorId = validVisitorId(q.get('vid')) ?? validVisitorId(getCookie(c, VISITOR_COOKIE)) ?? newVisitorId();
  const ctx = await linkContext(c, site, { funnel_id: funnelId, traffic_source_id: sourceId, visitor_id: visitorId });
  if (ctx === null || ctx.graph === null || ctx.source === null) return notFound(c);

  const hitId = newHitId();
  const tracking = captureTracking(ctx.source, q);
  const facts = requestFacts(c.req.raw);
  const visit = visitContext(facts, { hitId, visitorId, funnelId, trafficSourceId: sourceId, timezone: ctx.timezone }, tracking);
  const event: FunnelEvent = {
    type: 'entrance',
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(pageId === undefined ? {} : { pageId }),
  };
  const routable = await routableGraph(c, deps, { ...ctx, graph: ctx.graph });
  visit.hostedPageUrl = routable.hostedPageUrl;
  const step = runStep(routable.graph, { rotations: ctx.session?.rotations ?? {}, tags: ctx.tags }, event, visit, deps);
  const target = step === null ? null : destinationUrl(step);
  if (step === null || target === null) return unavailable(c);

  if (detectBot(facts.userAgent) === null) {
    const base: TouchBase = {
      ts: deps.now(),
      visitorId,
      sessionId: visitorId,
      funnelId,
      trafficSourceId: sourceId,
      campaign: tracking.campaign,
      external: tracking.external,
      slots: tracking.slots,
    };
    const entryId = step.path[0]!;
    const cost = entranceCostMinor(q.get('c'), ctx.source, ctx.graph, ctx.currency);
    const { destination } = step;
    await saveStep(siteStub(c.env.ANALYTICS, site.siteId), {
      touches: [
        touchOf(base, 'entrance', newHitId(), entryId, {
          costMinor: cost,
          pageId: entryId === destination.nodeId ? (destination.pageId ?? null) : null,
        }),
        touchOf(base, 'view', hitId, destination.nodeId, { pageId: destination.pageId ?? null, order: 1 }),
      ],
      session: sessionInput(visitorId, funnelId, step, base),
      tags: tagChange(visitorId, ctx.tags, step),
    });
    deliverEffects(c, step, deps);
  }
  return redirect(c, site, target, visitorId);
}

// ------------------------------------------------------------------ actions

interface ActionDefaults {
  funnelId: string;
  nodeId: string;
}

type OriginMethod = 'explicit' | 'referrer' | 'cookie' | 'default';

interface ActionOrigin {
  visitorId: string;
  /** Origin node named by the request (`rn`, referrer `n`), if any. */
  nodeId: string | null;
  method: OriginMethod;
}

function parseReferrer(raw: string | null): URL | null {
  if (raw === null || raw === '') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Session and origin of an action link, in the documented fallback order. */
export function resolveActionOrigin(
  q: URLSearchParams,
  referrer: URL | null,
  cookieVisitorId: string | null,
  defaults: ActionDefaults | null,
): ActionOrigin | null {
  const rn = validNodeId(q.get('rn'));
  const vid = validVisitorId(q.get('vid'));
  if (vid !== null) return { visitorId: vid, nodeId: rn, method: 'explicit' };
  const refVid = validVisitorId(referrer?.searchParams.get('vid'));
  const refNode = validNodeId(referrer?.searchParams.get('n'));
  if (refVid !== null) return { visitorId: refVid, nodeId: rn ?? refNode, method: 'referrer' };
  if (cookieVisitorId !== null) {
    return { visitorId: cookieVisitorId, nodeId: rn ?? refNode, method: refNode !== null ? 'referrer' : 'cookie' };
  }
  if (defaults !== null) return { visitorId: newVisitorId(), nodeId: rn ?? defaults.nodeId, method: 'default' };
  return null;
}

const stripQuery = (u: string): string => u.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '');

/** Page node whose page URL is the referrer (repeat clicks from another tab). */
function pageNodeOfReferrer(graph: FunnelGraph, referrer: URL | null): { nodeId: string; pageId: string } | null {
  if (referrer === null) return null;
  const ref = stripQuery(referrer.toString());
  for (const node of graph.nodes) {
    if (node.kind !== 'page_group' || node.deleted_at != null) continue;
    const page = node.config.pages.find((p) => p.url !== undefined && stripQuery(p.url) === ref);
    if (page !== undefined) return { nodeId: node.id, pageId: page.id };
  }
  return null;
}

function pageNode(graph: FunnelGraph, id: string | null | undefined): FunnelNodeOf<'page_group'> | null {
  const node = id == null ? undefined : graph.nodes.find((n) => n.id === id);
  return node?.kind === 'page_group' ? node : null;
}

async function action(c: Ctx, deps: Deps, defaults: ActionDefaults | null): Promise<Response> {
  const raw = c.req.param('n') ?? '';
  const n = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > MAX_FUNNEL_ACTION) return notFound(c);
  if (defaults !== null && (validObjectId(defaults.funnelId) === null || validNodeId(defaults.nodeId) === null)) {
    return notFound(c);
  }
  const site = await linkSite(c, deps);
  if (site === null) return notFound(c);

  const q = new URL(c.req.url).searchParams;
  const facts = requestFacts(c.req.raw);
  const referrer = parseReferrer(facts.referrer);
  const origin = resolveActionOrigin(q, referrer, validVisitorId(getCookie(c, VISITOR_COOKIE)), defaults);
  if (origin === null) return notFound(c);
  const { visitorId } = origin;
  const ctx = await linkContext(c, site, {
    visitor_id: visitorId,
    ...(defaults === null ? {} : { funnel_id: defaults.funnelId, latest_session: true }),
  });
  if (ctx === null || ctx.graph === null) return notFound(c);
  const { graph, session } = ctx;

  // Default parameters only apply when no session is known.
  const byReferrerPage = origin.nodeId === null ? pageNodeOfReferrer(graph, referrer) : null;
  const candidates = [
    origin.nodeId,
    byReferrerPage?.nodeId,
    session?.current_node_id,
    session === null ? defaults?.nodeId : undefined,
  ];
  const fromNode = candidates.map((id) => pageNode(graph, id)).find((node) => node !== null) ?? null;
  if (fromNode === null) return notFound(c);
  const fromPageId =
    byReferrerPage?.nodeId === fromNode.id
      ? byReferrerPage.pageId
      : session?.current_node_id === fromNode.id
        ? session.current_page_id
        : null;

  const hitId = newHitId();
  const slots = session?.fields ?? {};
  const tracking: CapturedTracking = {
    campaign: session?.campaign ?? null,
    external: session?.external_click_id ?? null,
    slots,
    names: namesOfSlots(ctx.source, slots),
    data: captureTracking(null, q).data,
  };
  const sourceId = session?.traffic_source_id ?? null;
  const visit = visitContext(facts, { hitId, visitorId, funnelId: graph.id, trafficSourceId: sourceId, timezone: ctx.timezone }, tracking);
  const state: FunnelSessionState = {
    currentNodeId: fromNode.id,
    currentPageId: fromPageId,
    rotations: session?.rotations ?? {},
    tags: ctx.tags,
  };
  const routable = await routableGraph(c, deps, { ...ctx, graph });
  visit.hostedPageUrl = routable.hostedPageUrl;
  const step = runStep(routable.graph, state, { type: 'action', action: n, fromNodeId: fromNode.id }, visit, deps);
  const target = step === null ? null : destinationUrl(step);
  if (step === null || target === null) return unavailable(c);

  if (detectBot(facts.userAgent) === null) {
    const base: TouchBase = {
      ts: deps.now(),
      visitorId,
      sessionId: visitorId,
      funnelId: graph.id,
      trafficSourceId: sourceId,
      campaign: tracking.campaign,
      external: tracking.external,
      slots,
    };
    // Without a known session the visitor was never seen on the origin page.
    const kind = session === null && origin.method === 'default' ? 'action' : 'click';
    const { destination } = step;
    await saveStep(siteStub(c.env.ANALYTICS, site.siteId), {
      touches: [
        touchOf(base, kind, newHitId(), fromNode.id, { pageId: fromPageId, action: n }),
        touchOf(base, 'view', hitId, destination.nodeId, { pageId: destination.pageId ?? null, order: 1 }),
      ],
      session: sessionInput(visitorId, graph.id, step, base),
      tags: tagChange(visitorId, ctx.tags, step),
    });
    deliverEffects(c, step, deps);
  }
  return redirect(c, site, target, visitorId);
}

// ------------------------------------------------------------- direct links

/** Entrance + view of a page reached directly from an ad (pageview with `f`, `ts`, `n`). */
export async function recordDirectLinkView(
  env: Env,
  siteId: string,
  view: DirectLinkView,
  facts: RequestFacts,
  now: number = Date.now(),
): Promise<boolean> {
  const stub = siteStub(env.ANALYTICS, siteId);
  const res = await stub.funnelLinkContext({
    funnel_id: view.funnelId,
    traffic_source_id: view.trafficSourceId,
    visitor_id: view.visitorId,
  });
  if (!res.ok) return false;
  const ctx = res.value as FunnelLinkContext;
  if (ctx.graph === null || ctx.source === null) return false;
  const node = pageNode(ctx.graph, view.nodeId);
  if (node === null || node.deleted_at != null) return false;
  const pages = node.config.pages;
  const pageId = view.pageId ?? (pages.length === 1 ? pages[0]!.id : null);
  if (pageId !== null && !pages.some((p) => p.id === pageId)) return false;
  if (detectBot(facts.userAgent) !== null) return false;

  const tracking = captureTracking(ctx.source, view.url.searchParams);
  const base: TouchBase = {
    ts: now,
    visitorId: view.visitorId,
    sessionId: view.sessionId,
    funnelId: view.funnelId,
    trafficSourceId: view.trafficSourceId,
    campaign: tracking.campaign,
    external: tracking.external,
    slots: tracking.slots,
  };
  const cost = entranceCostMinor(view.url.searchParams.get('c'), ctx.source, ctx.graph, ctx.currency);
  const result = await stub.recordFunnelStep({
    touches: [
      touchOf(base, 'entrance', newHitId(), node.id, { pageId, costMinor: cost }),
      touchOf(base, 'view', newHitId(), node.id, { pageId, order: 1 }),
    ],
    session: {
      visitor_id: view.visitorId,
      funnel_id: view.funnelId,
      current_node_id: node.id,
      current_page_id: pageId,
      rotations: ctx.session?.rotations ?? {},
      traffic_source_id: view.trafficSourceId,
      campaign: tracking.campaign,
      external_click_id: tracking.external,
      fields: Object.keys(tracking.slots).length === 0 ? null : tracking.slots,
    },
  });
  return result.ok;
}

/**
 * Tracker visitor and funnel visitor of a page reached through an entrance or
 * action redirect: the landing URL carries the funnel `vid`, which the tracker
 * echoes as `dl.vid`. Only the landing itself counts (the tracker resends its
 * funnel context with every event).
 */
export function funnelVisitorLink(payload: TrackerEvent): { visitorId: string; funnelVisitorId: string } | null {
  const funnelVisitorId = validVisitorId(payload.dl?.vid);
  if (payload.type !== 'pageview' || payload.cl === 1 || payload.vid === undefined || funnelVisitorId === null) return null;
  if (funnelVisitorId === payload.vid) return null;
  try {
    if (new URL(payload.url).searchParams.get('vid') !== funnelVisitorId) return null;
  } catch {
    return null;
  }
  return { visitorId: payload.vid, funnelVisitorId };
}

/**
 * Wraps `POST /e`: once the ingest accepted a pageview, links the tracker
 * visitor of a redirected landing to its funnel visitor, and records the
 * funnel touches of a direct-link landing, both in the background.
 */
export const directLinkViews: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  let payload: TrackerEvent | null = null;
  if (c.req.method === 'POST' && Number(c.req.header('content-length') ?? '0') <= MAX_EVENT_BYTES) {
    try {
      const text = await c.req.text();
      const parsed = text.length <= MAX_EVENT_BYTES ? trackerEventSchema.safeParse(JSON.parse(text)) : null;
      if (parsed?.success === true) payload = parsed.data;
    } catch {
      // the ingest answers malformed bodies itself
    }
  }
  await next();
  if (payload === null || c.res.status !== 202 || !SITE_ID_RE.test(payload.site)) return;
  const facts = requestFacts(c.req.raw);
  const link = funnelVisitorLink(payload);
  if (link !== null && detectBot(facts.userAgent) === null) {
    background(
      c,
      siteStub(c.env.ANALYTICS, payload.site)
        .linkFunnelVisitor({ visitor_id: link.visitorId, funnel_visitor_id: link.funnelVisitorId, ts: Date.now() })
        .catch((error: unknown) =>
          console.error('[links] funnel visitor not linked', error instanceof Error ? error.message : String(error)),
        ),
    );
  }
  const view = directLinkView(payload);
  if (view === null) return;
  background(
    c,
    recordDirectLinkView(c.env, payload.site, view, facts).catch((error: unknown) =>
      console.error('[links] direct link view not recorded', error instanceof Error ? error.message : String(error)),
    ),
  );
};

// ------------------------------------------------------------------- routes

export function createLinkRoutes(options: LinkRoutesOptions = {}): Hono<{ Bindings: Env }> {
  const deps: Deps = {
    resolvers: options.resolvers ?? DEFAULT_LINK_SITE_RESOLVERS,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    rng: options.rng ?? Math.random,
    now: options.now ?? Date.now,
    webhookTimeoutMs: options.webhookTimeoutMs ?? WEBHOOK_TIMEOUT_MS,
    hostedPages: options.hostedPages ?? ((env) => (tenantId, pageId) => resolveHostedPageUrl(env, tenantId, pageId)),
  };
  const app = new Hono<{ Bindings: Env }>();
  // Tracking hostnames: no prefix; shared edge host: `/s/{siteId}/…`.
  for (const prefix of ['', SITE_PATH_PREFIX]) {
    app.get(`${prefix}/go/${LINK_PARAM}`, (c) => entrance(c, deps));
    app.get(`${prefix}/go/${LINK_PARAM}/:nodeId`, (c) => entrance(c, deps));
    app.get(`${prefix}/go/${LINK_PARAM}/:nodeId/:pageId`, (c) => entrance(c, deps));
    app.get(`${prefix}/a/:n`, (c) => action(c, deps, null));
    app.get(`${prefix}/go/:funnelId/:nodeId/a/:n`, (c) =>
      action(c, deps, { funnelId: c.req.param('funnelId'), nodeId: c.req.param('nodeId') }),
    );
    registerPostbackRoutes(app, deps, prefix);
  }
  return app;
}

/** Link routes on the tracking hostnames known to the default resolvers and under `/s/{siteId}`. */
export const linkRoutes = createLinkRoutes();
