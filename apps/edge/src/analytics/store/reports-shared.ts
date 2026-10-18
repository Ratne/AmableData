import {
  AD_PLATFORMS,
  TIME_DECAY_HALF_LIFE_DAYS,
  U_SHAPED_WEIGHTS,
  type AdEntityLevel,
  type AdPlatform,
  type AttributionModelV2,
  type TouchKind,
  type TrafficSource,
} from '@amable/api-types';
import type { SqlDb, SqlValue } from '../db/sql';
import { DAY_MS, dayKey } from '../time';
import { VISITOR_ORIGIN_CTE } from './identity';
import { resolveRange } from './query';
import { listTrafficSources } from './traffic-sources';

/**
 * Building blocks of the ad attribution reports: attribution weights of the
 * models, visitor groups (merged visitors and CRM contacts = one person), the
 * touch → ad entity mapping of the traffic sources, and the loaders of
 * revenue events and touch paths.
 */

// -------------------------------------------------------------------- models

/**
 * Credit of each touch of a path (oldest first) for one conversion at
 * `conversionTs`; the weights sum to 1 (empty path → empty list).
 *
 * - `first_click` / `last_click`: everything to the first / last touch;
 * - `linear`: equal shares;
 * - `u_shaped`: 40% first, 40% last, 20% split between the middle touches;
 *   one touch takes 100%, two touches take 50% each;
 * - `time_decay`: weight 2^(-age / 7 days), age = conversion time - touch time;
 * - `windowed_hybrid`: first touch when it happened within `windowDays` of the
 *   conversion, else last touch.
 */
export function modelWeights(
  touchTimes: readonly number[],
  conversionTs: number,
  model: AttributionModelV2,
  windowDays: number,
): number[] {
  const n = touchTimes.length;
  if (n === 0) return [];
  const only = (index: number): number[] => touchTimes.map((_, i) => (i === index ? 1 : 0));
  switch (model) {
    case 'first_click':
      return only(0);
    case 'last_click':
      return only(n - 1);
    case 'linear':
      return touchTimes.map(() => 1 / n);
    case 'u_shaped':
      if (n === 1) return [1];
      if (n === 2) return [0.5, 0.5];
      return touchTimes.map((_, i) =>
        i === 0
          ? U_SHAPED_WEIGHTS.first
          : i === n - 1
            ? U_SHAPED_WEIGHTS.last
            : U_SHAPED_WEIGHTS.middle / (n - 2),
      );
    case 'time_decay': {
      const halfLife = TIME_DECAY_HALF_LIFE_DAYS * DAY_MS;
      const raw = touchTimes.map((t) => 2 ** (-Math.max(0, conversionTs - t) / halfLife));
      const sum = raw.reduce((a, b) => a + b, 0);
      return raw.map((w) => w / sum);
    }
    case 'windowed_hybrid':
      return only(
        conversionTs - (touchTimes[0] ?? conversionTs) <= windowDays * DAY_MS ? 0 : n - 1,
      );
  }
}

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;
export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

// ------------------------------------------------------------------- windows

export interface ReportWindow {
  /** Epoch ms, inclusive. */
  from: number;
  /** Epoch ms, exclusive. */
  to: number;
  timeZone: string;
  /** Local days of the range (inclusive), for the daily spend. */
  fromDay: string;
  toDay: string;
}

/** Throws RangeError on an invalid range. */
export function reportWindow(
  q: { from: string; to: string; timezone?: string | undefined },
  siteTimeZone: string,
): ReportWindow {
  const r = resolveRange(q, siteTimeZone);
  return {
    from: r.from,
    to: r.to,
    timeZone: r.timeZone,
    fromDay: dayKey(r.from, r.timeZone),
    toDay: dayKey(r.to - 1, r.timeZone),
  };
}

const QUARTER_HOUR_MS = 900_000;

/** Local day of an instant, cached per quarter hour (every UTC offset is a multiple of 15 min). */
export function dayKeyer(timeZone: string): (ts: number) => string {
  const cache = new Map<number, string>();
  return (ts) => {
    const q = Math.floor(ts / QUARTER_HOUR_MS);
    let key = cache.get(q);
    if (key === undefined) {
      key = dayKey(q * QUARTER_HOUR_MS, timeZone);
      cache.set(q, key);
    }
    return key;
  };
}

// ------------------------------------------------------------------- persons

/** Person key: `c:<contact id>` for CRM contacts, else the origin visitor of the merge group. */
export type PersonKey = string;

export interface VisitorGroups {
  personOf(visitorId: string | null, contactId?: string | null): PersonKey | null;
  visitorsOf(person: PersonKey): string[];
}

/**
 * One person per active merge group (child visitors follow their origin) and
 * per CRM contact (every visitor linked to it, and their groups). Loaded once
 * per report: merges and contact links are small next to the click-log.
 */
export function loadVisitorGroups(db: SqlDb): VisitorGroups {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    for (let p = parent.get(root); p !== undefined && p !== root; p = parent.get(root)) root = p;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Contacts stay roots so that their key names the person.
    if (ra.startsWith('c:')) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const r of db.all<{ visitor_id: string; origin_id: string }>(
    `WITH RECURSIVE ${VISITOR_ORIGIN_CTE} SELECT visitor_id, origin_id FROM visitor_origin`,
  )) {
    union(`v:${r.visitor_id}`, `v:${r.origin_id}`);
  }
  for (const r of db.all<{ id: string; contact_id: string }>(
    `SELECT id, contact_id FROM visitors WHERE contact_id IS NOT NULL`,
  )) {
    union(`v:${r.id}`, `c:${r.contact_id}`);
  }
  const members = new Map<string, string[]>();
  for (const node of parent.keys()) {
    if (!node.startsWith('v:')) continue;
    const root = find(node);
    const list = members.get(root) ?? [];
    list.push(node.slice(2));
    members.set(root, list);
  }
  for (const list of members.values()) list.sort();
  return {
    personOf(visitorId, contactId) {
      if (visitorId !== null) return find(`v:${visitorId}`);
      if (contactId !== null && contactId !== undefined) return find(`c:${contactId}`);
      return null;
    },
    visitorsOf(person) {
      return members.get(person) ?? (person.startsWith('v:') ? [person.slice(2)] : []);
    },
  };
}

// ------------------------------------------------------- sources → ad entities

export interface SourceInfo {
  id: string;
  name: string;
  platform: AdPlatform | null;
  /** Tracking field slot (`c1`…) holding the adset / ad group id. */
  adsetSlot: string | null;
  /** Tracking field slot holding the ad / creative id. */
  adSlot: string | null;
  /** Multipliers of the source's cost / revenue modifiers (1 = none). */
  costFactor: number;
  revenueFactor: number;
}

const modifierFactor = (pct: number | null | undefined): number =>
  pct === null || pct === undefined ? 1 : Math.max(0, 1 + pct / 100);

const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ADSET_FIELD_NAMES = new Set(['adset', 'adsetid', 'adgroup', 'adgroupid']);
const AD_FIELD_NAMES = new Set(['ad', 'adid', 'creative', 'creativeid']);

/**
 * How a touch maps onto the ad hierarchy of its traffic source:
 * - campaign = the reserved `campaign` field (`touch.campaign`);
 * - adset = the first custom field whose name or URL parameter is
 *   `adset` / `adgroup` (`_id` suffixes, case and separators ignored);
 * - ad = the first custom field named `ad` / `creative` (same rules).
 * The values are the platform ids, so they join `ad_entities` and the spend.
 */
export function entitySlots(source: Pick<TrafficSource, 'fields'>): {
  adset: string | null;
  ad: string | null;
} {
  const pick = (names: Set<string>): string | null => {
    const byName = source.fields.find((f) => names.has(normalizeName(f.name)));
    if (byName !== undefined) return byName.slot;
    return source.fields.find((f) => names.has(normalizeName(f.url_param)))?.slot ?? null;
  };
  return { adset: pick(ADSET_FIELD_NAMES), ad: pick(AD_FIELD_NAMES) };
}

/** Platform of a source: its template when it is an ad platform, else its conversion platform. */
export function sourcePlatform(
  source: Pick<TrafficSource, 'template' | 'conversion'>,
): AdPlatform | null {
  if ((AD_PLATFORMS as readonly string[]).includes(source.template))
    return source.template as AdPlatform;
  return source.conversion.platform ?? null;
}

/** Every traffic source (archived included: old touches still point at them). */
export function loadSources(db: SqlDb): Map<string, SourceInfo> {
  const out = new Map<string, SourceInfo>();
  for (const s of listTrafficSources(db)) {
    const slots = entitySlots(s);
    out.set(s.id, {
      id: s.id,
      name: s.name,
      platform: sourcePlatform(s),
      adsetSlot: slots.adset,
      adSlot: slots.ad,
      costFactor: modifierFactor(s.cost_modifier_pct),
      revenueFactor: modifierFactor(s.revenue_modifier_pct),
    });
  }
  return out;
}

/** SQL value of the adset / ad slot of touches aliased `t` (per source). */
export function entitySlotSql(
  sources: ReadonlyMap<string, SourceInfo>,
  level: 'adset' | 'ad',
  params: SqlValue[],
): string {
  const cases: string[] = [];
  for (const s of sources.values()) {
    const slot = level === 'adset' ? s.adsetSlot : s.adSlot;
    if (slot === null) continue;
    cases.push(`WHEN ? THEN json_extract(t.fields, ?)`);
    params.push(s.id, `$.${slot}`);
  }
  return cases.length === 0 ? 'NULL' : `CASE t.traffic_source_id ${cases.join(' ')} ELSE NULL END`;
}

export interface EntityInfo {
  platform: AdPlatform;
  external_id: string;
  level: AdEntityLevel;
  parent: string | null;
  name: string;
}

export interface EntityIndex {
  get(platform: string, externalId: string): EntityInfo | undefined;
  /** Name by external id (any platform), for labels. */
  name(externalId: string): string | undefined;
}

export function loadEntities(db: SqlDb): EntityIndex {
  const byKey = new Map<string, EntityInfo>();
  const names = new Map<string, string>();
  for (const e of db.all<{
    platform: AdPlatform;
    external_id: string;
    level: AdEntityLevel;
    parent_external_id: string | null;
    name: string;
  }>(`SELECT platform, external_id, level, parent_external_id, name FROM ad_entities`)) {
    byKey.set(`${e.platform}\u0000${e.external_id}`, {
      platform: e.platform,
      external_id: e.external_id,
      level: e.level,
      parent: e.parent_external_id,
      name: e.name,
    });
    if (!names.has(e.external_id)) names.set(e.external_id, e.name);
  }
  return {
    get: (platform, externalId) => byKey.get(`${platform}\u0000${externalId}`),
    name: (externalId) => names.get(externalId),
  };
}

export function funnelNames(db: SqlDb): Map<string, string> {
  return new Map(
    db
      .all<{ id: string; name: string }>(`SELECT id, name FROM funnel_graphs`)
      .map((r) => [r.id, r.name] as const),
  );
}

// ------------------------------------------------------------------- touches

export interface TouchPoint {
  id: string;
  ts: number;
  visitor: string;
  kind: TouchKind;
  source: string | null;
  campaign: string | null;
  /** Read only when asked for ({@link PathOptions}); `undefined` otherwise. */
  adset?: string | null;
  ad?: string | null;
  funnel?: string;
  node?: string;
  country?: string | null;
  device?: string | null;
  clickId?: string | null;
}

export interface PathOptions {
  /** Inclusive. */
  until: number;
  /** `arrivals`: entrances only (one per tracked arrival from a source); `all`: every funnel hit. */
  kinds: 'arrivals' | 'all';
  /** Country / device of the touch's session. */
  sessions?: boolean;
  /** Funnel and node ids. */
  nodes?: boolean;
  /** External click id. */
  clickIds?: boolean;
  /** Sources whose adset / ad slots are read. */
  slots?: ReadonlyMap<string, SourceInfo>;
}

/** Touches of these visitors up to `until`, per visitor (unordered across visitors). */
export function touchesOfVisitors(
  db: SqlDb,
  visitorIds: readonly string[],
  opts: PathOptions,
): TouchPoint[] {
  if (visitorIds.length === 0) return [];
  const params: SqlValue[] = [];
  const cols = [
    't.id AS id',
    't.ts AS ts',
    't.visitor_id AS visitor',
    't.kind AS kind',
    't.traffic_source_id AS source',
    't.campaign AS campaign',
  ];
  if (opts.slots !== undefined) {
    cols.push(
      `${entitySlotSql(opts.slots, 'adset', params)} AS adset`,
      `${entitySlotSql(opts.slots, 'ad', params)} AS ad`,
    );
  }
  if (opts.nodes === true) cols.push('t.funnel_id AS funnel', 't.node_id AS node');
  if (opts.sessions === true) cols.push('s.country AS country', 's.device AS device');
  if (opts.clickIds === true) cols.push('t.external_click_id AS clickId');
  params.push(JSON.stringify(visitorIds), opts.until);
  return db.all<TouchPoint>(
    `SELECT ${cols.join(', ')}
     FROM touches t ${opts.sessions === true ? 'LEFT JOIN sessions s ON s.id = t.session_id' : ''}
     WHERE t.visitor_id IN (SELECT value FROM json_each(?)) AND t.ts <= ?
       ${opts.kinds === 'arrivals' ? `AND t.kind = 'entrance'` : ''}`,
    ...params,
  );
}

/** Touch paths per person (all visitors of the person merged, oldest first). */
export function pathsOf(
  db: SqlDb,
  groups: VisitorGroups,
  persons: Iterable<PersonKey>,
  opts: PathOptions,
): Map<PersonKey, TouchPoint[]> {
  const visitorPerson = new Map<string, PersonKey>();
  for (const p of persons) for (const v of groups.visitorsOf(p)) visitorPerson.set(v, p);
  const out = new Map<PersonKey, TouchPoint[]>();
  for (const t of touchesOfVisitors(db, [...visitorPerson.keys()], opts)) {
    const p = visitorPerson.get(t.visitor);
    if (p === undefined) continue;
    const list = out.get(p) ?? [];
    list.push(t);
    out.set(p, list);
  }
  const byTime = (a: TouchPoint, b: TouchPoint): number =>
    a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const list of out.values()) {
    if (list.some((t, i) => i > 0 && byTime(list[i - 1] as TouchPoint, t) > 0)) list.sort(byTime);
  }
  return out;
}

// ------------------------------------------------------------ revenue events

export interface RevenueEvent {
  id: string;
  kind: 'sale' | 'lead';
  ts: number;
  /** Net revenue (refunds deducted), site currency. */
  amount: number;
  /** Hard costs + COGS + taxes carried by the conversion. */
  costs: number;
  person: PersonKey | null;
  /** Identified by a CRM contact or an email/phone key at conversion time. */
  contactId: string | null;
  origin: 'conversion' | 'payment';
}

/** `data` keys of a conversion holding its costs, in minor units. */
export const CONVERSION_COST_KEYS = ['hard_cost_minor', 'cogs_minor', 'tax_minor'] as const;

function conversionCosts(data: string | null): number {
  if (data === null) return 0;
  const parsed = JSON.parse(data) as Record<string, string>;
  let total = 0;
  for (const k of CONVERSION_COST_KEYS) {
    const v = Number(parsed[k]);
    if (Number.isInteger(v) && v > 0) total += v;
  }
  return total;
}

/**
 * Revenue events of [from, to): approved `sale` / `lead` conversions of the
 * conversion log and the CRM / tracker payments (refunded and free trials
 * excluded). A payment whose transaction or order id is the tx of a logged
 * conversion is the same sale and is skipped.
 */
export function revenueEvents(
  db: SqlDb,
  groups: VisitorGroups,
  from: number,
  to: number,
  currency: string,
): RevenueEvent[] {
  const out: RevenueEvent[] = [];
  for (const c of db.all<{
    id: string;
    event: string;
    ts: number;
    revenue_minor: number;
    currency: string | null;
    visitor_id: string | null;
    data: string | null;
  }>(
    `SELECT id, event, ts, revenue_minor, currency, visitor_id, data FROM conversion_log
     WHERE status = 'approved' AND event IN ('sale', 'lead') AND ts >= ? AND ts < ? ORDER BY ts, id`,
    from,
    to,
  )) {
    const sameCurrency = c.currency === null || c.currency === currency;
    out.push({
      id: c.id,
      kind: c.event === 'lead' ? 'lead' : 'sale',
      ts: c.ts,
      amount: sameCurrency ? c.revenue_minor : 0,
      costs: sameCurrency ? conversionCosts(c.data) : 0,
      person: groups.personOf(c.visitor_id),
      contactId: null,
      origin: 'conversion',
    });
  }
  const logged = new Set(
    db
      .all<{ tx: string }>(`SELECT DISTINCT tx FROM conversion_log WHERE tx <> ''`)
      .map((r) => r.tx),
  );
  for (const p of db.all<{
    transaction_id: string;
    order_id: string | null;
    ts: number;
    amount: number;
    contact_id: string | null;
    visitor_id: string | null;
  }>(
    `SELECT t.transaction_id, t.order_id, t.ts, t.amount_minor - t.refunded_minor AS amount,
       COALESCE(v.contact_id, t.contact_id) AS contact_id, t.visitor_id
     FROM payments t LEFT JOIN visitors v ON v.id = t.visitor_id
     WHERE t.ts >= ? AND t.ts < ? AND t.refunded = 0 AND t.free_trial = 0 AND t.currency = ?
     ORDER BY t.ts, t.id`,
    from,
    to,
    currency,
  )) {
    if (logged.has(p.transaction_id) || (p.order_id !== null && logged.has(p.order_id))) continue;
    out.push({
      id: `pay:${p.transaction_id}`,
      kind: 'sale',
      ts: p.ts,
      amount: p.amount,
      costs: 0,
      person: groups.personOf(p.visitor_id, p.contact_id),
      contactId: p.contact_id,
      origin: 'payment',
    });
  }
  return out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Earliest sale and lead ever of each person (new leads, returning customers). */
export function firstConversions(
  db: SqlDb,
  groups: VisitorGroups,
): Map<PersonKey, { sale?: number; lead?: number }> {
  const out = new Map<PersonKey, { sale?: number; lead?: number }>();
  const note = (person: PersonKey | null, kind: 'sale' | 'lead', ts: number): void => {
    if (person === null) return;
    const cur = out.get(person) ?? {};
    const prev = cur[kind];
    if (prev === undefined || ts < prev) cur[kind] = ts;
    out.set(person, cur);
  };
  for (const r of db.all<{ visitor_id: string; event: string; ts: number }>(
    `SELECT visitor_id, event, MIN(ts) AS ts FROM conversion_log
     WHERE status = 'approved' AND event IN ('sale', 'lead') AND visitor_id IS NOT NULL
     GROUP BY visitor_id, event`,
  )) {
    note(groups.personOf(r.visitor_id), r.event === 'lead' ? 'lead' : 'sale', r.ts);
  }
  for (const r of db.all<{ visitor_id: string | null; contact_id: string | null; ts: number }>(
    `SELECT t.visitor_id, COALESCE(v.contact_id, t.contact_id) AS contact_id, MIN(t.ts) AS ts
     FROM payments t LEFT JOIN visitors v ON v.id = t.visitor_id
     WHERE t.refunded = 0 AND t.free_trial = 0
     GROUP BY t.visitor_id, COALESCE(v.contact_id, t.contact_id)`,
  )) {
    note(groups.personOf(r.visitor_id, r.contact_id), 'sale', r.ts);
  }
  return out;
}

export interface Customer {
  person: PersonKey;
  /** First arrival touch ever (join date). */
  join: TouchPoint;
  /** Last arrival touch before the first sale. */
  lastBeforeSale: TouchPoint;
  /** Sales at or after the join, oldest first. */
  sales: RevenueEvent[];
}

/** Persons whose first arrival touch falls in [from, to) and who bought since. */
export function customersJoinedIn(
  db: SqlDb,
  groups: VisitorGroups,
  from: number,
  to: number,
  currency: string,
): Customer[] {
  const sales = revenueEvents(db, groups, from, Number.MAX_SAFE_INTEGER, currency).filter(
    (e) => e.kind === 'sale',
  );
  const byPerson = new Map<PersonKey, RevenueEvent[]>();
  for (const s of sales) {
    if (s.person === null) continue;
    const list = byPerson.get(s.person) ?? [];
    list.push(s);
    byPerson.set(s.person, list);
  }
  const paths = pathsOf(db, groups, byPerson.keys(), {
    until: Number.MAX_SAFE_INTEGER,
    kinds: 'arrivals',
  });
  const out: Customer[] = [];
  for (const [person, list] of byPerson) {
    const path = paths.get(person);
    const join = path?.[0];
    if (path === undefined || join === undefined || join.ts < from || join.ts >= to) continue;
    const after = list.filter((s) => s.ts >= join.ts);
    const firstSale = after[0];
    if (firstSale === undefined) continue;
    let last = join;
    for (const t of path) if (t.ts <= firstSale.ts) last = t;
    out.push({ person, join, lastBeforeSale: last, sales: after });
  }
  return out.sort((a, b) => a.join.ts - b.join.ts || (a.person < b.person ? -1 : 1));
}
