import type { AdsReport, BotsReport, SearchConsoleReport } from '@amable/api-types';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { CRAWLER_LIST_VERSION } from '../crawlers';
import { DAY_MS } from '../time';
import { attributeRevenue } from './attribution';
import type { ResolvedRange } from './query';

const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** Bot and crawler traffic (UTC days): categories, bots with IP verification, pages, daily split. */
export function botsReport(db: SqlDb, r: ResolvedRange): BotsReport {
  const from = utcDay(r.from);
  const to = utcDay(r.to - 1);
  const total =
    first<{ n: number | null }>(db, `SELECT SUM(hits) AS n FROM bot_hits WHERE day >= ? AND day <= ?`, from, to)?.n ?? 0;
  const categories = db.all<{ value: string; hits: number }>(
    `SELECT category AS value, SUM(hits) AS hits FROM bot_hits WHERE day >= ? AND day <= ?
     GROUP BY category ORDER BY hits DESC, value`,
    from,
    to,
  );
  const bots = db.all<{
    bot: string;
    provider: string;
    category: string;
    hits: number;
    verified_hits: number;
    spoofed_hits: number;
  }>(
    `SELECT bot, provider, category, SUM(hits) AS hits, SUM(verified_hits) AS verified_hits, SUM(spoofed_hits) AS spoofed_hits
     FROM bot_hits WHERE day >= ? AND day <= ? GROUP BY bot, provider, category ORDER BY hits DESC, bot LIMIT 50`,
    from,
    to,
  );
  const pages = db.all<{ path: string; hits: number }>(
    `SELECT path, SUM(hits) AS hits FROM bot_hits WHERE day >= ? AND day <= ? GROUP BY path ORDER BY hits DESC, path LIMIT 20`,
    from,
    to,
  );
  const daily = new Map<string, BotsReport['daily'][number]>();
  for (let t = Date.parse(`${from}T00:00:00Z`); utcDay(t) <= to; t += DAY_MS) {
    daily.set(utcDay(t), { label: utcDay(t), ai_answers: 0, training: 0, indexing: 0, other: 0 });
  }
  for (const row of db.all<{ day: string; category: string; hits: number }>(
    `SELECT day, category, SUM(hits) AS hits FROM bot_hits WHERE day >= ? AND day <= ? GROUP BY day, category`,
    from,
    to,
  )) {
    const d = daily.get(row.day);
    if (d === undefined) continue;
    if (row.category === 'ai_answers' || row.category === 'training' || row.category === 'indexing') d[row.category] += row.hits;
    else d.other += row.hits;
  }
  return { list_version: CRAWLER_LIST_VERSION, total_hits: total, categories, bots, pages, daily: [...daily.values()] };
}

// ------------------------------------------------------------- integrations

export type IntegrationProviderId = 'meta_ads' | 'search_console';

export interface IntegrationRow {
  provider: IntegrationProviderId;
  status: 'disconnected' | 'connected' | 'error';
  account_id: string | null;
  account_name: string | null;
  connected_at: number | null;
  last_sync_at: number | null;
  last_error: string | null;
}

export function listIntegrations(db: SqlDb): IntegrationRow[] {
  return db.all<IntegrationRow>(`SELECT * FROM integrations ORDER BY provider`);
}

export function getIntegration(db: SqlDb, provider: IntegrationProviderId): IntegrationRow | null {
  return first<IntegrationRow>(db, `SELECT * FROM integrations WHERE provider = ?`, provider) ?? null;
}

export function saveIntegration(db: SqlDb, row: IntegrationRow): void {
  db.run(
    `INSERT INTO integrations (provider, status, account_id, account_name, connected_at, last_sync_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET status = excluded.status, account_id = excluded.account_id,
       account_name = excluded.account_name, connected_at = excluded.connected_at,
       last_sync_at = excluded.last_sync_at, last_error = excluded.last_error`,
    row.provider,
    row.status,
    row.account_id,
    row.account_name,
    row.connected_at,
    row.last_sync_at,
    row.last_error,
  );
}

/** Disconnecting keeps no account reference; synced numbers stay for history. */
export function removeIntegration(db: SqlDb, provider: IntegrationProviderId): void {
  db.run(`DELETE FROM integrations WHERE provider = ?`, provider);
}

export interface AdSpendRow {
  day: string;
  campaign_id: string;
  campaign_name: string;
  spend_minor: number;
  currency: string;
  impressions: number;
  clicks: number;
}

export interface SearchStatRow {
  day: string;
  kind: 'query' | 'page';
  key: string;
  clicks: number;
  impressions: number;
  /** Average position of the day. */
  position: number;
}

/** Replaces the synced days of a provider (idempotent re-sync). */
export function storeAdSpend(db: SqlDb, provider: 'meta_ads', rows: readonly AdSpendRow[]): void {
  db.transaction(() => {
    const days = [...new Set(rows.map((r) => r.day))];
    db.run(`DELETE FROM ad_spend WHERE provider = ? AND day IN (SELECT value FROM json_each(?))`, provider, JSON.stringify(days));
    for (const r of rows) {
      db.run(
        `INSERT INTO ad_spend (day, provider, campaign_id, campaign_name, spend_minor, currency, impressions, clicks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        r.day,
        provider,
        r.campaign_id,
        r.campaign_name,
        r.spend_minor,
        r.currency,
        r.impressions,
        r.clicks,
      );
    }
  });
}

export function storeSearchStats(db: SqlDb, rows: readonly SearchStatRow[]): void {
  db.transaction(() => {
    const days = [...new Set(rows.map((r) => r.day))];
    db.run(`DELETE FROM search_stats WHERE day IN (SELECT value FROM json_each(?))`, JSON.stringify(days));
    for (const r of rows) {
      db.run(
        `INSERT INTO search_stats (day, kind, key, clicks, impressions, position_weighted) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (day, kind, key) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions,
           position_weighted = excluded.position_weighted`,
        r.day,
        r.kind,
        r.key,
        r.clicks,
        r.impressions,
        r.position * r.impressions,
      );
    }
  });
}

const norm = (s: string | null): string => (s ?? '').trim().toLowerCase();

/**
 * Ad spend per campaign joined with site traffic and revenue: a campaign
 * matches sessions whose `utm_campaign` equals its name or id (case
 * insensitive); revenue is credited to campaigns with the attribution model.
 */
export function adsReport(
  db: SqlDb,
  r: ResolvedRange,
  currency: string,
  model: Parameters<typeof attributeRevenue>[3],
): AdsReport {
  const from = utcDay(r.from);
  const to = utcDay(r.to - 1);
  const spend = db.all<{
    campaign_id: string;
    campaign_name: string;
    spend: number;
    impressions: number;
    clicks: number;
  }>(
    `SELECT campaign_id, MAX(campaign_name) AS campaign_name, SUM(spend_minor) AS spend, SUM(impressions) AS impressions,
       SUM(clicks) AS clicks FROM ad_spend WHERE provider = 'meta_ads' AND day >= ? AND day <= ? AND currency = ?
     GROUP BY campaign_id ORDER BY spend DESC, campaign_id`,
    from,
    to,
    currency,
  );
  const visitors = new Map<string, number>();
  const vp: SqlValue[] = [r.from, r.to];
  for (const row of db.all<{ campaign: string | null; n: number }>(
    `SELECT lower(trim(utm_campaign)) AS campaign, COUNT(DISTINCT visitor_id) AS n FROM sessions
     WHERE started_at >= ? AND started_at < ? AND utm_campaign IS NOT NULL GROUP BY lower(trim(utm_campaign))`,
    ...vp,
  )) {
    if (row.campaign !== null) visitors.set(row.campaign, row.n);
  }
  const attributed = new Map<string, { revenue: number; conversions: number }>();
  for (const [value, v] of attributeRevenue(db, { ...r, filters: [] }, 'campaign', model, currency)) {
    if (value === null) continue;
    const key = norm(value);
    const cur = attributed.get(key) ?? { revenue: 0, conversions: 0 };
    cur.revenue += v.revenue;
    cur.conversions += v.conversions;
    attributed.set(key, cur);
  }
  const campaigns = spend.map((c) => {
    const keys = [norm(c.campaign_name), norm(c.campaign_id)];
    const vis = Math.max(...keys.map((k) => visitors.get(k) ?? 0));
    const att = keys.map((k) => attributed.get(k)).find((a) => a !== undefined) ?? { revenue: 0, conversions: 0 };
    const customers = Math.round(att.conversions);
    return {
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      spend_minor: c.spend,
      impressions: c.impressions,
      clicks: c.clicks,
      visitors: vis,
      customers,
      revenue_minor: att.revenue,
      roas: c.spend === 0 ? null : Math.round((att.revenue / c.spend) * 100) / 100,
      cost_per_acquisition_minor: customers === 0 ? null : Math.round(c.spend / customers),
    };
  });
  const totals = campaigns.reduce(
    (a, c) => ({
      spend_minor: a.spend_minor + c.spend_minor,
      revenue_minor: a.revenue_minor + c.revenue_minor,
      clicks: a.clicks + c.clicks,
      impressions: a.impressions + c.impressions,
    }),
    { spend_minor: 0, revenue_minor: 0, clicks: 0, impressions: 0 },
  );
  const daily = db
    .all<{ day: string; spend: number }>(
      `SELECT day, SUM(spend_minor) AS spend FROM ad_spend WHERE provider = 'meta_ads' AND day >= ? AND day <= ? AND currency = ?
       GROUP BY day ORDER BY day`,
      from,
      to,
      currency,
    )
    .map((d) => {
      const start = Date.parse(`${d.day}T00:00:00Z`);
      const rev = attributeRevenue(db, { ...r, from: start, to: start + DAY_MS, filters: [] }, 'campaign', model, currency);
      let revenue = 0;
      for (const [value, v] of rev) if (value !== null) revenue += v.revenue;
      return { label: d.day, spend_minor: d.spend, revenue_minor: revenue };
    });
  return {
    currency,
    totals: { ...totals, roas: totals.spend_minor === 0 ? null : Math.round((totals.revenue_minor / totals.spend_minor) * 100) / 100 },
    campaigns,
    daily,
  };
}

export function searchConsoleReport(db: SqlDb, r: ResolvedRange, limit = 50): SearchConsoleReport {
  const from = utcDay(r.from);
  const to = utcDay(r.to - 1);
  const rows = (kind: 'query' | 'page'): SearchConsoleReport['queries'] =>
    db
      .all<{ key: string; clicks: number; impressions: number; pw: number }>(
        `SELECT key, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position_weighted) AS pw FROM search_stats
         WHERE kind = ? AND day >= ? AND day <= ? GROUP BY key ORDER BY clicks DESC, impressions DESC, key LIMIT ?`,
        kind,
        from,
        to,
        limit,
      )
      .map((x) => ({
        key: x.key,
        clicks: x.clicks,
        impressions: x.impressions,
        ctr: x.impressions === 0 ? 0 : Math.round((x.clicks / x.impressions) * 10_000) / 10_000,
        position: x.impressions === 0 ? 0 : Math.round((x.pw / x.impressions) * 10) / 10,
      }));
  const t = first<{ clicks: number | null; impressions: number | null; pw: number | null }>(
    db,
    `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position_weighted) AS pw FROM search_stats
     WHERE kind = 'query' AND day >= ? AND day <= ?`,
    from,
    to,
  );
  const clicks = t?.clicks ?? 0;
  const impressions = t?.impressions ?? 0;
  return {
    totals: {
      clicks,
      impressions,
      ctr: impressions === 0 ? 0 : Math.round((clicks / impressions) * 10_000) / 10_000,
      position: impressions === 0 ? 0 : Math.round(((t?.pw ?? 0) / impressions) * 10) / 10,
    },
    queries: rows('query'),
    pages: rows('page'),
  };
}
