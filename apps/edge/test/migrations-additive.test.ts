import { nonAdditiveStatements } from '@amable/db';
import { describe, expect, it } from 'vitest';
import { analyticsMigrations } from '../src/analytics/migrations';

describe('AnalyticsDO migrations', () => {
  it('keep the previous release working after a rollback', () => {
    expect(nonAdditiveStatements(analyticsMigrations)).toEqual([]);
  });
});
