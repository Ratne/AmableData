import { describe, expect, it } from 'vitest';
import { runScheduledAnalytics } from '../../src/analytics/runtime';
import type { Env } from '../../src/env';
import { FakeR2 } from '../backup/helpers';

function env(tenants: string[], failing: string[] = []): Env {
  return {
    ENVIRONMENT: 'test',
    FILES: new FakeR2().asBucket(),
    DB: {
      prepare: () => ({ all: () => Promise.resolve({ results: [...tenants].sort().map((id) => ({ id })) }) }),
    },
    ANALYTICS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        indexList: () =>
          failing.some((id) => name === `tenant:${id}`) ? Promise.reject(new Error('boom')) : Promise.resolve([]),
      }),
    },
  } as unknown as Env;
}

describe('runScheduledAnalytics', () => {
  it('visits tenants round-robin under the tick budget', async () => {
    const e = env(['t1', 't2', 't3', 't4', 't5']);
    let clock = 0;
    // Every clock read advances 3 ms: a 10 ms budget covers four tenants per tick.
    const now = () => (clock += 3);
    const first = await runScheduledAnalytics(e, { budgetMs: 10, now });
    expect(first).toEqual({ visited: ['t1', 't2', 't3', 't4'], complete: false });
    const second = await runScheduledAnalytics(e, { budgetMs: 10, now });
    expect(second.visited.slice(0, 2)).toEqual(['t5', 't1']);
  });

  it('keeps going when one tenant fails', async () => {
    const result = await runScheduledAnalytics(env(['t1', 't2', 't3'], ['t2']), { budgetMs: 60_000 });
    expect(result).toEqual({ visited: ['t1', 't2', 't3'], complete: true });
  });
});
