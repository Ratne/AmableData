import { describe, expect, it } from 'vitest';
import {
  DO_STORAGE_LIMIT_BYTES,
  shrunkRetentionDays,
  storagePressure,
} from '../src/analytics/store/storage';
import { createStore, ev, siteInit, T0 } from './helpers';

const GB = 1024 ** 3;
const DAY = 86_400_000;

describe('DO storage guard', () => {
  it('classifies the pressure against the 10 GB limit', () => {
    expect(DO_STORAGE_LIMIT_BYTES).toBe(10 * GB);
    expect(storagePressure(6 * GB)).toBe('ok');
    expect(storagePressure(7.5 * GB)).toBe('warn');
    expect(storagePressure(9 * GB)).toBe('shrink');
  });

  it('halves the hot window, never below 30 days', () => {
    expect(shrunkRetentionDays(90)).toBe(45);
    expect(shrunkRetentionDays(40)).toBe(30);
    expect(shrunkRetentionDays(30)).toBe(30);
  });

  it('a shrunk retention purges more, an override never extends the configured window', async () => {
    const clock = { now: T0 - 50 * DAY };
    const { store, db } = createStore(clock);
    store.initSite(siteInit({ retentionDays: 90 }));
    store.ingest([ev({ eid: 't:1', ts: T0 - 50 * DAY, path: '/a' })], []);
    clock.now = T0;
    await store.retention(null, 400);
    expect(db.all(`SELECT path FROM pageviews`)).toHaveLength(1);
    await store.retention(null, shrunkRetentionDays(90));
    expect(db.all(`SELECT path FROM pageviews`)).toHaveLength(0);
  });
});
