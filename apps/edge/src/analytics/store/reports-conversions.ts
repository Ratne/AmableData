import type {
  AttributionModel,
  ConversionDimension,
  ConversionReport,
  conversionReportQuerySchema,
} from '@amable/api-types';
import type { z } from 'zod';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import {
  attributeConversions,
  keyTouches,
  personKey,
  touchesOf,
  type PersonKey,
  type TouchRow,
} from './attribution';
import { listRules, RULE_SOURCE, type Rule } from './conversion-rules';
import { filterSql, type ResolvedRange } from './query';

/**
 * Custom conversions of a range: totals per rule, conversions credited to the
 * values of a session dimension with the site attribution models (all
 * sessions of the person before the conversion, every visitor of a CRM
 * contact merged), and the latest conversions with their key touches. With
 * query filters only matching sessions are touches, and conversions without
 * one are left out.
 */

const RECENT = 20;

const AD_LEVELS: Partial<Record<ConversionDimension, string>> = {
  ad_campaign: 'campaign',
  ad_set: 'adset',
  ad: 'ad',
};

interface Row {
  event: string;
  ts: number;
  amount: number;
  person: PersonKey | null;
  visitor_id: string | null;
  trigger: string | null;
}

function conversionRows(
  db: SqlDb,
  r: ResolvedRange,
  events: readonly string[],
  currency: string,
): Row[] {
  return db
    .all<{
      event: string;
      ts: number;
      revenue_minor: number;
      currency: string | null;
      visitor_id: string | null;
      contact_id: string | null;
      data: string | null;
    }>(
      `SELECT c.event AS event, c.ts AS ts, c.revenue_minor AS revenue_minor, c.currency AS currency,
         c.visitor_id AS visitor_id, v.contact_id AS contact_id, c.data AS data
       FROM conversion_log c LEFT JOIN visitors v ON v.id = c.visitor_id
       WHERE c.source = ? AND c.status = 'approved' AND c.event IN (SELECT value FROM json_each(?))
         AND c.ts >= ? AND c.ts < ?
       ORDER BY c.ts, c.id`,
      RULE_SOURCE,
      JSON.stringify(events),
      r.from,
      r.to,
    )
    .map((c) => {
      let trigger: string | null = null;
      try {
        const data = c.data === null ? null : (JSON.parse(c.data) as { trigger?: unknown });
        trigger = typeof data?.trigger === 'string' ? data.trigger : null;
      } catch {
        trigger = null;
      }
      return {
        event: c.event,
        ts: c.ts,
        amount: c.currency === null || c.currency === currency ? c.revenue_minor : 0,
        person: personKey(c.contact_id, c.visitor_id),
        visitor_id: c.visitor_id,
        trigger,
      };
    });
}

function visitorsIn(db: SqlDb, r: ResolvedRange): number {
  const params: SqlValue[] = [r.from, r.to];
  const where = filterSql(r.filters, 's', params);
  return (
    first<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT s.visitor_id) AS n FROM sessions s WHERE s.started_at >= ? AND s.started_at < ? AND ${where}`,
      ...params,
    )?.n ?? 0
  );
}

function adName(db: SqlDb, dimension: ConversionDimension, value: string | null): string | null {
  const level = AD_LEVELS[dimension];
  if (level === undefined || value === null) return null;
  return (
    first<{ name: string }>(
      db,
      `SELECT name FROM ad_entities WHERE external_id = ? AND level = ? LIMIT 1`,
      value,
      level,
    )?.name ?? null
  );
}

const rate = (n: number, d: number): number =>
  d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000;

export function conversionReport(
  db: SqlDb,
  r: ResolvedRange,
  q: z.output<typeof conversionReportQuerySchema>,
  defaultModel: AttributionModel,
  currency: string,
): ConversionReport {
  const model = q.model ?? defaultModel;
  const rules = listRules(db);
  const wanted = q.rule_id === undefined ? rules : rules.filter((rule) => rule.id === q.rule_id);
  const ruleOf = new Map<string, Rule>(wanted.map((rule) => [rule.event, rule]));
  const all = conversionRows(db, r, [...ruleOf.keys()], currency);
  const persons = [...new Set(all.map((c) => c.person).filter((p): p is PersonKey => p !== null))];
  const touches = touchesOf(db, persons, {
    until: r.to,
    dimension: q.dimension,
    filters: r.filters,
  });
  const before = (c: Row): TouchRow[] =>
    (c.person === null ? [] : (touches.get(c.person) ?? [])).filter((t) => t.started_at <= c.ts);
  const filtered = r.filters.length > 0;
  const counted = filtered ? all.filter((c) => before(c).length > 0) : all;
  const visitors = visitorsIn(db, r);

  const totalsOf = (list: readonly Row[]) => {
    const people = new Set(list.map((c, i) => c.person ?? `#${i}`));
    return {
      conversions: list.length,
      persons: people.size,
      value_minor: list.reduce((a, c) => a + c.amount, 0),
      conversion_rate: rate(people.size, visitors),
    };
  };

  const pass = attributeConversions(counted, touches, [model], filtered);
  const credited = pass.byModel.get(model) ?? new Map();
  const breakdown = [...credited.entries()]
    .sort((a, b) => b[1].conversions - a[1].conversions || String(a[0]).localeCompare(String(b[0])))
    .slice(0, q.limit)
    .map(([value, v]) => ({
      value,
      label: adName(db, q.dimension, value),
      conversions: v.conversions,
      value_minor: v.revenue,
    }));

  const recent = counted
    .slice(-RECENT)
    .reverse()
    .map((c) => {
      const path = before(c);
      const key = keyTouches(path);
      const withAd = [...path].reverse().find((t) => t.ad_id !== null || t.ad_campaign_id !== null);
      const rule = ruleOf.get(c.event)!;
      return {
        ts: new Date(c.ts).toISOString(),
        rule_id: rule.id,
        rule_name: rule.name,
        visitor_id: c.visitor_id,
        trigger: c.trigger,
        entry_page: path[0]?.entry_path ?? null,
        ad_campaign: withAd?.ad_campaign_id ?? null,
        ad: withAd?.ad_id ?? null,
        first_touch: key.first,
        last_non_direct_touch: key.lastNonDirect,
      };
    });

  return {
    currency,
    model,
    dimension: q.dimension,
    visitors,
    totals: totalsOf(counted),
    rules: wanted.map((rule) => ({
      rule_id: rule.id,
      name: rule.name,
      ...totalsOf(counted.filter((c) => c.event === rule.event)),
    })),
    breakdown,
    recent,
  };
}
