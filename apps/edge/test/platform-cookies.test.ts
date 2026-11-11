import { describe, expect, it } from 'vitest';
import { sharedCookieDomain } from '../src/analytics/routes';
import { ev, FakeAnalyticsNamespace, SITE_ID, siteInit, T0 } from './helpers';

const MIN = 60_000;

describe('ad platform cookies on the session', () => {
  it('are added when they appear after the landing, never overwritten', () => {
    const ns = new FakeAnalyticsNamespace(() => T0);
    const site = ns.store(`site:${SITE_ID}`);
    site.initSite(siteInit());
    site.ingest(
      [
        ev({ vid: 'v-1', sid: 's-1', ts: T0 - 10 * MIN, clickIds: { gclid: 'G1' } }),
        ev({ vid: 'v-1', sid: 's-1', ts: T0 - 9 * MIN, clickIds: { gclid: 'G2', fbp: 'fb.1.1' } }),
        ev({ vid: 'v-1', sid: 's-1', ts: T0 - 8 * MIN, clickIds: { fbp: 'fb.1.2', ttp: 'tt' } }),
      ],
      [],
    );
    const db = (site as unknown as { db: { all<T>(q: string): T[] } }).db;
    const [row] = db.all<{ click_ids: string }>(`SELECT click_ids FROM sessions WHERE id = 's-1'`);
    expect(JSON.parse(row?.click_ids ?? '{}')).toEqual({ gclid: 'G1', fbp: 'fb.1.1', ttp: 'tt' });
  });
});

describe('sharedCookieDomain', () => {
  it('is the common parent of page and tracking host, two labels at least', () => {
    expect(sharedCookieDomain('www.example.com', 't.example.com')).toBe('example.com');
    expect(sharedCookieDomain('shop.example.co.uk', 'trk.example.co.uk')).toBe('example.co.uk');
    expect(sharedCookieDomain('www.example.com', 'edge.amable.net')).toBeNull();
    expect(sharedCookieDomain('www.example.com', '203.0.113.9')).toBeNull();
  });
});
