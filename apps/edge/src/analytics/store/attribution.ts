import {
  ATTRIBUTION_DIMENSIONS,
  type AttributionDimension,
  type AttributionModel,
  type Touch,
} from '@amable/api-types';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { filterSql, SESSION_COLUMNS, type ResolvedRange } from './query';

/** Channel of sessions without any campaign, referrer or click id. */
export const DIRECT_CHANNEL = 'Direct';

const ATTRIBUTION_DIMS = new Set<string>(ATTRIBUTION_DIMENSIONS);

export function isAttributionDimension(d: string): d is AttributionDimension {
  return ATTRIBUTION_DIMS.has(d);
}

/**
 * Credit of each touch (session) for one conversion, given the channels of the
 * touches before it in chronological order. Weights sum to 1 (or the list is
 * empty when there is no touch at all).
 *
 * - `first_touch`: everything to the first session;
 * - `last_touch`: everything to the last session, Direct included;
 * - `last_non_direct`: everything to the last session that was not Direct, or
 *   to the last session when all of them were Direct;
 * - `linear`: equal shares;
 * - `position_based`: 40% first, 40% last, 20% split between the middle ones
 *   (two touches: 50/50).
 */
export function creditTouches(
  channels: readonly string[],
  model: AttributionModel,
): Array<{ index: number; weight: number }> {
  const n = channels.length;
  if (n === 0) return [];
  if (model === 'first_touch') return [{ index: 0, weight: 1 }];
  if (model === 'last_touch') return [{ index: n - 1, weight: 1 }];
  if (model === 'linear') return channels.map((_, index) => ({ index, weight: 1 / n }));
  if (model === 'position_based') {
    if (n === 1) return [{ index: 0, weight: 1 }];
    if (n === 2) return [{ index: 0, weight: 0.5 }, { index: 1, weight: 0.5 }];
    return channels.map((_, index) => ({
      index,
      weight: index === 0 || index === n - 1 ? 0.4 : 0.2 / (n - 2),
    }));
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    if (channels[i] !== DIRECT_CHANNEL) return [{ index: i, weight: 1 }];
  }
  return [{ index: n - 1, weight: 1 }];
}

/** A person: the CRM contact across all its visitors, else a single visitor. */
export type PersonKey = string;

export function personKey(contactId: string | null, visitorId: string | null): PersonKey | null {
  if (contactId !== null) return `c:${contactId}`;
  if (visitorId !== null) return `v:${visitorId}`;
  return null;
}

export interface TouchRow {
  person: PersonKey;
  started_at: number;
  channel: string;
  source: string | null;
  referrer_host: string | null;
  campaign: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  country: string | null;
  value: string | null;
}

/**
 * Sessions (touches) of the given persons, oldest first, optionally restricted
 * by the query filters and to one dimension column (`value`).
 */
export function touchesOf(
  db: SqlDb,
  persons: readonly PersonKey[],
  opts: { until?: number; dimension?: AttributionDimension; filters?: ResolvedRange['filters'] } = {},
): Map<PersonKey, TouchRow[]> {
  const contacts = persons.filter((p) => p.startsWith('c:')).map((p) => p.slice(2));
  const visitors = persons.filter((p) => p.startsWith('v:')).map((p) => p.slice(2));
  const out = new Map<PersonKey, TouchRow[]>();
  if (contacts.length === 0 && visitors.length === 0) return out;
  const params: SqlValue[] = [JSON.stringify(contacts), JSON.stringify(visitors), opts.until ?? Number.MAX_SAFE_INTEGER];
  const where = filterSql(opts.filters ?? [], 's', params);
  const column = opts.dimension === undefined ? 'NULL' : `s.${SESSION_COLUMNS[opts.dimension]}`;
  const rows = db.all<{
    contact_id: string | null;
    visitor_id: string;
    started_at: number;
    channel: string;
    source: string | null;
    referrer_host: string | null;
    campaign: string | null;
    device: string | null;
    os: string | null;
    browser: string | null;
    country: string | null;
    value: string | null;
  }>(
    `SELECT v.contact_id AS contact_id, s.visitor_id AS visitor_id, s.started_at AS started_at, s.channel AS channel,
       s.source AS source, s.referrer_host AS referrer_host, s.utm_campaign AS campaign, s.device AS device,
       s.os AS os, s.browser AS browser, s.country AS country, ${column} AS value
     FROM sessions s JOIN visitors v ON v.id = s.visitor_id
     WHERE (v.contact_id IN (SELECT value FROM json_each(?)) OR s.visitor_id IN (SELECT value FROM json_each(?)))
       AND s.started_at <= ? AND ${where}
     ORDER BY s.started_at, s.id`,
    ...params,
  );
  const wanted = new Set(persons);
  for (const row of rows) {
    // A visitor linked to a contact belongs to the contact's person.
    const key = row.contact_id !== null && wanted.has(`c:${row.contact_id}`)
      ? `c:${row.contact_id}`
      : `v:${row.visitor_id}`;
    if (!wanted.has(key)) continue;
    let list = out.get(key);
    if (list === undefined) {
      list = [];
      out.set(key, list);
    }
    list.push({
      person: key,
      started_at: row.started_at,
      channel: row.channel,
      source: row.source,
      referrer_host: row.referrer_host,
      campaign: row.campaign,
      device: row.device,
      os: row.os,
      browser: row.browser,
      country: row.country,
      value: row.value,
    });
  }
  return out;
}

export interface ConversionRow {
  transaction_id: string;
  ts: number;
  amount: number;
  person: PersonKey | null;
}

/** Revenue-bearing payments of [from, to) in the site currency, with their person. */
export function conversionsIn(
  db: SqlDb,
  from: number,
  to: number,
  currency: string,
): ConversionRow[] {
  return db
    .all<{
      transaction_id: string;
      ts: number;
      amount: number;
      contact_id: string | null;
      visitor_id: string | null;
    }>(
      `SELECT t.transaction_id AS transaction_id, t.ts AS ts, t.amount_minor - t.refunded_minor AS amount,
         COALESCE(v.contact_id, t.contact_id) AS contact_id, t.visitor_id AS visitor_id
       FROM payments t LEFT JOIN visitors v ON v.id = t.visitor_id
       WHERE t.ts >= ? AND t.ts < ? AND t.refunded = 0 AND t.free_trial = 0 AND t.currency = ?
       ORDER BY t.ts, t.id`,
      from,
      to,
      currency,
    )
    .map((r) => ({
      transaction_id: r.transaction_id,
      ts: r.ts,
      amount: r.amount,
      person: personKey(r.contact_id, r.visitor_id),
    }));
}

export interface AttributedValue {
  revenue: number;
  conversions: number;
}

/**
 * Splits an integer amount by weights (summing to 1) into integers that add
 * up exactly to the amount: floors first, then the leftover units go to the
 * largest remainders (earlier shares win ties).
 */
export function splitMinor(amount: number, weights: readonly number[]): number[] {
  const raw = weights.map((w) => amount * w);
  const out = raw.map((v) => Math.floor(v));
  let left = amount - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, rem: v - Math.floor(v) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left -= 1) {
    const slot = order[k];
    if (slot !== undefined) out[slot.i] = (out[slot.i] ?? 0) + 1;
  }
  return out;
}

/**
 * Revenue and conversions of the range credited to the values of a source
 * dimension with an attribution model. Touches are the person's sessions up to
 * each payment (all visitors of a contact merged). With filters, only matching
 * sessions count as touches and payments without one are left out; without
 * filters, payments without any touch are credited to `null`.
 */
export function attributeRevenue(
  db: SqlDb,
  r: ResolvedRange,
  dimension: AttributionDimension,
  model: AttributionModel,
  currency: string,
): Map<string | null, AttributedValue> {
  return attributeRevenueByModel(db, r, dimension, [model], currency).byModel.get(model) ?? new Map();
}

export interface AttributionPass {
  byModel: Map<AttributionModel, Map<string | null, AttributedValue>>;
  totalRevenue: number;
  totalConversions: number;
}

/** {@link attributeRevenue} for several models over one read of payments and touches. */
export function attributeRevenueByModel(
  db: SqlDb,
  r: ResolvedRange,
  dimension: AttributionDimension,
  models: readonly AttributionModel[],
  currency: string,
): AttributionPass {
  const conversions = conversionsIn(db, r.from, r.to, currency);
  const persons = [...new Set(conversions.map((c) => c.person).filter((p): p is string => p !== null))];
  const touches = touchesOf(db, persons, { until: r.to, dimension, filters: r.filters });
  const byModel = new Map<AttributionModel, Map<string | null, AttributedValue>>();
  for (const m of models) byModel.set(m, new Map());
  const credit = (
    out: Map<string | null, AttributedValue>,
    value: string | null,
    revenue: number,
    weight: number,
  ): void => {
    const cur = out.get(value) ?? { revenue: 0, conversions: 0 };
    cur.revenue += revenue;
    cur.conversions += weight;
    out.set(value, cur);
  };
  let totalRevenue = 0;
  let totalConversions = 0;
  for (const c of conversions) {
    const before = (c.person === null ? [] : (touches.get(c.person) ?? [])).filter(
      (t) => t.started_at <= c.ts,
    );
    if (before.length === 0) {
      if (r.filters.length === 0) {
        for (const out of byModel.values()) credit(out, null, c.amount, 1);
        totalRevenue += c.amount;
        totalConversions += 1;
      }
      continue;
    }
    totalRevenue += c.amount;
    totalConversions += 1;
    const channels = before.map((t) => t.channel);
    for (const [m, out] of byModel) {
      const shares = creditTouches(channels, m);
      const amounts = splitMinor(c.amount, shares.map((s) => s.weight));
      shares.forEach(({ index, weight }, k) => {
        const touch = before[index];
        if (touch !== undefined) credit(out, touch.value, amounts[k] ?? 0, weight);
      });
    }
  }
  for (const out of byModel.values()) {
    for (const v of out.values()) v.conversions = Math.round(v.conversions * 1000) / 1000;
  }
  return { byModel, totalRevenue, totalConversions };
}

function toTouch(t: TouchRow): Touch {
  return {
    ts: new Date(t.started_at).toISOString(),
    channel: t.channel,
    source: t.source,
    referrer_host: t.referrer_host,
    campaign: t.campaign,
  };
}

/** First touch and last non-direct touch of a chronological touch list. */
export function keyTouches(
  touches: readonly TouchRow[],
): { first: Touch | null; lastNonDirect: Touch | null } {
  const firstTouch = touches[0];
  const last = creditTouches(touches.map((t) => t.channel), 'last_non_direct')[0];
  const lastTouch = last === undefined ? undefined : touches[last.index];
  return {
    first: firstTouch === undefined ? null : toTouch(firstTouch),
    lastNonDirect: lastTouch === undefined ? null : toTouch(lastTouch),
  };
}

/** Visitor ids of a person (all visitors of its contact, else itself). */
export function visitorIdsOf(db: SqlDb, visitorId: string): { contactId: string | null; ids: string[] } {
  const contact =
    first<{ contact_id: string | null }>(db, `SELECT contact_id FROM visitors WHERE id = ?`, visitorId)
      ?.contact_id ?? null;
  if (contact === null) return { contactId: null, ids: [visitorId] };
  const ids = db
    .all<{ id: string }>(`SELECT id FROM visitors WHERE contact_id = ? ORDER BY first_seen, id`, contact)
    .map((r) => r.id);
  return { contactId: contact, ids: ids.length === 0 ? [visitorId] : ids };
}
