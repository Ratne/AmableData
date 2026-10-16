import type {
  AnalyticsPurchase,
  JourneyItem,
  Prediction,
  VisitorProfile,
  VisitorSession,
  VisitorsList,
  VisitorSummary,
} from '@amable/api-types';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { dayKey } from '../time';
import { keyTouches, personKey, touchesOf, visitorIdsOf } from './attribution';
import { timeToConversion } from './insights';
import { loadModel, predictVisitors } from './prediction';
import { filterSql, type ResolvedRange } from './query';

const iso = (ts: number): string => new Date(ts).toISOString();

type ParamValue = string | number | boolean;

function parseParams(raw: string | null): Record<string, ParamValue> | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, ParamValue>) : null;
  } catch {
    return null;
  }
}

interface VisitorRow {
  id: string;
  contact_id: string | null;
  name: string | null;
  email: string | null;
  user_id: string | null;
  traits: string | null;
  first_seen: number;
  last_seen: number;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  first_channel: string | null;
  first_source: string | null;
  sessions: number;
  pageviews: number;
  goals: number;
  revenue: number;
}

const VISITOR_SELECT = `v.id AS id, v.contact_id AS contact_id, v.name AS name, v.email AS email, v.user_id AS user_id,
  v.traits AS traits, v.first_seen AS first_seen, v.last_seen AS last_seen, v.country AS country, v.device AS device,
  v.browser AS browser, v.os AS os, v.first_channel AS first_channel, v.first_source AS first_source,
  (SELECT COUNT(*) FROM sessions s WHERE s.visitor_id = v.id) AS sessions,
  (SELECT COALESCE(SUM(s.pageviews), 0) FROM sessions s WHERE s.visitor_id = v.id) AS pageviews,
  (SELECT COUNT(*) FROM goals g WHERE g.visitor_id = v.id) AS goals,
  (SELECT COALESCE(SUM(p.amount_minor - p.refunded_minor), 0) FROM payments p
     WHERE p.visitor_id = v.id AND p.refunded = 0 AND p.currency = ?) AS revenue`;

function toSummary(row: VisitorRow, prediction: Prediction | null): VisitorSummary {
  return {
    visitor_id: row.id,
    contact_id: row.contact_id,
    name: row.name,
    email: row.email,
    user_id: row.user_id,
    first_seen: iso(row.first_seen),
    last_seen: iso(row.last_seen),
    sessions: row.sessions,
    pageviews: row.pageviews,
    goals: row.goals,
    revenue_minor: row.revenue,
    customer: row.revenue > 0,
    country: row.country,
    device: row.device,
    browser: row.browser,
    os: row.os,
    first_channel: row.first_channel,
    first_source: row.first_source,
    prediction,
  };
}

export interface VisitorListQuery {
  q?: string | undefined;
  identified?: boolean | undefined;
  customers?: boolean | undefined;
  sort: 'last_seen' | 'revenue' | 'score' | 'sessions';
  limit: number;
  cursor?: string | undefined;
}

function escapeLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** Visitors with a session in the range (matching the filters). Offset cursors. */
export function listVisitors(
  db: SqlDb,
  r: ResolvedRange,
  query: VisitorListQuery,
  currency: string,
  now: number,
): VisitorsList {
  const offset = query.cursor !== undefined && /^o\d{1,7}$/.test(query.cursor) ? Number(query.cursor.slice(1)) : 0;
  const params: SqlValue[] = [currency, r.from, r.to];
  const sessionWhere = filterSql(r.filters, 's', params);
  const where: string[] = [
    `EXISTS (SELECT 1 FROM sessions s WHERE s.visitor_id = v.id AND s.started_at >= ? AND s.started_at < ? AND ${sessionWhere})`,
  ];
  if (query.q !== undefined && query.q.trim() !== '') {
    const like = escapeLike(query.q.trim().toLowerCase());
    where.push(
      `(lower(v.id) LIKE ? ESCAPE '\\' OR lower(COALESCE(v.email, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(v.name, '')) LIKE ? ESCAPE '\\' OR lower(COALESCE(v.user_id, '')) LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like);
  }
  if (query.identified === true) where.push(`(v.contact_id IS NOT NULL OR v.email IS NOT NULL OR v.user_id IS NOT NULL)`);
  if (query.identified === false) where.push(`(v.contact_id IS NULL AND v.email IS NULL AND v.user_id IS NULL)`);
  if (query.customers !== undefined) {
    where.push(
      `${query.customers ? '' : 'NOT '}EXISTS (SELECT 1 FROM payments p WHERE p.visitor_id = v.id AND p.free_trial = 0 AND p.refunded = 0)`,
    );
  }
  const order =
    query.sort === 'revenue'
      ? 'revenue DESC, v.last_seen DESC, v.id'
      : query.sort === 'sessions'
        ? 'sessions DESC, v.last_seen DESC, v.id'
        : 'v.last_seen DESC, v.id';
  const model = loadModel(db);
  const byScore = query.sort === 'score';
  // Scores are computed, not stored: sort the 500 most recent candidates.
  const take = byScore ? 500 : query.limit + 1;
  const rows = db.all<VisitorRow>(
    `SELECT ${VISITOR_SELECT} FROM visitors v WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    take,
    byScore ? 0 : offset,
  );
  const predictions = predictVisitors(db, model, rows.map((row) => row.id), now);
  let list = rows.map((row) => toSummary(row, predictions.get(row.id) ?? null));
  if (byScore) {
    list = list
      .sort((a, b) => (b.prediction?.score ?? -1) - (a.prediction?.score ?? -1) || a.visitor_id.localeCompare(b.visitor_id))
      .slice(offset, offset + query.limit + 1);
  }
  const more = list.length > query.limit;
  return { data: list.slice(0, query.limit), next_cursor: more ? `o${offset + query.limit}` : null };
}

function sessionsOf(db: SqlDb, ids: readonly string[], limit: number): VisitorSession[] {
  const rows = db.all<{
    id: string;
    visitor_id: string;
    started_at: number;
    last_seen: number;
    duration_ms: number;
    channel: string;
    source: string | null;
    referrer_host: string | null;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    entry_path: string | null;
    exit_path: string | null;
    country: string | null;
    city: string | null;
    device: string | null;
    browser: string | null;
    os: string | null;
    revenue_minor: number;
  }>(
    `SELECT id, visitor_id, started_at, last_seen, duration_ms, channel, source, referrer_host, utm_source, utm_medium,
       utm_campaign, entry_path, exit_path, country, city, device, browser, os, revenue_minor
     FROM sessions WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY started_at DESC, id LIMIT ?`,
    JSON.stringify(ids),
    limit,
  );
  if (rows.length === 0) return [];
  const sids = JSON.stringify(rows.map((r) => r.id));
  const pages = new Map<string, VisitorSession['pageviews']>();
  for (const pv of db.all<{ session_id: string; ts: number; path: string; hostname: string }>(
    `SELECT session_id, ts, path, hostname FROM pageviews WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY ts, id`,
    sids,
  )) {
    const list = pages.get(pv.session_id) ?? [];
    list.push({ ts: iso(pv.ts), path: pv.path, hostname: pv.hostname });
    pages.set(pv.session_id, list);
  }
  const goals = new Map<string, VisitorSession['goals']>();
  for (const g of db.all<{ session_id: string; ts: number; name: string; path: string | null; params: string | null }>(
    `SELECT session_id, ts, name, path, params FROM goals WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY ts, id`,
    sids,
  )) {
    const list = goals.get(g.session_id) ?? [];
    list.push({ ts: iso(g.ts), name: g.name, path: g.path, params: parseParams(g.params) });
    goals.set(g.session_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    visitor_id: r.visitor_id,
    started_at: iso(r.started_at),
    last_seen: iso(r.last_seen),
    duration_ms: r.duration_ms,
    channel: r.channel,
    source: r.source,
    referrer_host: r.referrer_host,
    utm_source: r.utm_source,
    utm_medium: r.utm_medium,
    utm_campaign: r.utm_campaign,
    entry_page: r.entry_path,
    exit_page: r.exit_path,
    country: r.country,
    city: r.city,
    device: r.device,
    browser: r.browser,
    os: r.os,
    revenue_minor: r.revenue_minor,
    pageviews: pages.get(r.id) ?? [],
    goals: goals.get(r.id) ?? [],
  }));
}

interface PaymentRow {
  transaction_id: string;
  ts: number;
  amount_minor: number;
  refunded_minor: number;
  currency: string;
  renewal: number;
  source: string;
  order_id: string | null;
  visitor_id: string | null;
  contact_id: string | null;
  name: string | null;
  email: string | null;
}

const PAYMENT_SELECT = `p.transaction_id AS transaction_id, p.ts AS ts, p.amount_minor AS amount_minor,
  p.refunded_minor AS refunded_minor, p.currency AS currency, p.renewal AS renewal, p.source AS source,
  p.order_id AS order_id, p.visitor_id AS visitor_id, COALESCE(v.contact_id, p.contact_id) AS contact_id,
  v.name AS name, COALESCE(v.email, p.email) AS email`;

function toPurchase(row: PaymentRow, timeZone: string): AnalyticsPurchase {
  return {
    transaction_id: row.transaction_id,
    ts: iso(row.ts),
    label: dayKey(row.ts, timeZone),
    amount_minor: row.amount_minor,
    refunded_minor: row.refunded_minor,
    currency: row.currency,
    renewal: row.renewal === 1,
    source: row.source === 'crm' || row.source === 'server' ? row.source : 'tracker',
    order_id: row.order_id,
    visitor_id: row.visitor_id,
    contact_id: row.contact_id,
    name: row.name,
    email: row.email,
  };
}

/** Purchases of the range (free trials excluded), newest first. */
export function purchases(db: SqlDb, r: ResolvedRange, limit: number, anonymous: boolean): AnalyticsPurchase[] {
  const jp: SqlValue[] = [];
  const join = r.filters.length === 0 ? '' : `JOIN sessions s ON s.id = p.session_id AND ${filterSql(r.filters, 's', jp)}`;
  return db
    .all<PaymentRow>(
      `SELECT ${PAYMENT_SELECT} FROM payments p LEFT JOIN visitors v ON v.id = p.visitor_id ${join}
       WHERE p.ts >= ? AND p.ts < ? AND p.free_trial = 0 ORDER BY p.ts DESC, p.id DESC LIMIT ?`,
      ...jp,
      r.from,
      r.to,
      limit,
    )
    .map((row) =>
      toPurchase(
        anonymous ? { ...row, name: null, email: null, contact_id: null, visitor_id: null } : row,
        r.timeZone,
      ),
    );
}

function paymentsOf(db: SqlDb, ids: readonly string[], contactId: string | null, timeZone: string): AnalyticsPurchase[] {
  return db
    .all<PaymentRow>(
      `SELECT ${PAYMENT_SELECT} FROM payments p LEFT JOIN visitors v ON v.id = p.visitor_id
       WHERE p.free_trial = 0 AND (p.visitor_id IN (SELECT value FROM json_each(?)) OR (? IS NOT NULL AND p.contact_id = ?))
       ORDER BY p.ts DESC, p.id DESC LIMIT 200`,
      JSON.stringify(ids),
      contactId,
      contactId,
    )
    .map((row) => toPurchase(row, timeZone));
}

function goalTotals(db: SqlDb, ids: readonly string[]): VisitorProfile['completed_goals'] {
  return db
    .all<{ name: string; n: number; first_at: number; last_at: number }>(
      `SELECT name, COUNT(*) AS n, MIN(ts) AS first_at, MAX(ts) AS last_at FROM goals
       WHERE visitor_id IN (SELECT value FROM json_each(?)) GROUP BY name ORDER BY n DESC, name`,
      JSON.stringify(ids),
    )
    .map((g) => ({ name: g.name, count: g.n, first_at: iso(g.first_at), last_at: iso(g.last_at) }));
}

function pageTotals(db: SqlDb, ids: readonly string[], limit: number): VisitorProfile['visited_pages'] {
  return db
    .all<{ path: string; n: number; last_at: number }>(
      `SELECT path, COUNT(*) AS n, MAX(ts) AS last_at FROM pageviews
       WHERE visitor_id IN (SELECT value FROM json_each(?)) GROUP BY path ORDER BY n DESC, path LIMIT ?`,
      JSON.stringify(ids),
      limit,
    )
    .map((p) => ({ path: p.path, count: p.n, last_at: iso(p.last_at) }));
}

function firstPurchaseOf(db: SqlDb, ids: readonly string[], contactId: string | null): number | null {
  return (
    first<{ ts: number | null }>(
      db,
      `SELECT MIN(ts) AS ts FROM payments WHERE free_trial = 0
       AND (visitor_id IN (SELECT value FROM json_each(?)) OR (? IS NOT NULL AND contact_id = ?))`,
      JSON.stringify(ids),
      contactId,
      contactId,
    )?.ts ?? null
  );
}

/** Profile of a visitor, merged with every other visitor of the same contact. */
export function visitorProfile(
  db: SqlDb,
  visitorId: string,
  currency: string,
  timeZone: string,
  now: number,
): VisitorProfile | null {
  const row = first<VisitorRow>(db, `SELECT ${VISITOR_SELECT} FROM visitors v WHERE v.id = ?`, currency, visitorId);
  if (row === undefined) return null;
  const { contactId, ids } = visitorIdsOf(db, visitorId);
  const person = personKey(contactId, visitorId);
  const touches = person === null ? [] : (touchesOf(db, [person]).get(person) ?? []);
  const key = keyTouches(touches);
  const firstSeen = Math.min(
    ...db
      .all<{ first_seen: number }>(`SELECT first_seen FROM visitors WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))
      .map((v) => v.first_seen),
  );
  const prediction = predictVisitors(db, loadModel(db), [visitorId], now).get(visitorId) ?? null;
  return {
    visitor: toSummary(row, prediction),
    currency,
    traits: parseParams(row.traits),
    linked_visitor_ids: ids.filter((id) => id !== visitorId),
    sessions: sessionsOf(db, ids, 50),
    completed_goals: goalTotals(db, ids),
    visited_pages: pageTotals(db, ids, 50),
    payments: paymentsOf(db, ids, contactId, timeZone),
    first_touch: key.first,
    last_non_direct_touch: key.lastNonDirect,
    time_to_conversion: timeToConversion(touches, Number.isFinite(firstSeen) ? firstSeen : null, firstPurchaseOf(db, ids, contactId)),
  };
}

/** Site-level part of a contact journey (merged across sites by the core). */
export interface ContactActivity {
  site_id: string;
  currency: string;
  visitor_ids: string[];
  first_seen: number | null;
  first_purchase_at: number | null;
  first_visit: {
    ts: number;
    channel: string;
    source: string | null;
    referrer_host: string | null;
    campaign: string | null;
    entry_page: string | null;
  } | null;
  sessions: number;
  pageviews: number;
  goals: number;
  revenue_minor: number;
  sources: Array<{ channel: string; source: string | null; sessions: number }>;
  top_pages: Array<{ path: string; count: number }>;
  goal_totals: Array<{ name: string; count: number; last_at: string }>;
  /** Chronological touches (for cross-site first / last non-direct touch). */
  touches: Array<{ ts: number; channel: string; source: string | null; referrer_host: string | null; campaign: string | null }>;
  prediction: Prediction | null;
  items: JourneyItem[];
}

export function contactActivity(
  db: SqlDb,
  siteId: string,
  contactId: string,
  currency: string,
  limit: number,
  now: number,
): ContactActivity | null {
  const ids = db
    .all<{ id: string; first_seen: number }>(
      `SELECT id, first_seen FROM visitors WHERE contact_id = ? ORDER BY first_seen, id`,
      contactId,
    );
  const visitorIds = ids.map((v) => v.id);
  const payments = paymentsOf(db, visitorIds, contactId, 'UTC');
  if (visitorIds.length === 0 && payments.length === 0) return null;
  const person = `c:${contactId}`;
  const touches = touchesOf(db, [person]).get(person) ?? [];
  const sessions = sessionsOf(db, visitorIds, limit);
  const totals = first<{ sessions: number; pageviews: number | null }>(
    db,
    `SELECT COUNT(*) AS sessions, SUM(pageviews) AS pageviews FROM sessions WHERE visitor_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(visitorIds),
  );
  const goalCount =
    first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM goals WHERE visitor_id IN (SELECT value FROM json_each(?))`, JSON.stringify(visitorIds))?.n ?? 0;
  const firstSession = touches[0];
  const sourceCounts = new Map<string, { channel: string; source: string | null; sessions: number }>();
  for (const t of touches) {
    const key = `${t.channel}\u0000${t.source ?? ''}`;
    const cur = sourceCounts.get(key) ?? { channel: t.channel, source: t.source, sessions: 0 };
    cur.sessions += 1;
    sourceCounts.set(key, cur);
  }
  const items: JourneyItem[] = [];
  for (const s of sessions) {
    items.push({
      kind: 'session',
      ts: s.started_at,
      site_id: siteId,
      title: s.entry_page ?? '/',
      detail: [s.channel, s.source, s.utm_campaign].filter((x) => x !== null && x !== '').join(' · ') || null,
      channel: s.channel,
      path: s.entry_page,
      amount_minor: null,
      currency: null,
      ref: s.id,
      pages: s.pageviews.map((p) => p.path),
    });
    for (const g of s.goals) {
      if (g.name === 'payment' || g.name === 'free_trial') continue;
      items.push({
        kind: 'goal',
        ts: g.ts,
        site_id: siteId,
        title: g.name,
        detail: null,
        channel: s.channel,
        path: g.path,
        amount_minor: null,
        currency: null,
        ref: s.id,
      });
    }
  }
  // Goals outside sessions (server-side / lifecycle goals).
  for (const g of db.all<{ ts: number; name: string; path: string | null }>(
    `SELECT ts, name, path FROM goals WHERE session_id IS NULL AND visitor_id IN (SELECT value FROM json_each(?))
     AND name NOT IN ('payment', 'free_trial') ORDER BY ts DESC LIMIT ?`,
    JSON.stringify(visitorIds),
    limit,
  )) {
    items.push({
      kind: 'goal',
      ts: iso(g.ts),
      site_id: siteId,
      title: g.name,
      detail: null,
      channel: null,
      path: g.path,
      amount_minor: null,
      currency: null,
      ref: null,
    });
  }
  for (const p of payments) {
    // CRM orders appear as order items from the CRM itself; keep web payments only.
    if (p.source === 'crm') continue;
    items.push({
      kind: 'payment',
      ts: p.ts,
      site_id: siteId,
      title: p.transaction_id,
      detail: p.renewal ? 'renewal' : null,
      channel: null,
      path: null,
      amount_minor: p.amount_minor - p.refunded_minor,
      currency: p.currency,
      ref: p.order_id,
    });
  }
  for (const v of db.all<{ id: string; linked_at: number | null; link_source: string | null }>(
    `SELECT id, linked_at, link_source FROM visitors WHERE contact_id = ? AND linked_at IS NOT NULL`,
    contactId,
  )) {
    items.push({
      kind: 'identified',
      ts: iso(v.linked_at ?? 0),
      site_id: siteId,
      title: v.link_source ?? 'identify',
      detail: v.id,
      channel: null,
      path: null,
      amount_minor: null,
      currency: null,
      ref: v.id,
    });
  }
  const revenue = payments
    .filter((p) => p.currency === currency)
    .reduce((a, p) => a + p.amount_minor - p.refunded_minor, 0);
  const minFirstSeen = ids.length === 0 ? null : Math.min(...ids.map((v) => v.first_seen));
  const latest = visitorIds.at(-1);
  return {
    site_id: siteId,
    currency,
    visitor_ids: visitorIds,
    first_seen: minFirstSeen,
    first_purchase_at: firstPurchaseOf(db, visitorIds, contactId),
    first_visit:
      firstSession === undefined
        ? null
        : {
            ts: firstSession.started_at,
            channel: firstSession.channel,
            source: firstSession.source,
            referrer_host: firstSession.referrer_host,
            campaign: firstSession.campaign,
            entry_page:
              first<{ entry_path: string | null }>(
                db,
                `SELECT entry_path FROM sessions WHERE visitor_id IN (SELECT value FROM json_each(?)) ORDER BY started_at, id LIMIT 1`,
                JSON.stringify(visitorIds),
              )?.entry_path ?? null,
          },
    sessions: totals?.sessions ?? 0,
    pageviews: totals?.pageviews ?? 0,
    goals: goalCount,
    revenue_minor: revenue,
    sources: [...sourceCounts.values()].sort((a, b) => b.sessions - a.sessions),
    top_pages: pageTotals(db, visitorIds, 10).map((p) => ({ path: p.path, count: p.count })),
    goal_totals: goalTotals(db, visitorIds)
      .filter((g) => g.name !== 'payment' && g.name !== 'free_trial')
      .map((g) => ({ name: g.name, count: g.count, last_at: g.last_at })),
    touches: touches.map((t) => ({
      ts: t.started_at,
      channel: t.channel,
      source: t.source,
      referrer_host: t.referrer_host,
      campaign: t.campaign,
    })),
    prediction:
      latest === undefined ? null : (predictVisitors(db, loadModel(db), [latest], now).get(latest) ?? null),
    items: items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit),
  };
}
