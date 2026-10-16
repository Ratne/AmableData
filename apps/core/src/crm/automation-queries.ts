import type { CrmContext } from './context';
import { first } from './db/sql';
import { invalid } from './errors';
import { parseJson } from './util';

export interface OnceInput {
  /** Idempotency key chosen by the engine (`eng:<token>:<step>`). */
  key: string;
  op: string;
  input: unknown;
}

/**
 * Runs a CRM operation at most once per key, atomically with the key record
 * (same transaction): a retried automation step replays the stored result
 * instead of creating a second note, task, opportunity or order.
 */
export function runOnce(
  ctx: CrmContext,
  input: OnceInput,
  run: (op: string, input: unknown) => unknown,
): { replayed: boolean; value: unknown } {
  const done = first<{ response: string | null }>(
    ctx.db,
    `SELECT response FROM crm_idempotency_keys WHERE key = ? AND status IS NOT NULL`,
    input.key,
  );
  if (done !== undefined) return { replayed: true, value: parseJson<unknown>(done.response, null) };
  const value = run(input.op, input.input);
  ctx.db.run(
    `INSERT INTO crm_idempotency_keys (key, request_hash, status, response, created_at)
     VALUES (?, 'automation', 200, ?, ?)
     ON CONFLICT (key) DO UPDATE SET status = 200, response = excluded.response`,
    input.key,
    JSON.stringify(value ?? null),
    ctx.now(),
  );
  return { replayed: false, value };
}

const BUILTIN_DATE_COLUMNS = new Set(['birthday', 'anniversary', 'created_at']);
const MAX_IDS = 10_000;

/**
 * Contacts whose date field falls on a month/day (`MM-DD`), for the automation
 * engine's yearly date goals. Built-in `birthday`/`anniversary` (YYYY-MM-DD),
 * `created_at` (epoch ms, UTC day) or `custom.<key>` (DATE / DATE_TIME values).
 * `includeLeapDay` also returns Feb 29 dates (used on Feb 28 of non-leap years).
 */
export function contactIdsByMonthDay(
  ctx: CrmContext,
  input: { field: string; monthDay: string; includeLeapDay?: boolean },
): string[] {
  if (!/^\d{2}-\d{2}$/.test(input.monthDay)) throw invalid('monthDay', 'expected MM-DD');
  const days =
    input.includeLeapDay === true ? [input.monthDay, '02-29'] : [input.monthDay, input.monthDay];
  if (BUILTIN_DATE_COLUMNS.has(input.field)) {
    const expr =
      input.field === 'created_at'
        ? `strftime('%m-%d', created_at / 1000, 'unixepoch')`
        : `substr(${input.field}, 6, 5)`;
    return ctx.db
      .all<{ id: string }>(
        `SELECT id FROM crm_contacts WHERE deleted_at IS NULL AND ${expr} IN (?, ?) ORDER BY id LIMIT ?`,
        days[0] ?? '',
        days[1] ?? '',
        MAX_IDS,
      )
      .map((row) => row.id);
  }
  if (!input.field.startsWith('custom.')) throw invalid('field', 'unknown date field');
  return ctx.db
    .all<{ id: string }>(
      `SELECT c.id FROM crm_custom_field_values v
       JOIN crm_custom_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
       JOIN crm_contacts c ON c.id = v.entity_id AND c.deleted_at IS NULL
       WHERE v.entity = 'contact' AND f.entity = 'contact' AND f.key = ?
         AND substr(v.value_text, 6, 5) IN (?, ?)
       ORDER BY c.id LIMIT ?`,
      input.field.slice('custom.'.length),
      days[0] ?? '',
      days[1] ?? '',
      MAX_IDS,
    )
    .map((row) => row.id);
}
