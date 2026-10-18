import { trackerEventSchema } from '@amable/api-types';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { enrichServerEvent, enrichTrackerEvent, type EdgeSiteConfig, type RequestContext } from '../src/analytics/enrich';
import { createStore, SITE_ID, siteInit, T0 } from './helpers';

const site: EdgeSiteConfig = {
  siteId: SITE_ID,
  tenantId: 'tenant_1',
  hostnames: ['example.com'],
  cookieless: false,
  allowLocalhost: false,
  currency: 'EUR',
  secretHash: null,
  salt: { day: '2026-10-15', value: 'salt' },
};

const ctx = (eid: string): RequestContext => ({
  eid,
  now: T0,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  geo: { country: 'IT', region: null, city: null, latitude: null, longitude: null },
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL = 'mario.rossi@example.com';

async function pageview(url: string, extra: Record<string, unknown> = {}, vid = 'visitor-12345678') {
  const payload = trackerEventSchema.parse({ type: 'pageview', site: SITE_ID, url, vid, sid: `s-${vid}`, fs: T0, sn: 1, ...extra });
  const event = await enrichTrackerEvent(payload, site, ctx(`e-${vid}-${url.length}`));
  if (event === null) throw new Error('unusable event');
  return event;
}

describe('landing link params (he / sl / el)', () => {
  it('hashes he= (tracker payload or URL) and strips it from the stored URL', async () => {
    const fromPayload = await pageview('https://www.example.com/offer?he=Mario.Rossi%40Example.com&x=1', {
      la: { he: 'Mario.Rossi@Example.com', el: 'email' },
    });
    expect(fromPayload.landing).toEqual({ emailHash: sha(EMAIL), sourceLabel: null, emailLabel: 'email' });
    expect(fromPayload.url).toBe('https://www.example.com/offer?x=1');
    expect(fromPayload).toMatchObject({ channel: 'Email', source: '@email' });

    const fromUrl = await pageview(`https://www.example.com/?he=${EMAIL}`);
    expect(fromUrl.landing?.emailHash).toBe(sha(EMAIL));
    expect(fromUrl.url).toBe('https://www.example.com/');

    const hashed = await pageview(`https://www.example.com/?he=${sha(EMAIL).toUpperCase()}`);
    expect(hashed.landing?.emailHash).toBe(sha(EMAIL));
    // Not an email nor a hash: ignored, but still removed from the URL.
    const junk = await pageview('https://www.example.com/?he=nope');
    expect(junk.landing).toBeUndefined();
    expect(junk.url).toBe('https://www.example.com/');
  });

  it('turns sl= into a custom @source and el= into an Email source label', async () => {
    const sl = await pageview('https://www.example.com/?sl=podcast');
    expect(sl).toMatchObject({ channel: 'Referral', source: '@podcast', landing: { sourceLabel: 'podcast' } });
    const slWithReferrer = await pageview('https://www.example.com/', { ref: 'https://news.ycombinator.com/', la: { sl: 'hn launch' } });
    expect(slWithReferrer).toMatchObject({ channel: 'Organic social', source: '@hn launch' });
    const el = await pageview('https://www.example.com/?el=september-launch&sl=other');
    expect(el).toMatchObject({ channel: 'Email', source: '@september-launch' });
    const bad = await pageview('https://www.example.com/?sl=%3Cscript%3E');
    expect(bad.landing).toBeUndefined();
    expect(bad.channel).toBe('Direct');
    // Only landing pageviews carry them.
    const goal = trackerEventSchema.parse({ type: 'goal', site: SITE_ID, name: 'signup', url: 'https://www.example.com/?sl=x', vid: 'visitor-12345678', la: { sl: 'x' } });
    expect((await enrichTrackerEvent(goal, site, ctx('g1')))?.landing).toBeUndefined();
  });

  it('applies to server pageviews too', async () => {
    const event = await enrichServerEvent(
      {
        type: 'pageview',
        url: `https://www.example.com/?he=${EMAIL}&el=newsletter`,
        visitor_id: 'srv-visitor',
        user_agent: ctx('srv').userAgent,
        ip: '203.0.113.7',
      },
      site,
      ctx('srv'),
    );
    expect(event).toMatchObject({ url: 'https://www.example.com/?el=newsletter', channel: 'Email', source: '@newsletter' });
    expect(event.landing?.emailHash).toBe(sha(EMAIL));
  });

  it('persists the hash as identity key, the label as session source, and never the clear email', async () => {
    const { store, db } = createStore();
    store.initSite(siteInit());
    const event = await pageview(`https://www.example.com/landing?he=${EMAIL}&el=email`, { la: { he: EMAIL, el: 'email' } });
    store.ingest([event], []);
    expect(store.findVisitorsByKey('email', sha(EMAIL)).map((k) => k.visitor_id)).toEqual(['visitor-12345678']);
    expect(store.findVisitorsByKey('email', EMAIL)).toEqual([]);
    expect(db.raw.prepare(`SELECT channel, source FROM sessions`).all()).toEqual([{ channel: 'Email', source: '@email' }]);
    const tables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const dump = JSON.stringify(db.raw.prepare(`SELECT * FROM "${name}"`).all());
      expect(dump, name).not.toContain('mario.rossi');
    }
  });
});
