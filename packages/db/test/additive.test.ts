import { describe, expect, it } from 'vitest';
import { nonAdditiveStatements } from '../src/migrations/additive';
import { installationMigrations } from '../src/migrations/installation/index';
import { tenantMigrations } from '../src/migrations/tenant/index';
import type { Migration } from '../src/migrations/types';

const migration = (id: number, ...statements: string[]): Migration => ({
  id,
  name: `m${String(id)}`,
  statements,
});

describe('nonAdditiveStatements', () => {
  it('flags statements that break the previous release after a rollback', () => {
    const found = nonAdditiveStatements([
      migration(1, 'DROP TABLE contacts'),
      migration(2, 'ALTER TABLE contacts DROP COLUMN phone'),
      migration(3, 'ALTER TABLE contacts RENAME COLUMN phone TO mobile'),
      migration(4, 'ALTER TABLE contacts RENAME TO people'),
      migration(5, 'ALTER TABLE contacts ADD COLUMN owner TEXT NOT NULL'),
      migration(6, 'drop view contact_view'),
    ]);
    expect(found.map((f) => [f.migrationId, f.rule])).toEqual([
      [1, 'drop_table'],
      [2, 'drop_column'],
      [3, 'rename'],
      [4, 'rename'],
      [5, 'not_null_without_default'],
      [6, 'drop_table'],
    ]);
  });

  it('accepts additive statements, comments and string literals', () => {
    expect(
      nonAdditiveStatements([
        migration(
          1,
          'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)',
          `ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'drop table'`,
          'CREATE INDEX idx_notes_kind ON notes(kind) -- never DROP this',
          'UPDATE notes SET kind = "rename"',
        ),
      ]),
    ).toEqual([]);
  });

  it('skips migrations explicitly allowed', () => {
    expect(
      nonAdditiveStatements(
        [migration(7, 'DROP TABLE legacy')],
        [{ id: 7, reason: 'unused since 2026.9' }],
      ),
    ).toEqual([]);
  });

  it('keeps every installation and tenant migration additive', () => {
    expect(nonAdditiveStatements(installationMigrations)).toEqual([]);
    expect(nonAdditiveStatements(tenantMigrations)).toEqual([]);
  });
});
