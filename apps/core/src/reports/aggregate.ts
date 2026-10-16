import type { SqlDb, SqlValue } from '../crm/db/sql';

/**
 * DO-side aggregation kit shared by the per-module report queries (CRM,
 * e-commerce, email, automation). Every aggregate runs inside the Durable
 * Object that owns the data, over indexed date anchors; the worker only
 * receives grouped rows.
 *
 * Numbers computed by the engine (range bounds, bucket bounds, limits) are
 * inlined as integer literals after a safe-integer check, so statements stay
 * far below the 100 bound-parameter limit of DO SQLite; user strings
 * (currency, ids, filter values) are always bound.
 */

/** Wire input of every `reports.*` aggregate op. */
export interface AggregateInput {
  source: string;
  /** Base measures (derived ratios are computed by the engine). */
  measures: string[];
  dimension: string | null;
  /** Half-open epoch-ms interval. */
  range: { from: number; to: number };
  /** Bucket boundaries (n + 1 values for n buckets), required for the `date` dimension. */
  buckets: number[] | null;
  /** Query-builder filter on contacts/companies, already validated by the schema. */
  filter?: unknown;
  currency?: string;
  limit: number;
  offset: number;
  params?: Record<string, string>;
  now: number;
}

export interface AggregateRow {
  /** Category value, or the bucket index for the `date` dimension. */
  key: string;
  label: string | null;
  values: Record<string, number>;
}

export interface AggregateOutput {
  rows: AggregateRow[];
  totals: Record<string, number>;
  /** Currency the money measures are expressed in (null: no money measure). */
  currency: string | null;
  /** Currencies with data in the range. */
  currencies: string[];
  truncated: boolean;
  options?: Record<string, Array<{ value: string; label: string }>>;
  emptyReason?: 'source_unavailable' | 'param_required';
  notes?: string[];
}

export class ReportQueryError extends Error {}

/** Integer literal for SQL text (only numbers computed by the server). */
export function lit(n: number): string {
  if (!Number.isSafeInteger(n)) throw new ReportQueryError(`not a safe integer: ${String(n)}`);
  return String(n);
}

/** `WITH b(k, s, e) AS (VALUES …)` over the bucket boundaries. */
export function bucketCte(bounds: readonly number[]): string {
  if (bounds.length < 2) throw new ReportQueryError('at least one bucket is required');
  const rows: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    rows.push(`(${lit(i)}, ${lit(bounds[i] ?? 0)}, ${lit(bounds[i + 1] ?? 0)})`);
  }
  return `b(k, s, e) AS (VALUES ${rows.join(', ')})`;
}

export function tableExists(db: SqlDb, table: string): boolean {
  return db.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length > 0;
}

const ensured = new WeakMap<SqlDb, Set<string>>();

/**
 * Creates report indexes idempotently, once per database handle (DO instance).
 * Additive only (`IF NOT EXISTS`), never a migration: statements on tables
 * that do not exist yet are skipped and retried on the next wake.
 */
export function ensureIndexes(
  db: SqlDb,
  group: string,
  statements: ReadonlyArray<[string, string]>,
): void {
  let done = ensured.get(db);
  if (done === undefined) {
    done = new Set();
    ensured.set(db, done);
  }
  if (done.has(group)) return;
  let complete = true;
  for (const [table, statement] of statements) {
    if (!tableExists(db, table)) {
      complete = false;
      continue;
    }
    db.run(statement);
  }
  if (complete) done.add(group);
}

/** A SQL fragment with its positional parameters. */
export interface Fragment {
  sql: string;
  params: SqlValue[];
}

export interface MeasureSql {
  /** Aggregate expression (e.g. `COUNT(*)`, `SUM(o.total_minor)`). */
  expr: string;
  /** Date column the range applies to; null = snapshot (no date condition). */
  anchor: string | null;
}

export interface DimensionSql {
  key: string;
  label?: string;
  /** Natural order (ascending) instead of the first measure (e.g. stage position). */
  sort?: string;
}

export interface GenericSpec {
  from: string;
  /** Parameters of placeholders inside `from` (derived tables). */
  fromParams?: SqlValue[];
  /** Static conditions (no parameters). */
  where: string[];
  measures: Readonly<Record<string, MeasureSql>>;
  dimensions: Readonly<Record<string, DimensionSql>>;
  /** Column holding the currency of money measures. */
  currencyColumn: string | null;
  moneyMeasures?: readonly string[];
  /** Columns the contact/company filter applies to. */
  contactColumn?: string;
  companyColumn?: string;
  /** Category dimensions with a bounded number of values (merged in memory). */
  bounded?: readonly string[];
}

export interface GenericContext {
  db: SqlDb;
  /** `col IN (subquery)` for the filter, or null. */
  filter: Fragment | null;
  /** Currency for money measures (null = no currency condition). */
  currency: string | null;
}

function groupByAnchor(spec: GenericSpec, measures: string[]): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const name of measures) {
    const m = spec.measures[name];
    if (m === undefined) throw new ReportQueryError(`unknown measure ${name}`);
    const list = groups.get(m.anchor) ?? [];
    list.push(name);
    groups.set(m.anchor, list);
  }
  return groups;
}

function conditions(
  spec: GenericSpec,
  ctx: GenericContext,
  anchor: string | null,
  range: { from: number; to: number },
  measures: string[],
): Fragment {
  const parts = [...spec.where];
  const params: SqlValue[] = [];
  if (anchor !== null)
    parts.push(`${anchor} >= ${lit(range.from)} AND ${anchor} < ${lit(range.to)}`);
  if (ctx.filter !== null) {
    parts.push(ctx.filter.sql);
    params.push(...ctx.filter.params);
  }
  const money = measures.some((m) => spec.moneyMeasures?.includes(m) === true);
  if (money && ctx.currency !== null && spec.currencyColumn !== null) {
    parts.push(`${spec.currencyColumn} = ?`);
    params.push(ctx.currency);
  }
  return { sql: parts.length === 0 ? '1 = 1' : parts.join(' AND '), params };
}

function readValues(row: Record<string, SqlValue>, measures: string[]): Record<string, number> {
  const values: Record<string, number> = {};
  measures.forEach((name, i) => {
    const raw = row[`m${String(i)}`];
    values[name] =
      typeof raw === 'number' ? raw : raw === null || raw === undefined ? 0 : Number(raw);
  });
  return values;
}

/**
 * Groups `measures` by `dimension` (or by bucket for `date`). Measures with
 * different date anchors run as separate statements and are merged by key.
 */
export function runGeneric(
  spec: GenericSpec,
  ctx: GenericContext,
  input: AggregateInput,
): AggregateOutput {
  const groups = groupByAnchor(spec, input.measures);
  const totals: Record<string, number> = {};
  for (const [anchor, names] of groups) {
    const where = conditions(spec, ctx, anchor, input.range, names);
    const select = names
      .map((n, i) => `${spec.measures[n]?.expr ?? '0'} AS m${String(i)}`)
      .join(', ');
    const row = ctx.db.all<Record<string, SqlValue>>(
      `SELECT ${select} FROM ${spec.from} WHERE ${where.sql}`,
      ...(spec.fromParams ?? []),
      ...where.params,
    )[0];
    Object.assign(totals, readValues(row ?? {}, names));
  }

  const rows = new Map<string, AggregateRow>();
  const sortKeys = new Map<string, number>();
  let truncated = false;
  if (input.dimension !== null) {
    const isDate = input.dimension === 'date';
    const dim = isDate ? null : spec.dimensions[input.dimension];
    if (!isDate && dim === undefined)
      throw new ReportQueryError(`unknown dimension ${input.dimension}`);
    const multi = groups.size > 1;
    const bounded = isDate || multi || spec.bounded?.includes(input.dimension) === true;
    for (const [anchor, names] of groups) {
      if (isDate && anchor === null) continue;
      const where = conditions(spec, ctx, anchor, input.range, names);
      const select = names
        .map((n, i) => `${spec.measures[n]?.expr ?? '0'} AS m${String(i)}`)
        .join(', ');
      let sql: string;
      if (isDate) {
        if (input.buckets === null)
          throw new ReportQueryError('buckets are required for the date dimension');
        sql = `WITH ${bucketCte(input.buckets)}
               SELECT b.k AS k, NULL AS label, NULL AS sk, ${select}
                 FROM ${spec.from} JOIN b ON ${anchor ?? 'NULL'} >= b.s AND ${anchor ?? 'NULL'} < b.e
                WHERE ${where.sql} GROUP BY b.k ORDER BY b.k`;
      } else {
        const label = dim?.label ?? 'NULL';
        const page = bounded ? '' : ` LIMIT ${lit(input.limit + 1)} OFFSET ${lit(input.offset)}`;
        sql = `SELECT ${dim?.key ?? 'NULL'} AS k, ${label} AS label, ${dim?.sort ?? 'NULL'} AS sk, ${select}
                 FROM ${spec.from} WHERE ${where.sql}
                GROUP BY 1 ORDER BY m0 DESC, k ASC${page}`;
      }
      const result = ctx.db.all<Record<string, SqlValue>>(
        sql,
        ...(spec.fromParams ?? []),
        ...where.params,
      );
      if (!bounded && result.length > input.limit) {
        truncated = true;
        result.pop();
      }
      for (const r of result) {
        const key = r['k'] === null || r['k'] === undefined ? '' : String(r['k']);
        const entry = rows.get(key) ?? {
          key,
          label: typeof r['label'] === 'string' ? r['label'] : null,
          values: {},
        };
        if (typeof r['sk'] === 'number') sortKeys.set(key, r['sk']);
        Object.assign(entry.values, readValues(r, names));
        rows.set(key, entry);
      }
    }
    for (const entry of rows.values()) {
      for (const name of input.measures) entry.values[name] ??= 0;
    }
  }

  let out = [...rows.values()];
  if (input.dimension !== null && input.dimension !== 'date') {
    const first = input.measures[0] ?? '';
    out.sort((a, b) => {
      const sa = sortKeys.get(a.key);
      const sb = sortKeys.get(b.key);
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
      return (b.values[first] ?? 0) - (a.values[first] ?? 0) || a.key.localeCompare(b.key);
    });
    if (groups.size > 1 || spec.bounded?.includes(input.dimension) === true) {
      truncated = out.length > input.offset + input.limit;
      out = out.slice(input.offset, input.offset + input.limit);
    }
  }
  return {
    rows: out,
    totals,
    currency:
      spec.moneyMeasures?.some((m) => input.measures.includes(m)) === true ? ctx.currency : null,
    currencies: [],
    truncated,
  };
}

/** Distinct currencies of a table in a date range (index on the anchor). */
export function currenciesIn(
  db: SqlDb,
  table: string,
  currencyColumn: string,
  anchor: string | null,
  range: { from: number; to: number },
  where = '1 = 1',
): string[] {
  const dateCond =
    anchor === null ? '1 = 1' : `${anchor} >= ${lit(range.from)} AND ${anchor} < ${lit(range.to)}`;
  return db
    .all<{ c: string }>(
      `SELECT DISTINCT ${currencyColumn} AS c FROM ${table} WHERE ${dateCond} AND ${where} ORDER BY 1 LIMIT 20`,
    )
    .map((r) => r.c);
}
