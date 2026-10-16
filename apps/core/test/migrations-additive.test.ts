import { nonAdditiveStatements } from '@amable/db';
import { describe, expect, it } from 'vitest';
import { engineMigrations } from '../src/automation/migrations';
import { mailMigrations } from '../src/email/db/migrations';

describe('Durable Object migrations', () => {
  it('keep the previous release working after a rollback', () => {
    expect(nonAdditiveStatements(engineMigrations)).toEqual([]);
    expect(nonAdditiveStatements(mailMigrations)).toEqual([]);
  });
});
