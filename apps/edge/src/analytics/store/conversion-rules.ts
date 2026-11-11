import {
  CONVERSION_RULE_FIRST_EVENT,
  CONVERSION_RULE_LAST_EVENT,
  MAX_CONVERSION_RULES,
  type ConversionCount,
  type ConversionMatch,
  type ConversionRule,
  type ConversionTrigger,
  type createConversionRuleSchema,
  type updateConversionRuleSchema,
} from '@amable/api-types';
import type { z } from 'zod';
import { first, type SqlDb, type SqlValue } from '../db/sql';
import { toIso } from '../time';
import { newObjectId } from './config';

/**
 * Custom conversion rules of a site. A matching pageview or goal writes one
 * `conversion_log` row (`source = 'rule'`, `event = 'event:N'`, `hit =
 * 'r:<visitor>'`): `once` rules use an empty tx, so the (hit, event, tx) key
 * keeps the first match of each visitor; `every` rules use the pageview / goal
 * row (`pv:<id>`, `g:<id>`), so live ingest and a backfill never count the
 * same row twice. Attribution is computed at read time from the sessions.
 */

export const RULE_SOURCE = 'rule';

export interface Rule {
  id: string;
  name: string;
  key: string;
  trigger: ConversionTrigger;
  value: string;
  match: ConversionMatch;
  hostname: string | null;
  count: ConversionCount;
  valueMinor: number | null;
  enabled: boolean;
  event: string;
  createdAt: number;
  updatedAt: number;
}

interface RuleRow {
  id: string;
  name: string;
  key: string;
  trigger: string;
  value: string;
  match: string;
  hostname: string | null;
  count: string;
  value_minor: number | null;
  enabled: number;
  event_number: number;
  created_at: number;
  updated_at: number;
}

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'not_found' | 'validation_failed' | 'conflict'; message: string } };

const invalid = (message: string): Result<never> => ({
  ok: false,
  error: { code: 'validation_failed', message },
});

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  name: r.name,
  key: r.key,
  trigger: r.trigger as ConversionTrigger,
  value: r.value,
  match: r.match as ConversionMatch,
  hostname: r.hostname,
  count: r.count as ConversionCount,
  valueMinor: r.value_minor,
  enabled: r.enabled === 1,
  event: `event:${r.event_number}`,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function publicRule(r: Rule): ConversionRule {
  return {
    id: r.id,
    name: r.name,
    key: r.key,
    trigger: r.trigger,
    value: r.value,
    match: r.match,
    hostname: r.hostname,
    count: r.count,
    value_minor: r.valueMinor,
    enabled: r.enabled,
    event: r.event,
    created_at: toIso(r.createdAt),
    updated_at: toIso(r.updatedAt),
  };
}

/** Goal-name form of a label: lowercase, spaces and dashes to `_`, `[a-z0-9_]` only, max 64. */
function goalNameOf(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 64);
}

/**
 * Page path of a pageview rule as stored by the ingest (pathname, plus the
 * `#/…` route of hash-routed apps). A full URL also yields its hostname.
 */
export function normalizeRulePath(
  raw: string,
  match: ConversionMatch,
): { path: string; hostname: string | null } | null {
  let value = raw.trim();
  let hostname: string | null = null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      hostname = u.hostname.toLowerCase();
      value = `${u.pathname || '/'}${u.hash.startsWith('#/') ? (u.hash.split('?')[0] ?? '') : ''}`;
    } catch {
      return null;
    }
  } else {
    const hashRoute = value.indexOf('#/');
    const route = hashRoute >= 0 ? (value.slice(hashRoute).split('?')[0] ?? '') : '';
    value = `${value.slice(0, hashRoute >= 0 ? hashRoute : undefined).split(/[?#]/)[0] ?? ''}${route}`;
  }
  if (match !== 'contains' && !value.startsWith('/')) value = `/${value}`;
  if (match === 'exact' && value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  if (value === '' || value.length > 1024) return null;
  return { path: value, hostname };
}

const bareHost = (h: string): string => (h.startsWith('www.') ? h.slice(4) : h);

/** Whether a pageview (hostname, path) matches a pageview rule. */
export function pageMatches(
  rule: Pick<Rule, 'match' | 'value' | 'hostname'>,
  hostname: string | null,
  path: string,
): boolean {
  if (
    rule.hostname !== null &&
    bareHost((hostname ?? '').toLowerCase()) !== bareHost(rule.hostname)
  ) {
    return false;
  }
  if (rule.match === 'contains') return path.includes(rule.value);
  if (rule.match === 'starts_with') return path.startsWith(rule.value);
  return path === rule.value || (rule.value !== '/' && path === `${rule.value}/`);
}

/** SQL form of {@link pageMatches} on a `pageviews` alias. */
function pageMatchSql(rule: Rule, alias: string, params: SqlValue[]): string {
  const parts: string[] = [];
  if (rule.hostname !== null) {
    const host = bareHost(rule.hostname);
    parts.push(`(${alias}.hostname = ? OR ${alias}.hostname = ?)`);
    params.push(host, `www.${host}`);
  }
  if (rule.match === 'contains') {
    parts.push(`instr(${alias}.path, ?) > 0`);
    params.push(rule.value);
  } else if (rule.match === 'starts_with') {
    parts.push(`substr(${alias}.path, 1, ?) = ?`);
    params.push(rule.value.length, rule.value);
  } else {
    parts.push(`(${alias}.path = ? OR ${alias}.path = ?)`);
    params.push(rule.value, rule.value === '/' ? '/' : `${rule.value}/`);
  }
  return parts.join(' AND ');
}

// ----------------------------------------------------------------------- CRUD

export function listRules(db: SqlDb): Rule[] {
  return db.all<RuleRow>(`SELECT * FROM conversion_rules ORDER BY created_at, id`).map(toRule);
}

export function getRule(db: SqlDb, id: string): Rule | null {
  const row = first<RuleRow>(db, `SELECT * FROM conversion_rules WHERE id = ?`, id);
  return row === undefined ? null : toRule(row);
}

/** Enabled rules, the ones each ingest batch matches against. */
export function activeRules(db: SqlDb): Rule[] {
  return db
    .all<RuleRow>(`SELECT * FROM conversion_rules WHERE enabled = 1 ORDER BY created_at, id`)
    .map(toRule);
}

interface RuleFields {
  name: string;
  trigger: ConversionTrigger;
  value: string;
  match: ConversionMatch;
  hostname: string | null;
  count: ConversionCount;
  valueMinor: number | null;
  enabled: boolean;
}

/** Normalized trigger value and hostname of a rule, or why it is invalid. */
function normalizeFields(f: RuleFields): Result<RuleFields> {
  if (f.trigger === 'goal') {
    const goal = goalNameOf(f.value);
    if (goal === '') return invalid('value: goal names use a-z, 0-9 and _');
    return { ok: true, value: { ...f, value: goal, match: 'exact', hostname: null } };
  }
  const page = normalizeRulePath(f.value, f.match);
  if (page === null) return invalid('value: not a page path or URL');
  const hostname =
    (f.hostname === null || f.hostname === '' ? page.hostname : f.hostname)?.toLowerCase() ?? null;
  if (hostname !== null && !/^[a-z0-9.-]{1,253}$/.test(hostname))
    return invalid('hostname: invalid');
  return { ok: true, value: { ...f, value: page.path, hostname } };
}

function uniqueKey(db: SqlDb, name: string): string {
  const base = (goalNameOf(name) || 'conversion').slice(0, 58);
  for (let i = 1; ; i += 1) {
    const key = i === 1 ? base : `${base}_${i}`;
    if (first(db, `SELECT 1 AS n FROM conversion_rules WHERE key = ?`, key) === undefined)
      return key;
  }
}

function freeEventNumber(db: SqlDb): number | null {
  const used = new Set(
    db.all<{ n: number }>(`SELECT event_number AS n FROM conversion_rules`).map((r) => r.n),
  );
  for (let n = CONVERSION_RULE_FIRST_EVENT; n <= CONVERSION_RULE_LAST_EVENT; n += 1) {
    if (!used.has(n)) return n;
  }
  return null;
}

export function createRule(
  db: SqlDb,
  input: z.output<typeof createConversionRuleSchema>,
  currency: string,
  now: number,
): Result<ConversionRule> {
  const count = first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM conversion_rules`)?.n ?? 0;
  if (count >= MAX_CONVERSION_RULES) {
    return {
      ok: false,
      error: { code: 'conflict', message: `at most ${MAX_CONVERSION_RULES} conversions per site` },
    };
  }
  const fields = normalizeFields({
    name: input.name,
    trigger: input.trigger,
    value: input.value,
    match: input.match,
    hostname: input.hostname,
    count: input.count,
    valueMinor: input.value_minor,
    enabled: input.enabled,
  });
  if (!fields.ok) return fields;
  const n = freeEventNumber(db);
  if (n === null)
    return { ok: false, error: { code: 'conflict', message: 'no conversion event left' } };
  const id = newObjectId('cr');
  const f = fields.value;
  db.run(
    `INSERT INTO conversion_rules (id, name, key, trigger, value, match, hostname, count, value_minor, enabled,
       event_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    f.name,
    uniqueKey(db, f.name),
    f.trigger,
    f.value,
    f.match,
    f.hostname,
    f.count,
    f.valueMinor,
    f.enabled ? 1 : 0,
    n,
    now,
    now,
  );
  const rule = getRule(db, id)!;
  const out = publicRule(rule);
  if (input.backfill) out.backfilled = backfillRule(db, rule, currency, now);
  return { ok: true, value: out };
}

export function updateRule(
  db: SqlDb,
  id: string,
  patch: z.output<typeof updateConversionRuleSchema>,
  now: number,
): Result<ConversionRule> {
  const current = getRule(db, id);
  if (current === null)
    return { ok: false, error: { code: 'not_found', message: 'conversion not found' } };
  const trigger = patch.trigger ?? current.trigger;
  const fields = normalizeFields({
    name: patch.name ?? current.name,
    trigger,
    value: patch.value ?? current.value,
    match: patch.match ?? current.match,
    hostname:
      patch.hostname === undefined
        ? trigger === current.trigger
          ? current.hostname
          : null
        : patch.hostname,
    count: patch.count ?? current.count,
    valueMinor: patch.value_minor === undefined ? current.valueMinor : patch.value_minor,
    enabled: patch.enabled ?? current.enabled,
  });
  if (!fields.ok) return fields;
  const f = fields.value;
  db.run(
    `UPDATE conversion_rules SET name = ?, trigger = ?, value = ?, match = ?, hostname = ?, count = ?,
       value_minor = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    f.name,
    f.trigger,
    f.value,
    f.match,
    f.hostname,
    f.count,
    f.valueMinor,
    f.enabled ? 1 : 0,
    now,
    id,
  );
  return { ok: true, value: publicRule(getRule(db, id)!) };
}

/** Deletes the rule and its conversions (its event number can then be reused). */
export function deleteRule(db: SqlDb, id: string): boolean {
  const rule = getRule(db, id);
  if (rule === null) return false;
  db.run(`DELETE FROM conversion_log WHERE event = ? AND source = ?`, rule.event, RULE_SOURCE);
  db.run(`DELETE FROM conversion_rules WHERE id = ?`, id);
  return true;
}

// -------------------------------------------------------------------- writes

export interface RuleMatch {
  visitorId: string;
  sessionId: string | null;
  ts: number;
  /** Matched row: `pv:<pageview id>` or `g:<goal id>`. */
  ref: string;
  /** Page path or goal name, kept for the report. */
  trigger: string;
}

const ruleHit = (visitorId: string): string => `r:${visitorId}`;

/** Writes the conversion of a match; false when the visitor already has it (`once`) or the row was seen. */
export function recordRuleConversion(
  db: SqlDb,
  rule: Rule,
  m: RuleMatch,
  currency: string,
  now: number,
): boolean {
  const rows = db.all<{ id: string }>(
    `INSERT INTO conversion_log (id, hit, tx, event, status, revenue_minor, currency, ts, visitor_id, session_id,
       source, data, received_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (hit, event, tx) DO NOTHING RETURNING id`,
    newObjectId('cv'),
    ruleHit(m.visitorId),
    rule.count === 'once' ? '' : m.ref,
    rule.event,
    rule.valueMinor ?? 0,
    rule.valueMinor === null ? null : currency,
    m.ts,
    m.visitorId,
    m.sessionId,
    RULE_SOURCE,
    JSON.stringify({ rule: rule.id, trigger: m.trigger.slice(0, 512) }),
    now,
    now,
  );
  return rows.length > 0;
}

/**
 * Converts the pageviews / goals already stored (raw retention window) in one
 * statement; returns how many conversions it wrote. Goals recorded by a rule
 * are skipped.
 */
export function backfillRule(db: SqlDb, rule: Rule, currency: string, now: number): number {
  const once = rule.count === 'once';
  const params: SqlValue[] = [
    rule.event,
    rule.valueMinor ?? 0,
    rule.valueMinor === null ? null : currency,
    RULE_SOURCE,
    rule.id,
    now,
    now,
  ];
  let from: string;
  if (rule.trigger === 'pageview') {
    from = `FROM pageviews x WHERE ${pageMatchSql(rule, 'x', params)}`;
  } else {
    from = `FROM goals x WHERE x.name = ? AND (x.params IS NULL OR json_extract(x.params, '$.rule') IS NULL)`;
    params.push(rule.value);
  }
  const ref = rule.trigger === 'pageview' ? `'pv:' || x.id` : `'g:' || x.id`;
  const triggerCol = rule.trigger === 'pageview' ? 'x.path' : 'x.name';
  // With `once`, MIN(x.ts) makes the bare columns come from each visitor's first match.
  const rows = db.all<{ n: number }>(
    `INSERT OR IGNORE INTO conversion_log (id, hit, tx, event, status, revenue_minor, currency, ts, visitor_id,
       session_id, source, data, received_at, updated_at)
     SELECT 'cv_' || lower(hex(randomblob(10))), 'r:' || x.visitor_id, ${once ? `''` : ref}, ?, 'approved', ?, ?,
       ${once ? 'MIN(x.ts)' : 'x.ts'}, x.visitor_id, x.session_id, ?, json_object('rule', ?, 'trigger', ${triggerCol}),
       ?, ?
     ${from} ${once ? 'GROUP BY x.visitor_id' : ''}
     RETURNING 1 AS n`,
    ...params,
  );
  return rows.length;
}
