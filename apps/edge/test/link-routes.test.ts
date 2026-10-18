import { trackerEventSchema } from '@amable/api-types';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { directLinkView, identityFromData } from '../src/analytics/enrich';
import { directLinkViews, resolveActionOrigin } from '../src/analytics/link-routes';
import { entranceCostMinor } from '../src/analytics/links/visit';
import { deliverWebhook, webhookTargetAllowed } from '../src/analytics/links/webhooks';
import { analyticsRoutes } from '../src/analytics/routes';
import { clearSiteConfigCache } from '../src/analytics/pipeline';
import type { Env } from '../src/env';
import { edgeEnv, SITE_ID } from './helpers';
import { CHROME_DESKTOP, HOST, IPHONE, linkHarness, OTHER_HOST, OTHER_SITE, vidOf } from './link-fixtures';

function allRows(h: ReturnType<typeof linkHarness>, table: string): string {
  const db = (h.store as unknown as { db: { all: (q: string) => unknown[] } }).db;
  return JSON.stringify(db.all(`SELECT * FROM ${table}`));
}

describe('entrance /go/{funnel}-{source}', () => {
  it('captures exactly the configured tracking fields and redirects with vid and resolved tokens', async () => {
    const h = linkHarness();
    const res = await h.get(
      `/go/${h.graph.id}-${h.source.id}?cid=CAMP1&fbclid=FB123&adset=AS9&zone=Z7&extra=SECRET&c=0.25`,
    );
    expect(res.status).toBe(302);
    const vid = vidOf(res);
    expect(vid).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(res.headers.get('location')).toBe(
      `https://lp.example.com/a?sub=CAMP1&z=Z7&x=SECRET&vid=${vid}&n=lander`,
    );
    expect(res.headers.get('set-cookie')).toContain(`amb_fvid=${vid}`);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);

    const [entrance, view] = h.touches(vid);
    expect(entrance).toMatchObject({
      kind: 'entrance',
      node_id: 't',
      funnel_id: h.graph.id,
      traffic_source_id: h.source.id,
      campaign: 'CAMP1',
      external_click_id: 'FB123',
      fields: { c1: 'AS9', c3: 'Z7' },
      cost_minor: 25,
    });
    expect(view).toMatchObject({ kind: 'view', node_id: 'lander', page_id: 'l1', fields: { c1: 'AS9', c3: 'Z7' } });
    expect(h.touches(vid)).toHaveLength(2);
    expect(h.store.listVisitorTags(vid)).toEqual(['entered']);
    expect(h.store.getFunnelSession(vid)).toMatchObject({
      funnel_id: h.graph.id,
      current_node_id: 'lander',
      current_page_id: 'l1',
      campaign: 'CAMP1',
      fields: { c1: 'AS9', c3: 'Z7' },
    });
  });

  it('never stores parameters that are not tracking fields', async () => {
    const h = linkHarness();
    const res = await h.get(`/go/${h.graph.id}-${h.source.id}?cid=C&extra=SECRET-VALUE&email=ann%40example.com`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('x=SECRET-VALUE');
    for (const table of ['touches', 'funnel_sessions', 'visitor_tags', 'conversion_log']) {
      expect(allRows(h, table)).not.toContain('SECRET-VALUE');
      expect(allRows(h, table)).not.toContain('ann@example.com');
    }
  });

  it('reuses the visitor of the link or of the cookie', async () => {
    const h = linkHarness();
    const link = `/go/${h.graph.id}-${h.source.id}`;
    const fromQuery = await h.get(`${link}?vid=visitor-from-url`);
    expect(vidOf(fromQuery)).toBe('visitor-from-url');
    const fromCookie = await h.get(link, { headers: { cookie: 'amb_fvid=visitor-from-cookie' } });
    expect(vidOf(fromCookie)).toBe('visitor-from-cookie');
    expect(h.touches('visitor-from-cookie').map((t) => t.kind)).toEqual(['entrance', 'view']);
  });

  it('routes on the condition: Italian mobile visitors get the mobile page, others the default route', async () => {
    const h = linkHarness();
    const link = `/go/${h.graph.id}-${h.source.id}?cid=C`;
    const mobile = await h.get(link, { headers: { 'user-agent': IPHONE }, cf: { country: 'IT' } });
    expect(mobile.headers.get('location')).toBe(`https://lp.example.com/m?vid=${vidOf(mobile)}&n=mobile`);
    expect(h.touches(vidOf(mobile)).map((t) => t.node_id)).toEqual(['t', 'mobile']);

    const desktop = await h.get(link, { headers: { 'user-agent': CHROME_DESKTOP }, cf: { country: 'IT' } });
    expect(new URL(desktop.headers.get('location')!).pathname).toBe('/a');
    const abroad = await h.get(link, { headers: { 'user-agent': IPHONE }, cf: { country: 'FR' } });
    expect(new URL(abroad.headers.get('location')!).pathname).toBe('/a');
  });

  it('enters at the node of the link and records bots without touches', async () => {
    const h = linkHarness();
    const res = await h.get(`/go/${h.graph.id}-${h.source.id}/offer/o1`);
    expect(res.headers.get('location')).toMatch(/^https:\/\/offer\.example\.net\/o\?aff=1&s1=[a-z2-7]{26}&vid=/);
    const bot = await h.get(`/go/${h.graph.id}-${h.source.id}`, { headers: { 'user-agent': 'Googlebot/2.1' } });
    expect(bot.status).toBe(302);
    expect(h.touches(vidOf(bot))).toEqual([]);
  });

  it('answers 404 on unknown hosts, hosts of another site and unknown funnels or sources', async () => {
    const h = linkHarness();
    const link = `/go/${h.graph.id}-${h.source.id}`;
    expect((await h.get(link, {}, 'unknown.test')).status).toBe(404);
    expect((await h.get(link, {}, OTHER_HOST)).status).toBe(404);
    expect((await h.get(`/go/fg_missing-${h.source.id}`)).status).toBe(404);
    expect((await h.get(`/go/${h.graph.id}-ts_missing`)).status).toBe(404);
    expect((await h.get(`${link}/bad%20node`)).status).toBe(404);
  });
});

describe('shared edge host: /s/{siteId} prefix', () => {
  const EDGE = 'edge.amable.test';

  it('serves entrance, action and postback with the site in the path and a per-site cookie', async () => {
    const h = linkHarness();
    const prefix = `/s/${SITE_ID}`;
    const res = await h.get(`${prefix}/go/${h.graph.id}-${h.source.id}?cid=C1`, {}, EDGE);
    expect(res.status).toBe(302);
    const vid = vidOf(res);
    expect(res.headers.get('location')).toBe(`https://lp.example.com/a?sub=C1&z=&x=&vid=${vid}&n=lander`);
    expect(res.headers.get('set-cookie')).toContain(`Path=${prefix}`);
    h.clock.now += 5_000;

    const click = await h.get(`${prefix}/a/1`, { headers: { cookie: `amb_fvid=${vid}` } }, EDGE);
    expect(click.status).toBe(302);
    const offerHit = h.touches(vid).at(-1)!.id;
    expect(new URL(click.headers.get('location')!).searchParams.get('s1')).toBe(offerHit);
    const fallback = await h.get(`${prefix}/go/${h.graph.id}/mobile/a/1`, {}, EDGE);
    expect(h.touches(vidOf(fallback))[0]).toMatchObject({ kind: 'action', node_id: 'mobile' });

    expect((await h.get(`${prefix}/pb?hit=${offerHit}&rev=3`, {}, EDGE)).status).toBe(200);
    expect((await h.get(`${prefix}/pb/event?hit=${offerHit}&e=1`, {}, EDGE)).status).toBe(200);
    expect(h.store.listConversions({ hit: offerHit }).map((c) => c.event)).toEqual(['sale', 'event:1']);
  });

  it('answers 404 without prefix on the shared host, for unknown sites and for funnels of another site', async () => {
    const h = linkHarness();
    const link = `/go/${h.graph.id}-${h.source.id}`;
    expect((await h.get(link, {}, EDGE)).status).toBe(404);
    expect((await h.get(`/s/st_cccccccccccccccccccc${link}`, {}, EDGE)).status).toBe(404);
    expect((await h.get(`/s/${OTHER_SITE}${link}`, {}, EDGE)).status).toBe(404);
    expect((await h.get(`/s/st_cccccccccccccccccccc/pb?hit=x`, {}, EDGE)).status).toBe(404);
    // Tracking hostnames keep the unprefixed links and a root cookie.
    expect((await h.get(link)).headers.get('set-cookie')).toContain('Path=/;');
  });
});

describe('pages built with the page builder', () => {
  it('redirects to the public URL of the page, with vid and n appended', async () => {
    const h = linkHarness();
    const res = await h.get(`/go/${h.graph.id}-${h.source.id}/hosted`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://shop.example/spring?promo=1&vid=${vidOf(res)}&n=hosted`);
    expect(h.hostedLookups).toContain('tenant_1:pg_live');
    expect(h.touches(vidOf(res)).at(-1)).toMatchObject({ kind: 'view', node_id: 'hosted', page_id: 'h1' });
  });

  it('takes the default exit of the node when the page is unknown, else answers 502', async () => {
    const h = linkHarness();
    const fallback = await h.get(`/go/${h.graph.id}-${h.source.id}/gone`);
    expect(fallback.status).toBe(302);
    expect(fallback.headers.get('location')).toMatch(/^https:\/\/offer\.example\.net\/o\?aff=1&/);
    expect((await h.get(`/go/${h.graph.id}-${h.source.id}/gone2`)).status).toBe(502);
  });
});

describe('entrance cost', () => {
  const source = linkHarness().source;
  it('reads c=, cpm_ per mille, then the source and funnel defaults, with the incoming modifier', () => {
    expect(entranceCostMinor('0.25', source, null, 'EUR')).toBe(25);
    expect(entranceCostMinor('cpm_2000', source, null, 'EUR')).toBe(200);
    expect(entranceCostMinor('cpm_12.34', source, null, 'EUR')).toBe(1);
    expect(entranceCostMinor(null, source, null, 'EUR')).toBe(5);
    expect(entranceCostMinor('{cost}', source, null, 'EUR')).toBe(5);
    expect(entranceCostMinor(null, { ...source, default_cost_minor: null }, { default_cost_minor: 7 }, 'EUR')).toBe(7);
    expect(entranceCostMinor('0.10', { ...source, cost_modifier_pct: 10 }, null, 'EUR')).toBe(11);
    expect(entranceCostMinor(null, { ...source, cost_type: 'none' }, { default_cost_minor: 7 }, 'EUR')).toBeNull();
  });

  it('stores the cpm cost on the entrance touch', async () => {
    const h = linkHarness();
    const res = await h.get(`/go/${h.graph.id}-${h.source.id}?c=cpm_2000`);
    expect(h.touches(vidOf(res))[0]).toMatchObject({ kind: 'entrance', cost_minor: 200 });
  });
});

describe('action links', () => {
  async function entered(h: ReturnType<typeof linkHarness>): Promise<string> {
    const vid = vidOf(await h.get(`/go/${h.graph.id}-${h.source.id}?cid=CAMP1&adset=AS9`));
    h.clock.now += 5_000;
    return vid;
  }

  it('1. explicit vid + rn win over the session', async () => {
    const h = linkHarness();
    const vid = await entered(h);
    // The session says lander; `rn` says the visitor clicked on the mobile page (another tab).
    const res = await h.get(`/a/1?vid=${vid}&rn=mobile&utm_x=1`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://offer.example.net/o');
    expect(location.searchParams.get('vid')).toBe(vid);
    const [, , click, view] = h.touches(vid);
    expect(click).toMatchObject({ kind: 'click', node_id: 'mobile', action_number: 1, campaign: 'CAMP1' });
    expect(view).toMatchObject({ kind: 'view', node_id: 'offer', page_id: 'o1', fields: { c1: 'AS9' } });
    expect(location.searchParams.get('s1')).toBe(view!.id);
  });

  it('2. without parameters, the referrer carries vid and n', async () => {
    const h = linkHarness();
    const vid = await entered(h);
    const res = await h.get('/a/1', { headers: { referer: `https://lp.example.com/a?sub=x&vid=${vid}&n=lander` } });
    expect(res.status).toBe(302);
    expect(vidOf(res)).toBe(vid);
    expect(h.touches(vid).slice(2).map((t) => [t.kind, t.node_id, t.page_id])).toEqual([
      ['click', 'lander', 'l1'],
      ['view', 'offer', 'o1'],
    ]);
  });

  it('3. without parameters nor referrer, the cookie session gives the origin', async () => {
    const h = linkHarness();
    const vid = await entered(h);
    const res = await h.get('/a/2', { headers: { cookie: `amb_fvid=${vid}` } });
    expect(res.status).toBe(302);
    expect(h.touches(vid).slice(2).map((t) => [t.kind, t.node_id, t.action_number])).toEqual([
      ['click', 'lander', 2],
      ['view', 'offer', null],
    ]);
    // Webhook node on the way: delivered in the background, never before the redirect.
    expect(h.pending).toHaveLength(1);
    await h.settle();
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0]!.url).toBe('https://hooks.example.net/funnel');
    expect(await h.fetched[0]!.json()).toMatchObject({ funnel_id: h.graph.id, node_id: 'hook', visitor_id: vid, tags: ['entered'] });
  });

  it('4. without any known session, the default funnel and node of the path', async () => {
    const h = linkHarness();
    const res = await h.get(`/go/${h.graph.id}/mobile/a/1`);
    expect(res.status).toBe(302);
    const vid = vidOf(res);
    expect(h.touches(vid).map((t) => [t.kind, t.node_id])).toEqual([
      ['action', 'mobile'],
      ['view', 'offer'],
    ]);
    // A known session wins over the defaults.
    const known = await entered(h);
    await h.get(`/go/${h.graph.id}/mobile/a/1`, { headers: { cookie: `amb_fvid=${known}` } });
    expect(h.touches(known)[2]).toMatchObject({ kind: 'click', node_id: 'lander' });
  });

  it('answers 404 without session nor defaults, on bad action numbers and on unknown hosts', async () => {
    const h = linkHarness();
    expect((await h.get('/a/1')).status).toBe(404);
    expect((await h.get('/a/0?vid=visitor-xyz1')).status).toBe(404);
    expect((await h.get('/a/256?vid=visitor-xyz1')).status).toBe(404);
    const vid = await entered(h);
    expect((await h.get(`/a/1?vid=${vid}`, {}, OTHER_HOST)).status).toBe(404);
  });

  it('resolves the origin in the documented order', () => {
    const q = (s: string) => new URLSearchParams(s);
    const ref = new URL('https://lp.example.com/a?vid=ref-visitor&n=lander');
    const defaults = { funnelId: 'fg_1', nodeId: 'mobile' };
    expect(resolveActionOrigin(q('vid=url-visitor&rn=offer'), ref, 'cookie-visitor', defaults)).toEqual({
      visitorId: 'url-visitor',
      nodeId: 'offer',
      method: 'explicit',
    });
    expect(resolveActionOrigin(q(''), ref, 'cookie-visitor', defaults)).toMatchObject({ visitorId: 'ref-visitor', nodeId: 'lander', method: 'referrer' });
    expect(resolveActionOrigin(q(''), null, 'cookie-visitor', defaults)).toMatchObject({ visitorId: 'cookie-visitor', nodeId: null, method: 'cookie' });
    expect(resolveActionOrigin(q(''), null, null, defaults)).toMatchObject({ nodeId: 'mobile', method: 'default' });
    expect(resolveActionOrigin(q(''), null, null, null)).toBeNull();
  });
});

describe('webhooks', () => {
  it('blocks private targets and times out without throwing', async () => {
    expect(webhookTargetAllowed('https://hooks.example.net/x')).toBe(true);
    for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.1.2.3/', 'http://[::1]/', 'ftp://example.com/']) {
      expect(webhookTargetAllowed(url)).toBe(false);
    }
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const effect = { type: 'webhook' as const, nodeId: 'hook', url: 'https://hooks.example.net/x', method: 'GET' as const, headers: {} };
    expect(await deliverWebhook(effect, hanging, 10)).toEqual({ nodeId: 'hook', ok: false, status: null, error: 'timeout' });
    expect(await deliverWebhook({ ...effect, url: 'http://127.0.0.1/' }, hanging, 10)).toMatchObject({ error: 'blocked_target' });
  });
});

describe('tracker v2 payload', () => {
  const base = { type: 'pageview', site: SITE_ID, url: 'https://www.example.com/' };

  it('accepts the direct-link context and link attribution, dropping malformed ones', () => {
    const ok = trackerEventSchema.parse({ ...base, dl: { f: 'fg_1', ts: 'ts_1', n: 'lander', p: 'l1' }, la: { sl: 'news' } });
    expect(ok.dl).toEqual({ f: 'fg_1', ts: 'ts_1', n: 'lander', p: 'l1' });
    expect(ok.la).toEqual({ sl: 'news' });
    const bad = trackerEventSchema.parse({ ...base, dl: { f: 'bad id!' } });
    expect(bad.dl).toBeUndefined();
  });

  it('accepts a phone-only identify', () => {
    expect(identityFromData({ phone: '+393331234567' })).toEqual({
      userId: null,
      email: null,
      name: null,
      traits: { phone: '+393331234567' },
    });
    expect(identityFromData({ name: 'Ann' })).toBeNull();
  });

  it('takes the direct-link landing only from the landing URL itself', () => {
    const dl = { f: 'fg_1', ts: 'ts_1', n: 'lander' };
    const landing = { ...base, vid: 'visitor-12345678', url: 'https://www.example.com/?f=fg_1&ts=ts_1&n=lander', dl };
    expect(directLinkView(trackerEventSchema.parse(landing))).toMatchObject({ funnelId: 'fg_1', nodeId: 'lander' });
    expect(directLinkView(trackerEventSchema.parse({ ...landing, url: 'https://www.example.com/next' }))).toBeNull();
    expect(directLinkView(trackerEventSchema.parse({ ...landing, url: `${landing.url}&vid=x12345678` }))).toBeNull();
    expect(directLinkView(trackerEventSchema.parse({ ...landing, type: 'goal', name: 'x' }))).toBeNull();
  });
});

describe('direct links', () => {
  it('records the entrance and the view of a pageview carrying f, ts, n, p', async () => {
    clearSiteConfigCache();
    const h = linkHarness();
    const env = edgeEnv(h.ns) as Env;
    const app = new Hono<{ Bindings: Env }>().use('/e', directLinkViews).route('/', analyticsRoutes);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
    const send = (url: string) =>
      app.fetch(
        new Request(`https://${HOST}/e`, {
          method: 'POST',
          headers: { origin: 'https://www.example.com', 'user-agent': CHROME_DESKTOP, 'content-type': 'text/plain' },
          body: JSON.stringify({
            type: 'pageview',
            site: SITE_ID,
            url,
            vid: 'visitor-direct-1',
            sid: 'session-direct-1',
            dl: { f: h.graph.id, ts: h.source.id, n: 'lander', p: 'l1' },
          }),
        }),
        env,
        ctx as unknown as ExecutionContext,
      );
    const landing = `https://www.example.com/landing?f=${h.graph.id}&ts=${h.source.id}&n=lander&p=l1&cid=C9&adset=A1&extra=SECRET`;
    expect((await send(landing)).status).toBe(202);
    await Promise.all(pending.splice(0));
    const touches = h.touches('visitor-direct-1');
    expect(touches.map((t) => [t.kind, t.node_id, t.page_id])).toEqual([
      ['entrance', 'lander', 'l1'],
      ['view', 'lander', 'l1'],
    ]);
    expect(touches[1]).toMatchObject({
      session_id: 'session-direct-1',
      campaign: 'C9',
      fields: { c1: 'A1' },
      traffic_source_id: h.source.id,
    });
    expect(allRows(h, 'touches')).not.toContain('SECRET');

    // Later pageviews of the session resend the context: no new touches.
    expect((await send('https://www.example.com/next')).status).toBe(202);
    await Promise.all(pending.splice(0));
    expect(h.touches('visitor-direct-1')).toHaveLength(2);

    // The action link of the page then works from the stored session.
    h.clock.now = Date.now() + 60_000;
    const res = await h.get('/a/1?vid=visitor-direct-1&rn=lander');
    expect(res.headers.get('location')).toContain('https://offer.example.net/o?aff=1');
    expect(h.touches('visitor-direct-1').map((t) => t.kind)).toEqual(['entrance', 'view', 'click', 'view']);
  });
});
