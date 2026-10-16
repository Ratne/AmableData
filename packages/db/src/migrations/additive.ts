import type { Migration } from './types';

/**
 * Fleet updates roll back code but never the schema: after a rollback the previous
 * release runs against the migrated database. Every migration must therefore keep
 * the previous release working, i.e. only add tables, columns, indexes and triggers.
 * A column or table is removed in two releases: first stop using it, then drop it
 * in a later migration listed in `allowed` with the reason.
 */

export interface NonAdditiveStatement {
  readonly migrationId: number;
  readonly migrationName: string;
  readonly rule: string;
  readonly statement: string;
}

export interface AllowedNonAdditive {
  readonly id: number;
  readonly reason: string;
}

const RULES: readonly { readonly rule: string; readonly test: (sql: string) => boolean }[] = [
  { rule: 'drop_table', test: (sql) => /\bDROP\s+(TABLE|VIEW|TRIGGER)\b/i.test(sql) },
  { rule: 'drop_column', test: (sql) => /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i.test(sql) },
  { rule: 'rename', test: (sql) => /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i.test(sql) },
  {
    rule: 'not_null_without_default',
    test: (sql) =>
      /\bALTER\s+TABLE\b[\s\S]*\bADD\b[\s\S]*\bNOT\s+NULL\b/i.test(sql) &&
      !/\bDEFAULT\b/i.test(sql),
  },
];

/** Removes comments and string literals so their content never matches a rule. */
function code(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

export function nonAdditiveStatements(
  migrations: readonly Migration[],
  allowed: readonly AllowedNonAdditive[] = [],
): NonAdditiveStatement[] {
  const allowedIds = new Set(allowed.map((a) => a.id));
  const found: NonAdditiveStatement[] = [];
  for (const migration of migrations) {
    if (allowedIds.has(migration.id)) continue;
    for (const statement of migration.statements) {
      const sql = code(statement);
      for (const { rule, test } of RULES) {
        if (test(sql))
          found.push({ migrationId: migration.id, migrationName: migration.name, rule, statement });
      }
    }
  }
  return found;
}
