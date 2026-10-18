import type { FunnelGraph, FunnelTouch } from '@amable/api-types';
import type { Context, Hono } from 'hono';
import type { Env } from '../../env';
import { toMinor } from '../enrich';
import { enqueueConversionOutbound } from '../outbound-enqueue';
import type { OutboundPii } from '../outbound-worker';
import { siteStub } from '../rpc';
import type { ConversionStatus } from '../store/touches';
import { requestLinkSite, type LinkSiteResolver } from './site';
import { validNodeId, validVisitorId } from './visit';

/**
 * Incoming conversion postbacks (server to server, from a network or a shop):
 * `GET /pb?hit=…` or `?vid=…[&p=PAGE]`, with `rev`, `tx`, `status`,
 * `rev_share`, `conversion_time`, `disable_postbacks` and pass-through PII
 * (`pii_email`, `pii_phone`…) that only reaches the outbound queue. Custom
 * events: `GET /pb/event?hit=…&e=N`. Writes are idempotent on hit + event + tx.
 */

type Ctx = Context<{ Bindings: Env }>;

export interface PostbackDeps {
  resolvers: readonly LinkSiteResolver[];
  now: () => number;
}

const HIT_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REV_RE = /^-?\d{1,12}(?:\.\d{1,9})?$/;
const SHARE_RE = /^\d{1,3}(?:\.\d{1,6})?$/;
export const MAX_CUSTOM_EVENT = 10;

const PENDING_STATUSES = new Set(['pending', 'hold', 'preapproved']);
const REJECTED_STATUSES = new Set(['rejected', 'reject', 'trash', 'cancelled', 'canceled']);

/** Provisional revenue of a pending conversion: one minor unit (0.01). */
export const PENDING_REVENUE_MINOR = 1;

function answer(c: Ctx, status: 200 | 400 | 404, body: string): Response {
  return c.text(body, status, { 'cache-control': 'no-store' });
}

const truthy = (v: string | null): boolean => v === '1' || v === 'true';

function clip(v: string | null, max: number): string | null {
  const t = v?.trim() ?? '';
  return t === '' ? null : t.slice(0, max);
}

/** PII of the postback, kept in memory for the outbound queue only. */
export function postbackPii(q: URLSearchParams): OutboundPii {
  const pii: OutboundPii = {};
  const email = clip(q.get('pii_email') ?? q.get('email'), 320);
  const phone = clip(q.get('pii_phone') ?? q.get('phone'), 64);
  const ip = clip(q.get('pii_ip'), 64);
  const ua = clip(q.get('pii_ua') ?? q.get('pii_user_agent'), 4096);
  if (email !== null) pii.email = email;
  if (phone !== null) pii.phone = phone;
  if (ip !== null) pii.ip = ip;
  if (ua !== null) pii.user_agent = ua;
  return pii;
}

/** `conversion_time` (unix seconds or ms); the postback time when invalid or before the hit. */
export function conversionTime(raw: string | null, hitTs: number, now: number): number {
  if (raw === null || !/^\d{1,13}$/.test(raw)) return now;
  const n = Number(raw);
  const ms = raw.length <= 10 ? n * 1000 : n;
  return ms < hitTs || ms > now ? now : ms;
}

function isOfferView(graph: FunnelGraph | null, touch: FunnelTouch): boolean {
  const node = graph?.nodes.find((n) => n.id === touch.node_id);
  return node?.kind === 'page_group' && node.config.page_type === 'offer';
}

type Stub = ReturnType<typeof siteStub>;

/** View converted by `vid` (+ `p`): the latest view of that page, else the latest offer view, else the latest view. */
async function touchOfVisitor(stub: Stub, vid: string, pageId: string | null): Promise<FunnelTouch | null> {
  const views = (await stub.listTouchesByVisitor(vid, 1000)).filter((t) => t.kind === 'view');
  if (pageId !== null) return views.filter((t) => t.page_id === pageId).at(-1) ?? null;
  const last = views.at(-1);
  if (last === undefined) return null;
  const graph = await stub.getFunnelGraph(last.funnel_id);
  return views.filter((t) => t.funnel_id === last.funnel_id && isOfferView(graph, t)).at(-1) ?? last;
}

async function postback(c: Ctx, deps: PostbackDeps, kind: 'conversion' | 'event'): Promise<Response> {
  const url = new URL(c.req.url);
  const q = url.searchParams;
  const site = await requestLinkSite(c, deps.resolvers);
  if (site === null) return answer(c, 404, 'unknown host');

  const hitParam = q.get('hit');
  const hit = hitParam === null || hitParam === '' ? null : HIT_RE.test(hitParam) ? hitParam : undefined;
  const vid = validVisitorId(q.get('vid'));
  if (hit === undefined) return answer(c, 400, 'invalid hit');
  if (hit === null && vid === null) return answer(c, 400, 'hit or vid required');
  const pageParam = q.get('p');
  const pageId = pageParam === null ? null : validNodeId(pageParam);
  if (pageParam !== null && pageId === null) return answer(c, 400, 'invalid p');

  let event = 'sale';
  let tx = '';
  if (kind === 'event') {
    const num = q.get('e') ?? q.get('num') ?? '';
    const n = /^\d{1,2}$/.test(num) ? Number(num) : 0;
    if (n < 1 || n > MAX_CUSTOM_EVENT) return answer(c, 400, 'invalid event number');
    event = `event:${n}`;
  } else {
    const e = q.get('event');
    if (e !== null && e !== 'sale' && e !== 'lead') return answer(c, 400, 'invalid event');
    event = e ?? 'sale';
    const t = q.get('tx')?.trim() ?? '';
    if (t.length > 255) return answer(c, 400, 'invalid tx');
    tx = t;
  }

  const rev = q.get('rev')?.trim() ?? '';
  if (rev !== '' && !REV_RE.test(rev)) return answer(c, 400, 'invalid rev');
  const shareRaw = q.get('rev_share');
  if (shareRaw !== null && (!SHARE_RE.test(shareRaw) || Number(shareRaw) > 100)) return answer(c, 400, 'invalid rev_share');
  let amount = rev === '' ? 0 : Number(rev);
  let status: ConversionStatus = 'approved';
  const statusRaw = q.get('status')?.trim().toLowerCase() ?? '';
  if (PENDING_STATUSES.has(statusRaw)) status = 'pending';
  if (REJECTED_STATUSES.has(statusRaw) || amount === -1) status = 'rejected';
  if (status === 'approved' && amount < 0) return answer(c, 400, 'invalid rev');
  if (shareRaw !== null) amount = (amount * Number(shareRaw)) / 100;

  const stub = siteStub(c.env.ANALYTICS, site.siteId);
  const record = await stub.getSite();
  if (record === null || record.deleted) return answer(c, 404, 'unknown host');
  const touch = hit !== null ? await stub.getTouch(hit) : await touchOfVisitor(stub, vid!, pageId);
  if (touch === null) return answer(c, 404, 'unknown hit');

  const now = deps.now();
  const currency = record.site.currency;
  if (status === 'rejected') {
    // A rejection reverses an existing conversion and never creates one.
    const existing = (await stub.listConversions({ hit: touch.id, limit: 10_000 })).find(
      (cv) => cv.event === event && cv.tx === tx,
    );
    if (existing === undefined) return answer(c, 200, 'ok');
  }
  const data: Record<string, string> = {};
  for (const key of ['event_data1', 'event_data2'] as const) {
    const v = clip(q.get(key), 512);
    if (v !== null) data[key] = v;
  }
  const result = await stub.recordConversionFromPostback({
    hit: touch.id,
    tx: tx === '' ? null : tx,
    event,
    status,
    revenue_minor: status === 'pending' ? PENDING_REVENUE_MINOR : status === 'rejected' ? 0 : toMinor(amount, currency),
    currency,
    ts: conversionTime(q.get('conversion_time'), touch.ts, now),
    source: 'postback',
    ...(Object.keys(data).length > 0 ? { data } : {}),
  });
  if (!result.ok) return answer(c, 400, result.error.message);

  // Pending conversions are forwarded once approved (a skipped job would block the event id).
  if (status === 'approved' && !truthy(q.get('disable_postbacks'))) {
    await enqueueConversionOutbound(
      stub,
      { id: result.value.id },
      touch.traffic_source_id ? { id: touch.traffic_source_id } : null,
      postbackPii(q),
      { consent: q.get('consent') !== '0' },
    );
  }
  return answer(c, 200, 'ok');
}

export function registerPostbackRoutes(app: Hono<{ Bindings: Env }>, deps: PostbackDeps, prefix = ''): void {
  for (const path of ['/pb', '/pb/']) app.get(`${prefix}${path}`, (c) => postback(c, deps, 'conversion'));
  for (const path of ['/pb/event', '/pb/event/']) app.get(`${prefix}${path}`, (c) => postback(c, deps, 'event'));
}
