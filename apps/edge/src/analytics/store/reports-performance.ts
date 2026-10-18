import type {
  AdEntityLevel,
  AdPlatform,
  AdSpendDay,
  PerformanceFilter,
  PerformanceGroupBy,
  PerformanceQueryParsed,
  PerformanceReport,
  PerformanceRow,
} from '@amable/api-types';
import type { SqlDb, SqlValue } from '../db/sql';
import { listAdSpend } from './ad-entities';
import { splitMinor } from './attribution';
import { touchDayRollups } from './rollups';
import {
  dayKeyer,
  entitySlotSql,
  firstConversions,
  funnelNames,
  loadEntities,
  loadSources,
  loadVisitorGroups,
  modelWeights,
  pathsOf,
  revenueEvents,
  round3,
  round4,
  type EntityIndex,
  type PersonKey,
  type ReportWindow,
  type SourceInfo,
  type TouchPoint,
  type VisitorGroups,
} from './reports-shared';

/**
 * Ads performance report: arrivals, cost and attributed revenue per platform,
 * traffic source, campaign, adset, ad, day, funnel, node, country or device.
 *
 * - Visits are the entrance touches of the range (entrances + page views when
 *   grouping by node), clicks the click / action touches.
 * - Cost is the synced ad spend (`ad_spend_daily`) of the platforms that have
 *   some in the range, else the per-click cost carried by the touches. Spend
 *   joins the rows through the entity hierarchy (platform, day, campaign →
 *   adset → ad); for the other groupings, and below the synced level, it is
 *   split by the entrances of the entity in the range.
 * - Revenue comes from the conversion log and the payments of the person (all
 *   merged visitors and the CRM contact), credited to the arrival touches of
 *   the path with the model — to every funnel touch when grouping by node.
 *   Paths are always complete: filters only select which credited touches
 *   count, so drill-down rows add up to their parent.
 * - `click_date` credits a conversion to the range of the credited touch (later
 *   sales included); `sale_date` reports conversions of the range.
 * - The cost / revenue modifiers of a traffic source scale the cost of its
 *   touches and the revenue credited to them; spend not split through touches
 *   takes the modifier of the platform's first source (by id).
 * - Hard costs (hard cost, COGS, taxes) only exist on postback conversions;
 *   payments carry none.
 */

const ENTITY_LEVELS: readonly AdEntityLevel[] = ['campaign', 'adset', 'ad'];
const levelIndex = (l: AdEntityLevel): number => ENTITY_LEVELS.indexOf(l);

/** Dimension values of a touch or a click-log aggregate. */
type Dims = Partial<Record<PerformanceGroupBy, string | null>>;

export interface PerformanceContext {
  db: SqlDb;
  window: ReportWindow;
  currency: string;
  sources: Map<string, SourceInfo>;
  entities: EntityIndex;
  groups: VisitorGroups;
}

export function performanceContext(
  db: SqlDb,
  window: ReportWindow,
  currency: string,
): PerformanceContext {
  return {
    db,
    window,
    currency,
    sources: loadSources(db),
    entities: loadEntities(db),
    groups: loadVisitorGroups(db),
  };
}

interface Acc {
  key: string | null;
  parent: string | null;
  visits: number;
  clicks: number;
  cost: number;
  revenue: number;
  totalRevenue: number;
  costs: number;
  sales: number;
  leads: number;
  newLeads: number;
  returning: Set<PersonKey>;
  events: Set<string>;
  reportedConversions: number | null;
  reportedRevenue: number | null;
}

const newAcc = (key: string | null, parent: string | null): Acc => ({
  key,
  parent,
  visits: 0,
  clicks: 0,
  cost: 0,
  revenue: 0,
  totalRevenue: 0,
  costs: 0,
  sales: 0,
  leads: 0,
  newLeads: 0,
  returning: new Set(),
  events: new Set(),
  reportedConversions: null,
  reportedRevenue: null,
});

class Rows {
  readonly byKey = new Map<string | null, Acc>();
  readonly total = newAcc(null, null);
  row(key: string | null, parent: string | null): Acc {
    let acc = this.byKey.get(key);
    if (acc === undefined) {
      acc = newAcc(key, parent);
      this.byKey.set(key, acc);
    } else if (acc.parent === null && parent !== null) acc.parent = parent;
    return acc;
  }
  /** Applies `fn` to the row and the totals. */
  add(key: string | null, parent: string | null, fn: (a: Acc) => void): void {
    fn(this.row(key, parent));
    fn(this.total);
  }
}

const costFactorOf = (ctx: PerformanceContext, source: string | null | undefined): number =>
  source === null || source === undefined ? 1 : (ctx.sources.get(source)?.costFactor ?? 1);

function parentDim(groupBy: PerformanceGroupBy): PerformanceGroupBy | null {
  if (groupBy === 'ad') return 'adset';
  if (groupBy === 'adset') return 'campaign';
  if (groupBy === 'campaign' || groupBy === 'source') return 'platform';
  return null;
}

function passes(dims: Dims, filters: readonly PerformanceFilter[]): boolean {
  for (const f of filters) {
    const v = dims[f.dimension];
    if (v === undefined) continue;
    if (f.value === '' ? v !== null : v !== f.value) return false;
  }
  return true;
}

function touchDims(ctx: PerformanceContext, t: TouchPoint, day: (ts: number) => string): Dims {
  return {
    platform: (t.source === null ? undefined : ctx.sources.get(t.source))?.platform ?? null,
    source: t.source,
    campaign: t.campaign,
    adset: t.adset,
    ad: t.ad,
    day: day(t.ts),
    funnel: t.funnel,
    node: t.node,
    country: t.country,
    device: t.device,
  };
}

/** Query filters, the shorthand options included. */
export function queryFilters(
  q: Pick<PerformanceQueryParsed, 'filters' | 'platform' | 'traffic_source_id' | 'funnel_id'>,
): PerformanceFilter[] {
  const out = [...q.filters];
  if (q.platform !== undefined) out.push({ dimension: 'platform', value: q.platform });
  if (q.traffic_source_id !== undefined)
    out.push({ dimension: 'source', value: q.traffic_source_id });
  if (q.funnel_id !== undefined) out.push({ dimension: 'funnel', value: q.funnel_id });
  return out;
}

interface ClickGroup {
  dims: Dims;
  entrances: number;
}

interface CostOptions {
  groupBy: PerformanceGroupBy;
  filters: readonly PerformanceFilter[];
}

/** Click-log aggregates of the range: visits, clicks and touch cost into `rows`; returns the groups for spend splits. */
function clickLog(
  ctx: PerformanceContext,
  rows: Rows,
  opts: CostOptions,
  spendPlatforms: ReadonlySet<string>,
): ClickGroup[] {
  const { groupBy, filters } = opts;
  const needed = new Set<PerformanceGroupBy>([groupBy, ...filters.map((f) => f.dimension)]);
  const parent = parentDim(groupBy);
  if (parent !== null) needed.add(parent);
  if (spendPlatforms.size > 0 && [...needed].some((d) => d !== 'platform' && d !== 'day')) {
    for (const d of ['campaign', 'adset', 'ad'] as const) needed.add(d);
  }
  const viewsAreVisits = groupBy === 'node';
  const out: ClickGroup[] = [];
  const addGroup = (
    dims: Dims,
    g: { entrances: number; views: number; clicks: number; cost: number },
  ): void => {
    out.push({ dims, entrances: g.entrances });
    if (!passes(dims, filters)) return;
    // Touch costs are stored with the source's cost modifier already applied.
    const touchCost =
      dims.platform !== null && dims.platform !== undefined && spendPlatforms.has(dims.platform)
        ? 0
        : g.cost;
    rows.add(dims[groupBy] ?? null, parent === null ? null : (dims[parent] ?? null), (a) => {
      a.visits += g.entrances + (viewsAreVisits ? g.views : 0);
      a.clicks += g.clicks;
      a.cost += touchCost;
    });
  };
  if (!needed.has('country') && !needed.has('device')) {
    const signature = JSON.stringify(
      [...ctx.sources.values()].map((s) => [s.id, s.adsetSlot, s.adSlot]),
    );
    const rollups = touchDayRollups(ctx.db, ctx.window.timeZone, {
      signature,
      sql: (level, params) => entitySlotSql(ctx.sources, level, params),
    });
    for (const r of rollups) {
      if (r.day < ctx.window.fromDay || r.day > ctx.window.toDay) continue;
      const platform = r.source === null ? null : (ctx.sources.get(r.source)?.platform ?? null);
      addGroup(
        {
          platform,
          source: r.source,
          campaign: r.campaign,
          adset: r.adset,
          ad: r.ad,
          funnel: r.funnel,
          node: r.node,
          day: r.day,
        },
        r,
      );
    }
    return out;
  }
  const params: SqlValue[] = [];
  const cols: Array<[string, string]> = [['source', 't.traffic_source_id']];
  if (needed.has('campaign')) cols.push(['campaign', 't.campaign']);
  if (needed.has('adset')) cols.push(['adset', entitySlotSql(ctx.sources, 'adset', params)]);
  if (needed.has('ad')) cols.push(['ad', entitySlotSql(ctx.sources, 'ad', params)]);
  if (needed.has('funnel')) cols.push(['funnel', 't.funnel_id']);
  if (needed.has('node')) cols.push(['node', 't.node_id']);
  if (needed.has('country')) cols.push(['country', 's.country']);
  if (needed.has('device')) cols.push(['device', 's.device']);
  if (needed.has('day')) cols.push(['qh', 't.ts / 900000']);
  const join =
    needed.has('country') || needed.has('device')
      ? 'LEFT JOIN sessions s ON s.id = t.session_id'
      : '';
  const where = ['t.ts >= ?', 't.ts < ?'];
  params.push(ctx.window.from, ctx.window.to);
  for (const f of filters) {
    if (f.dimension === 'source' || f.dimension === 'funnel') {
      where.push(
        f.value === ''
          ? `t.${f.dimension === 'source' ? 'traffic_source_id' : 'funnel_id'} IS NULL`
          : `t.${f.dimension === 'source' ? 'traffic_source_id' : 'funnel_id'} = ?`,
      );
      if (f.value !== '') params.push(f.value);
    }
  }
  const sql = `SELECT ${cols.map(([alias, expr]) => `${expr} AS ${alias}`).join(', ')},
      SUM(t.kind = 'entrance') AS entrances, SUM(t.kind = 'view') AS views,
      SUM(t.kind IN ('click', 'action')) AS clicks,
      SUM(CASE WHEN t.kind = 'entrance' THEN COALESCE(t.cost_minor, 0) ELSE 0 END) AS cost
    FROM touches t ${join}
    WHERE ${where.join(' AND ')}
    GROUP BY ${cols.map((_, i) => i + 1).join(', ')}`;
  const day = dayKeyer(ctx.window.timeZone);
  for (const r of ctx.db.all<Record<string, string | number | null>>(sql, ...params)) {
    const source = r['source'] as string | null;
    const dims: Dims = {
      platform: (source === null ? undefined : ctx.sources.get(source))?.platform ?? null,
      source,
    };
    for (const d of ['campaign', 'adset', 'ad', 'funnel', 'node', 'country', 'device'] as const) {
      if (d in r) dims[d] = (r[d] as string | null) ?? null;
    }
    if ('qh' in r) dims.day = day(Number(r['qh']) * 900_000);
    addGroup(dims, {
      entrances: Number(r['entrances'] ?? 0),
      views: Number(r['views'] ?? 0),
      clicks: Number(r['clicks'] ?? 0),
      cost: Number(r['cost'] ?? 0),
    });
  }
  return out;
}

interface SpendUnit extends AdSpendDay {
  level: AdEntityLevel;
  /** Entity ids of the unit and its ancestors, by level. */
  path: Partial<Record<AdEntityLevel, string>>;
}

/**
 * Spend rows used for the grouping, one level per platform so nothing counts
 * twice: for campaign / adset / ad groupings the coarsest synced level at or
 * below the grouping level (else the finest one, split by entrances), for the
 * others the coarsest synced level.
 */
function spendUnits(
  ctx: PerformanceContext,
  spend: readonly AdSpendDay[],
  groupBy: PerformanceGroupBy,
): SpendUnit[] {
  const units: SpendUnit[] = spend.map((s) => {
    const entity = ctx.entities.get(s.platform, s.entity_external_id);
    const level = entity?.level ?? 'campaign';
    const path: Partial<Record<AdEntityLevel, string>> = { [level]: s.entity_external_id };
    let parent = entity?.parent ?? null;
    for (let i = 0; i < 3 && parent !== null; i += 1) {
      const p = ctx.entities.get(s.platform, parent);
      if (p === undefined) {
        // Unknown parent: one level up from the child.
        const up = ENTITY_LEVELS[levelIndex(level) - 1 - i];
        if (up !== undefined) path[up] = parent;
        break;
      }
      path[p.level] = p.external_id;
      parent = p.parent;
    }
    return { ...s, level, path };
  });
  const target =
    groupBy === 'campaign' || groupBy === 'adset' || groupBy === 'ad' ? levelIndex(groupBy) : null;
  const chosen = new Map<AdPlatform, AdEntityLevel>();
  for (const platform of new Set(units.map((u) => u.platform))) {
    const levels = [
      ...new Set(units.filter((u) => u.platform === platform).map((u) => levelIndex(u.level))),
    ].sort();
    const atOrBelow = target === null ? levels : levels.filter((l) => l >= target);
    const pick = atOrBelow[0] ?? levels[levels.length - 1] ?? 0;
    chosen.set(platform, ENTITY_LEVELS[pick] ?? 'campaign');
  }
  return units.filter((u) => chosen.get(u.platform) === u.level);
}

/** Adds the ad spend (and what the platforms report) to the rows. */
function spendInto(
  ctx: PerformanceContext,
  rows: Rows,
  opts: CostOptions,
  spend: readonly AdSpendDay[],
  groups: readonly ClickGroup[],
): void {
  const { groupBy, filters } = opts;
  const parent = parentDim(groupBy);
  const needed = [...new Set<PerformanceGroupBy>([groupBy, ...filters.map((f) => f.dimension)])];
  const fallbackSource = new Map<AdPlatform, string>();
  for (const s of [...ctx.sources.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (s.platform !== null && !fallbackSource.has(s.platform))
      fallbackSource.set(s.platform, s.id);
  }
  // Spend not split through touches takes the modifier of the platform's first source.
  const platformFactor = (platform: AdPlatform): number => costFactorOf(ctx, fallbackSource.get(platform));
  const credit = (
    key: string | null,
    parentKey: string | null,
    u: SpendUnit,
    share: number,
    amount: number,
    reportedRevenue: number | null,
  ): void => {
    rows.add(key, parentKey, (a) => {
      a.cost += amount;
      if (u.reported_conversions !== null && u.reported_conversions !== undefined) {
        a.reportedConversions = (a.reportedConversions ?? 0) + u.reported_conversions * share;
      }
      if (reportedRevenue !== null) a.reportedRevenue = (a.reportedRevenue ?? 0) + reportedRevenue;
    });
  };
  const entityKey = (platform: string, level: AdEntityLevel, id: string): string =>
    `${platform}\u0000${level}\u0000${id}`;
  const byEntity = new Map<string, ClickGroup[]>();
  for (const g of groups) {
    if (g.entrances === 0 || g.dims.platform === null || g.dims.platform === undefined) continue;
    for (const level of ENTITY_LEVELS) {
      const id = g.dims[level];
      if (id === null || id === undefined) continue;
      const key = entityKey(g.dims.platform, level, id);
      const list = byEntity.get(key) ?? [];
      list.push(g);
      byEntity.set(key, list);
    }
  }
  for (const u of spendUnits(ctx, spend, groupBy)) {
    const direct: Dims = { platform: u.platform, day: u.day };
    for (const l of ENTITY_LEVELS) if (u.path[l] !== undefined) direct[l] = u.path[l] ?? null;
    if (!passes(direct, filters)) continue;
    const reported = u.reported_revenue_minor ?? null;
    if (needed.every((d) => direct[d] !== undefined)) {
      credit(
        direct[groupBy] ?? null,
        parent === null ? null : (direct[parent] ?? null),
        u,
        1,
        Math.round(u.spend_minor * platformFactor(u.platform)),
        reported,
      );
      continue;
    }
    const matching = byEntity.get(entityKey(u.platform, u.level, u.entity_external_id)) ?? [];
    const total = matching.reduce((a, g) => a + g.entrances, 0);
    if (total === 0) {
      // No entrance to split by: the spend stays on what the unit itself says.
      if (filters.some((f) => direct[f.dimension] === undefined)) continue;
      const key =
        direct[groupBy] !== undefined
          ? (direct[groupBy] ?? null)
          : groupBy === 'source'
            ? (fallbackSource.get(u.platform) ?? null)
            : null;
      const parentKey =
        parent === null ? null : (direct[parent] ?? (groupBy === 'source' ? u.platform : null));
      credit(key, parentKey, u, 1, Math.round(u.spend_minor * platformFactor(u.platform)), reported);
      continue;
    }
    const shares = new Map<
      string,
      { key: string | null; parent: string | null; n: number; factored: number }
    >();
    for (const g of matching) {
      const dims = { ...g.dims, ...direct };
      if (!passes(dims, filters)) continue;
      const key = dims[groupBy] ?? null;
      const id = key ?? '\u0000';
      const cur = shares.get(id) ?? {
        key,
        parent: parent === null ? null : (dims[parent] ?? null),
        n: 0,
        factored: 0,
      };
      cur.n += g.entrances;
      cur.factored += g.entrances * costFactorOf(ctx, g.dims.source);
      shares.set(id, cur);
    }
    const list = [...shares.values()];
    const kept = list.reduce((a, s) => a + s.n, 0);
    const weights = [...list.map((s) => s.n / total), (total - kept) / total];
    const amounts = splitMinor(u.spend_minor, weights);
    const revenues = reported === null ? null : splitMinor(reported, weights);
    list.forEach((s, i) =>
      credit(
        s.key,
        s.parent,
        u,
        s.n / total,
        Math.round(((amounts[i] ?? 0) * s.factored) / s.n),
        revenues === null ? null : (revenues[i] ?? 0),
      ),
    );
  }
}

/** Visits, clicks and cost (spend + touch cost) per row, without attribution. */
export function costRows(ctx: PerformanceContext, opts: CostOptions): Rows {
  const rows = new Rows();
  const platformFilter = opts.filters.find((f) => f.dimension === 'platform')?.value;
  const spend = listAdSpend(ctx.db, {
    from: ctx.window.fromDay,
    to: ctx.window.toDay,
    platform:
      platformFilter === undefined || platformFilter === ''
        ? undefined
        : (platformFilter as AdPlatform),
  });
  const spendPlatforms = new Set<string>(spend.map((s) => s.platform));
  const groups = clickLog(ctx, rows, opts, spendPlatforms);
  if (spend.length > 0) spendInto(ctx, rows, opts, spend, groups);
  return rows;
}

/** Credits the revenue events to the rows with the model. */
function attributeInto(
  ctx: PerformanceContext,
  rows: Rows,
  q: Pick<PerformanceQueryParsed, 'model' | 'window_days' | 'group_by' | 'basis'>,
  filters: readonly PerformanceFilter[],
): void {
  const { window: w } = ctx;
  const groupBy = q.group_by;
  const parent = parentDim(groupBy);
  const day = dayKeyer(w.timeZone);
  const events = revenueEvents(
    ctx.db,
    ctx.groups,
    w.from,
    q.basis === 'sale_date' ? w.to : Number.MAX_SAFE_INTEGER,
    ctx.currency,
  );
  if (events.length === 0) return;
  const persons = new Set(events.map((e) => e.person).filter((p): p is PersonKey => p !== null));
  const until = events.reduce((m, e) => Math.max(m, e.ts), 0);
  const used = new Set<PerformanceGroupBy>([groupBy, ...filters.map((f) => f.dimension)]);
  if (parent !== null) used.add(parent);
  const paths = pathsOf(ctx.db, ctx.groups, persons, {
    until,
    kinds: groupBy === 'node' ? 'all' : 'arrivals',
    sessions: used.has('country') || used.has('device'),
    nodes: used.has('funnel') || used.has('node'),
    ...(used.has('adset') || used.has('ad') ? { slots: ctx.sources } : {}),
  });
  const firsts = firstConversions(ctx.db, ctx.groups);
  const inRange = (ts: number): boolean => ts >= w.from && ts < w.to;
  for (const e of events) {
    const isSale = e.kind === 'sale';
    const firstOf = e.person === null ? undefined : firsts.get(e.person);
    const newLead = e.kind === 'lead' && (firstOf?.lead === undefined || firstOf.lead >= e.ts);
    const returning =
      isSale && e.person !== null && firstOf?.sale !== undefined && firstOf.sale < e.ts;
    const credit = (
      key: string | null,
      parentKey: string | null,
      weight: number,
      amount: number,
      costs: number,
    ): void => {
      rows.add(key, parentKey, (a) => {
        a.revenue += amount;
        a.costs += costs;
        if (isSale) a.sales += weight;
        else a.leads += weight;
        if (newLead) a.newLeads += weight;
        if (returning && e.person !== null) a.returning.add(e.person);
        if (!a.events.has(e.id)) {
          a.events.add(e.id);
          a.totalRevenue += e.amount;
        }
      });
    };
    const path =
      (e.person === null ? undefined : paths.get(e.person))?.filter((t) => t.ts <= e.ts) ?? [];
    if (path.length === 0) {
      if (filters.length > 0 || (q.basis === 'click_date' && !inRange(e.ts))) continue;
      credit(groupBy === 'day' ? day(e.ts) : null, null, 1, e.amount, e.costs);
      continue;
    }
    const weights = modelWeights(
      path.map((t) => t.ts),
      e.ts,
      q.model,
      q.window_days,
    );
    const amounts = splitMinor(e.amount, weights);
    const costs = splitMinor(e.costs, weights);
    path.forEach((t, i) => {
      const weight = weights[i] ?? 0;
      if (weight === 0) return;
      if (q.basis === 'click_date' && !inRange(t.ts)) return;
      const dims = touchDims(ctx, t, day);
      if (!passes(dims, filters)) return;
      const key =
        groupBy === 'day' && q.basis === 'sale_date' ? day(e.ts) : (dims[groupBy] ?? null);
      credit(
        key,
        parent === null ? null : (dims[parent] ?? null),
        weight,
        amounts[i] ?? 0,
        costs[i] ?? 0,
      );
    });
  }
}

export function labelOf(
  ctx: PerformanceContext,
  groupBy: PerformanceGroupBy,
  key: string | null,
  funnels: Map<string, string>,
): string | null {
  if (key === null) return null;
  if (groupBy === 'source') return ctx.sources.get(key)?.name ?? key;
  if (groupBy === 'campaign' || groupBy === 'adset' || groupBy === 'ad')
    return ctx.entities.name(key) ?? key;
  if (groupBy === 'funnel') return funnels.get(key) ?? key;
  return key;
}

function toRow(a: Acc, label: string | null): PerformanceRow {
  const profit = a.revenue - a.cost;
  const sales = round3(a.sales);
  return {
    key: a.key,
    label,
    parent_key: a.parent,
    visits: a.visits,
    clicks: a.clicks,
    cost_minor: a.cost,
    revenue_minor: a.revenue,
    total_revenue_minor: a.totalRevenue,
    profit_minor: profit,
    hard_costs_minor: a.costs,
    net_profit_minor: profit - a.costs,
    roas: a.cost === 0 ? null : round4(a.revenue / a.cost),
    roi: a.cost === 0 ? null : round4(profit / a.cost),
    sales,
    leads: round3(a.leads),
    new_leads: round3(a.newLeads),
    returning_customers: a.returning.size,
    aov_minor: a.sales === 0 ? null : Math.round(a.revenue / a.sales),
    cpa_minor: a.sales === 0 ? null : Math.round(a.cost / a.sales),
    cvr: a.visits === 0 ? null : round4(a.sales / a.visits),
    reported_conversions: a.reportedConversions === null ? null : round3(a.reportedConversions),
    reported_revenue_minor: a.reportedRevenue,
    reported_vs_revenue_minor: a.reportedRevenue === null ? null : a.revenue - a.reportedRevenue,
  };
}

export function performanceReport(
  ctx: PerformanceContext,
  q: PerformanceQueryParsed,
): PerformanceReport {
  const filters = queryFilters(q);
  const rows = costRows(ctx, { groupBy: q.group_by, filters });
  attributeInto(ctx, rows, q, filters);
  const funnels = q.group_by === 'funnel' ? funnelNames(ctx.db) : new Map<string, string>();
  const sorted = [...rows.byKey.values()].sort(
    (a, b) =>
      (q.group_by === 'day'
        ? 0
        : b.revenue - a.revenue || b.cost - a.cost || b.visits - a.visits) ||
      (a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return {
    model: q.model,
    window_days: q.window_days,
    group_by: q.group_by,
    basis: q.basis,
    currency: ctx.currency,
    totals: toRow(rows.total, null),
    rows: sorted.slice(0, q.limit).map((a) => toRow(a, labelOf(ctx, q.group_by, a.key, funnels))),
  };
}
