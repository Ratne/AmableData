import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKER_BUNDLES } from '@amable/tracker/bundles';
import { Hono } from 'hono';
import {
  clearSiteConfigCache,
  consumeAnalyticsBatch,
  localCounters,
} from '../src/analytics/pipeline';
import { analyticsRoutes } from '../src/analytics/routes';
import { newSiteSecret, proxyKeyFor } from '../src/analytics/rpc';
import type { AnalyticsMessage } from '../src/analytics/types';
import type { Env } from '../src/env';
import { edgeEnv, FakeAnalyticsNamespace, FakeQueue, SITE_ID, siteInit, T0 } from './helpers';
import { sha256Hex } from '@amable/auth';

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

let ns: FakeAnalyticsNamespace;
let secret: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearSiteConfigCache();
  localCounters.clear();
  ns = new FakeAnalyticsNamespace();
  secret = newSiteSecret(SITE_ID);
  ns.store(`site:${SITE_ID}`).initSite(siteInit({ secretHash: await sha256Hex(secret) }));
});
afterEach(() => vi.useRealTimers());

function pageview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'pageview',
    site: SITE_ID,
    url: 'https://www.example.com/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=oct',
    ref: 'https://mail.google.com/',
    vw: 1280,
    vh: 800,
    sw: 1440,
    sh: 900,
    lang: 'it-IT',
    tz: 'Europe/Rome',
    vid: '11111111-2222-4333-8444-555555555555',
    sid: 's0123456789abcdef0123456789abcdef',
    fs: T0,
    sn: 1,
    src: { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'oct' },
    ...overrides,
  };
}

interface PostOptions {
  origin?: string | null;
  ua?: string;
  ip?: string;
  cf?: Record<string, unknown>;
}

async function post(env: Env, body: unknown, opts: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'text/plain;charset=UTF-8',
    'user-agent': opts.ua ?? CHROME,
    'cf-connecting-ip': opts.ip ?? '203.0.113.7',
  };
  if (opts.origin !== null) headers['origin'] = opts.origin ?? 'https://www.example.com';
  const req = new Request('https://t.example.com/e', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, 'cf', {
    value: opts.cf ?? {
      country: 'IT',
      region: 'Lombardy',
      city: 'Milan',
      latitude: '45.46',
      longitude: '9.19',
    },
  });
  return analyticsRoutes.fetch(req, env);
}

function siteDb() {
  return ns.store(`site:${SITE_ID}`);
}

describe('POST /e (browser)', () => {
  it('accepts an allowed origin, enriches and writes to the site DO (no queue binding)', async () => {
    const env = edgeEnv(ns);
    const res = await post(env, pageview());
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    const ov = siteDb().overview({ from: '2026-10-15', to: '2026-10-15' });
    expect(ov).toMatchObject({ ok: true, value: { visitors: 1, pageviews: 1 } });
    const channel = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'channel', 5);
    expect(channel.ok && channel.value.rows[0]?.value).toBe('Email');
    const city = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'city', 5);
    expect(city.ok && city.value.rows[0]?.value).toBe('Milan');
    const browser = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'browser', 5);
    expect(browser.ok && browser.value.rows[0]?.value).toBe('Chrome');
    expect(localCounters.get(`${SITE_ID}:pageview`)).toBe(1);
  });

  it('keeps the ad ids of the tracked link on the session, dropping unfilled macros', async () => {
    const env = edgeEnv(ns);
    await post(
      env,
      pageview({
        src: {
          utm_source: 'facebook',
          amb_cid: '120200',
          amb_asid: '{{adset.id}}',
          amb_adid: '120299',
          amb_pl: 'Feed',
        },
      }),
    );
    const range = { from: '2026-10-15', to: '2026-10-15' };
    const ad = siteDb().breakdown(range, 'ad', 5);
    expect(ad.ok && ad.value.rows.map((r) => r.value)).toEqual(['120299']);
    const campaign = siteDb().breakdown(range, 'ad_campaign', 5);
    expect(campaign.ok && campaign.value.rows.map((r) => r.value)).toEqual(['120200']);
    const set = siteDb().breakdown(range, 'ad_set', 5);
    expect(set.ok && set.value.rows.map((r) => r.value)).toEqual([null]);
  });

  it('enqueues when the queue binding exists and the consumer batches per site', async () => {
    const queue = new FakeQueue();
    const env = edgeEnv(ns, queue);
    await post(env, pageview());
    await post(env, pageview({ type: 'goal', name: 'signup', data: { plan: 'pro' } }));
    expect(queue.sent.map((m) => m.kind)).toEqual(['event', 'event']);
    const first = queue.sent[0];
    expect(first?.kind === 'event' && first.event).toMatchObject({
      channel: 'Email',
      path: '/pricing',
      utm: { campaign: 'oct' },
      geo: { country: 'IT', latitude: 45.46 },
      device: 'desktop',
      os: 'macOS',
    });
    const acked: string[] = [];
    const batch = {
      queue: 'analytics',
      messages: queue.sent.map((body, i) => ({
        id: String(i),
        body,
        attempts: 1,
        timestamp: new Date(),
        ack: () => acked.push(String(i)),
        retry: () => undefined,
      })),
    } as unknown as MessageBatch<AnalyticsMessage>;
    await consumeAnalyticsBatch(batch, env);
    expect(acked).toEqual(['0', '1']);
    const goals = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'goal', 5);
    expect(goals.ok && goals.value.rows).toEqual([
      { value: 'signup', visitors: 1, completions: 1 },
    ]);
  });

  it('dedupes on the client event id and keeps the client time (never in the future)', async () => {
    const queue = new FakeQueue();
    const env = edgeEnv(ns, queue);
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await post(env, pageview({ id, at: T0 - 60_000 }));
    await post(env, pageview({ id, at: T0 - 60_000 }));
    await post(env, pageview({ id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', at: T0 + 3_600_000 }));
    const events = queue.sent.flatMap((m) => (m.kind === 'event' ? [m.event] : []));
    expect(events.map((e) => e.eid)).toEqual([
      `t:${id}`,
      `t:${id}`,
      't:ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    ]);
    expect(events.map((e) => e.ts)).toEqual([T0 - 60_000, T0 - 60_000, T0]);
    await consumeAnalyticsBatch(
      {
        queue: 'analytics',
        messages: queue.sent.map((body, i) => ({
          id: String(i),
          body,
          attempts: 1,
          timestamp: new Date(),
          ack: () => undefined,
          retry: () => undefined,
        })),
      } as unknown as MessageBatch<AnalyticsMessage>,
      env,
    );
    const ov = siteDb().overview({ from: '2026-10-15', to: '2026-10-15' });
    expect(ov).toMatchObject({ ok: true, value: { pageviews: 2 } });
  });

  it('rejects foreign origins, unknown sites, bad payloads and oversize bodies', async () => {
    const env = edgeEnv(ns);
    expect((await post(env, pageview(), { origin: 'https://evil.example.org' })).status).toBe(403);
    expect((await post(env, pageview({ url: 'https://evil.example.org/' }))).status).toBe(403);
    expect((await post(env, pageview(), { origin: null })).status).toBe(403);
    expect((await post(env, pageview(), { origin: 'http://localhost:3000' })).status).toBe(403);
    expect((await post(env, pageview({ site: 'st_bbbbbbbbbbbbbbbbbbbb' }))).status).toBe(404);
    expect((await post(env, pageview({ site: 'not-a-site' }))).status).toBe(404);
    expect((await post(env, { type: 'nope' })).status).toBe(400);
    expect((await post(env, pageview({ type: 'goal', name: 'Bad Name!' }))).status).toBe(400);
    expect((await post(env, pageview({ data: { blob: 'x'.repeat(17_000) } }))).status).toBe(413);
  });

  it('answers CORS preflight', async () => {
    const res = await analyticsRoutes.fetch(
      new Request('https://t.example.com/e', {
        method: 'OPTIONS',
        headers: { origin: 'https://www.example.com' },
      }),
      edgeEnv(ns),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
  });

  it('counts bots and crawlers apart, never as visitors', async () => {
    const env = edgeEnv(ns);
    const res = await post(env, pageview(), {
      ua: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    });
    expect(res.status).toBe(202);
    const ov = siteDb().overview({ from: '2026-10-15', to: '2026-10-15' });
    expect(ov.ok && ov.value.visitors).toBe(0);
    const bots = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'bot_category', 5);
    expect(bots.ok && bots.value.rows).toEqual([{ value: 'training', visitors: 0, hits: 1 }]);
  });

  it('cookieless sites ignore client ids and hash IP + UA with the daily salt', async () => {
    siteDb().updateSite({ cookieless: true });
    const queue = new FakeQueue();
    const env = edgeEnv(ns, queue);
    await post(env, pageview());
    await post(env, pageview({ vid: undefined, sid: undefined, cl: 1 }));
    await post(env, pageview(), { ip: '198.51.100.1' });
    const vids = queue.sent.map((m) => (m.kind === 'event' ? m.event.vid : ''));
    expect(vids[0]).toMatch(/^h[0-9a-f]{32}$/);
    expect(vids[1]).toBe(vids[0]);
    expect(vids[2]).not.toBe(vids[0]);
    expect(
      queue.sent.every((m) => m.kind === 'event' && m.event.sid === null && m.event.cookieless),
    ).toBe(true);
    // Next UTC day: new salt, new hash for the same person.
    vi.setSystemTime(T0 + 86_400_000);
    await post(env, pageview());
    const next = queue.sent.at(-1);
    expect(next?.kind === 'event' && next.event.vid).not.toBe(vids[0]);
  });

  it('tells the cookie builds whether the site is cookieless', async () => {
    const env = edgeEnv(ns, new FakeQueue());
    const ask = (site: string) => analyticsRoutes.request(`/e?site=${site}`, {}, env);
    const before = await ask(SITE_ID);
    expect(before.headers.get('access-control-allow-origin')).toBe('*');
    expect(await before.json()).toEqual({ cookieless: false });
    siteDb().updateSite({ cookieless: true });
    clearSiteConfigCache();
    expect(await (await ask(SITE_ID)).json()).toEqual({ cookieless: true });
    expect((await ask('nope')).status).toBe(404);
  });

  it('a tracking domain of the site keeps the visitor id in its own cookie', async () => {
    const env = edgeEnv(ns, new FakeQueue());
    const VID = '55555555-5555-4555-8555-555555555555';
    const ask = (query: string, headers: Record<string, string>) =>
      analyticsRoutes.fetch(
        new Request(`https://t.example.com/e?site=${SITE_ID}${query}`, { headers }),
        env,
      );
    const fresh = await ask(`&vid=${VID}`, { origin: 'https://www.example.com' });
    expect(fresh.headers.get('access-control-allow-origin')).toBe('https://www.example.com');
    expect(fresh.headers.get('access-control-allow-credentials')).toBe('true');
    expect(fresh.headers.get('cache-control')).toBe('private, no-store');
    expect(fresh.headers.get('set-cookie')).toMatch(
      new RegExp(`^amb_vid=${VID}; Domain=example.com; Path=/; Max-Age=\\d+; Secure; SameSite=Lax$`),
    );
    expect(await fresh.json()).toEqual({ cookieless: false });

    const lost = await ask('', { origin: 'https://www.example.com', cookie: `x=1; amb_vid=${VID}` });
    expect(await lost.json()).toEqual({ cookieless: false, vid: VID });

    // Foreign origins and shared endpoints never get a cookie.
    const foreign = await ask(`&vid=${VID}`, { origin: 'https://evil.test' });
    expect(foreign.headers.get('set-cookie')).toBeNull();
    expect(foreign.headers.get('access-control-allow-origin')).toBe('*');
    const shared = await analyticsRoutes.fetch(
      new Request(`https://edge.amable.net/e?site=${SITE_ID}&vid=${VID}`, {
        headers: { origin: 'https://www.example.com' },
      }),
      env,
    );
    expect(shared.headers.get('set-cookie')).toBeNull();
  });

  it('allows localhost only when the site opts in', async () => {
    siteDb().updateSite({ allow_localhost: true });
    const env = edgeEnv(ns);
    const res = await post(env, pageview({ url: 'http://localhost:3000/' }), {
      origin: 'http://localhost:3000',
    });
    expect(res.status).toBe(202);
  });
});

describe('POST /e/server (SDK)', () => {
  async function server(env: Env, body: unknown, token = secret): Promise<Response> {
    return analyticsRoutes.fetch(
      new Request('https://t.example.com/e/server', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'node',
        },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  it('authenticates with the site secret', async () => {
    const env = edgeEnv(ns);
    expect(
      (await server(env, { type: 'goal', visitor_id: 'visitor-0001', name: 'x' }, 'nope')).status,
    ).toBe(401);
    expect(
      (
        await server(
          env,
          { type: 'goal', visitor_id: 'visitor-0001', name: 'x' },
          newSiteSecret(SITE_ID),
        )
      ).status,
    ).toBe(401);
    expect(
      (await server(env, { type: 'goal', visitor_id: 'visitor-0001', name: 'x' })).status,
    ).toBe(202);
    expect((await server(env, { type: 'goal', name: 'missing_visitor' })).status).toBe(400);
  });

  it('makes server retries idempotent with event_id and back-dates with occurred_at', async () => {
    const env = edgeEnv(ns);
    await post(env, pageview());
    const vid = '11111111-2222-4333-8444-555555555555';
    const goal = {
      type: 'goal',
      visitor_id: vid,
      name: 'demo_booked',
      event_id: 'crm-123',
      occurred_at: new Date(T0 - 5 * 60_000).toISOString(),
    };
    expect((await server(env, goal)).status).toBe(202);
    expect((await server(env, goal)).status).toBe(202);
    const goals = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'goal', 5);
    expect(goals.ok && goals.value.rows).toEqual([
      { value: 'demo_booked', visitors: 1, completions: 1 },
    ]);
    expect((await server(env, { ...goal, occurred_at: 'yesterday' })).status).toBe(400);
  });

  it('records goals, identify and payments against the browser visitor', async () => {
    const env = edgeEnv(ns);
    await post(env, pageview());
    const vid = '11111111-2222-4333-8444-555555555555';
    await server(env, {
      type: 'identify',
      visitor_id: vid,
      user_id: 'u-42',
      email: 'Ann@Example.com',
    });
    await server(env, {
      type: 'goal',
      visitor_id: vid,
      name: 'trial_started',
      params: { plan: 'pro' },
    });
    await server(env, {
      type: 'payment',
      amount: 29.9,
      currency: 'eur',
      transaction_id: 'in_1',
      email: 'ann@example.com',
    });
    const ov = siteDb().overview({ from: '2026-10-15', to: '2026-10-15' });
    expect(ov).toMatchObject({ ok: true, value: { visitors: 1, goals: 2, revenue_minor: 2990 } });
  });

  it('verifies the reported crawler IP against the operator ranges', async () => {
    const queue = new FakeQueue();
    const env = edgeEnv(ns, queue);
    const report = (ip: string) =>
      server(env, {
        type: 'crawler',
        url: 'https://www.example.com/',
        user_agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        ip,
      }).then((res) => res.json() as Promise<{ bot: { name: string; verification: string } }>);
    expect((await report('66.249.66.1')).bot).toMatchObject({
      name: 'Googlebot',
      verification: 'verified',
    });
    expect((await report('203.0.113.9')).bot).toMatchObject({
      name: 'Googlebot',
      verification: 'spoofed',
    });
    const hit = queue.sent.at(-1);
    expect(hit?.kind === 'bot' && hit.hit.verification).toBe('spoofed');
  });

  it('classifies crawler hits reported by server middleware', async () => {
    const env = edgeEnv(ns);
    const res = await server(env, {
      type: 'crawler',
      url: 'https://www.example.com/docs',
      user_agent: 'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
      ip: '192.0.2.1',
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      bot: { name: 'PerplexityBot', category: 'ai_answers' },
    });
    const human = await server(env, {
      type: 'crawler',
      url: 'https://www.example.com/',
      user_agent: CHROME,
    });
    expect(await human.json()).toMatchObject({ ok: true, bot: null });
    const bots = siteDb().breakdown({ from: '2026-10-15', to: '2026-10-15' }, 'bot', 5);
    expect(bots.ok && bots.value.rows).toEqual([{ value: 'PerplexityBot', visitors: 0, hits: 1 }]);
  });
});

describe('tracker script', () => {
  it('serves the three variants with caching headers and ETag revalidation', async () => {
    const env = edgeEnv(ns);
    for (const [path, variant] of [
      ['/s.js', 'default'],
      ['/s.cookieless.js', 'cookieless'],
      ['/s.hash.js', 'hash'],
    ] as const) {
      const res = await analyticsRoutes.fetch(new Request(`https://t.example.com${path}`), env);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
      expect(res.headers.get('cache-control')).toContain('max-age=3600');
      expect(await res.text()).toBe(TRACKER_BUNDLES[variant]);
      const etag = res.headers.get('etag') ?? '';
      const again = await analyticsRoutes.fetch(
        new Request(`https://t.example.com${path}`, { headers: { 'if-none-match': etag } }),
        env,
      );
      expect(again.status).toBe(304);
    }
  });
});

type Db = { all: <T>(q: string, ...p: unknown[]) => T[] };
const rows = <T>(q: string): T[] => (siteDb() as unknown as { db: Db }).db.all<T>(q);

describe('neutral path, proxy recipes and ip_ua matching', () => {
  const send = (env: Env, url: string, body: unknown, headers: Record<string, string> = {}) => {
    const req = new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'user-agent': CHROME,
        'cf-connecting-ip': '203.0.113.7',
        origin: 'https://www.example.com',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    Object.defineProperty(req, 'cf', { value: { country: 'IT' } });
    return analyticsRoutes.fetch(req, env);
  };

  it('serves the script and takes events on /<dir>/<name>, any neutral path', async () => {
    const env = edgeEnv(ns);
    for (const [file, variant] of [
      ['app.js', 'default'],
      ['app-l.js', 'cookieless'],
      ['main-h.js', 'hash'],
    ] as const) {
      const res = await analyticsRoutes.fetch(
        new Request(`https://t.example.com/k3x9ab2q/${file}`),
        env,
      );
      expect(await res.text()).toBe(TRACKER_BUNDLES[variant]);
    }
    const mode = await analyticsRoutes.request(`/k3x9ab2q/app?site=${SITE_ID}`, {}, env);
    expect(await mode.json()).toEqual({ cookieless: false });
    const res = await send(env, 'https://t.example.com/zz99yy88/core', pageview());
    expect(res.status).toBe(202);
    expect(rows<{ collector: string }>(`SELECT collector FROM sessions`)).toEqual([
      { collector: 'first_party' },
    ]);
    const short = await analyticsRoutes.fetch(new Request('https://t.example.com/ab/app.js'), env);
    expect(short.status).toBe(404);
  });

  it('leaves landing page paths of the same shape to the routes after it', async () => {
    const env = edgeEnv(ns);
    const app = new Hono<{ Bindings: Env }>();
    app.route('/', analyticsRoutes);
    app.all('*', (c) => c.text(`page ${c.req.method} ${c.req.path}`));
    for (const [method, path] of [
      ['GET', '/offerta/estate'],
      ['GET', '/webinar2026/iscriviti'],
      ['GET', '/offerta/estate.js'],
      ['POST', '/contatti/invia'],
      ['OPTIONS', '/offerta/estate'],
    ] as const) {
      const res = await app.request(path, { method, body: method === 'POST' ? '{}' : undefined }, env);
      expect(await res.text()).toBe(`page ${method} ${path}`);
    }
    const mode = await app.request(`/k3x9ab2q/app?site=${SITE_ID}`, {}, env);
    expect(await mode.json()).toEqual({ cookieless: false });
  });

  it('trusts the proxy headers only with the site proxy key', async () => {
    const env = { ...edgeEnv(ns), EDGE_GATEWAY_SECRET: 'gateway-secret-for-tests' };
    const key = (await proxyKeyFor(env.EDGE_GATEWAY_SECRET, SITE_ID)) as string;
    const forwarded = {
      'x-amb-forwarded-for': '198.51.100.9',
      'x-amb-forwarded-host': 'www.example.com',
      'x-amb-geo-country': 'FR',
      'x-amb-geo-city': encodeURIComponent('Saint-Étienne'),
    };
    await send(env, 'https://edge.amable.net/e', pageview());
    // Forged headers without the key: ignored (request IP, request host, cf geo).
    await send(
      env,
      'https://edge.amable.net/k3x9ab2q/app',
      pageview({
        vid: '55555555-5555-4555-8555-555555555555',
        sid: 's5555555555555555555555555555555a',
      }),
      { ...forwarded, 'x-amb-proxy-key': 'forged-key-forged-key-forged-key' },
    );
    await send(
      env,
      'https://edge.amable.net/k3x9ab2q/app',
      pageview({
        vid: '22222222-2222-4222-8222-222222222222',
        sid: 's1111111111111111111111111111111a',
      }),
      { ...forwarded, 'x-amb-proxy-key': key },
    );
    expect(
      rows<{ collector: string; country: string; city: string | null }>(
        `SELECT collector, country, city FROM sessions ORDER BY collector, country`,
      ),
    ).toEqual([
      { collector: 'proxy', country: 'FR', city: 'Saint-Étienne' },
      { collector: 'third_party', country: 'IT', city: null },
      { collector: 'third_party', country: 'IT', city: null },
    ]);
    const coverage = siteDb().trackingCoverage({ from: '2026-10-15', to: '2026-10-15' });
    expect(
      coverage.ok && coverage.value.rows.map((r) => [r.browser, r.collector, r.sessions]),
    ).toEqual([
      ['Chrome', 'third_party', 2],
      ['Chrome', 'proxy', 1],
    ]);
    // Behind the proxy the cookie goes on the site's root domain, like the tracker's.
    const mode = (headers: Record<string, string>) =>
      analyticsRoutes.fetch(
        new Request(
          `https://edge.amable.net/k3x9ab2q/app?site=${SITE_ID}&vid=22222222-2222-4222-8222-222222222222`,
          {
            headers: {
              origin: 'https://www.example.com',
              'x-amb-forwarded-host': 'www.example.com',
              ...headers,
            },
          },
        ),
        env,
      );
    expect((await mode({ 'x-amb-proxy-key': key })).headers.get('set-cookie')).toMatch(
      /Domain=example\.com;/,
    );
    expect((await mode({})).headers.get('set-cookie')).toBeNull();
  });

  it('never verifies a crawler on a forged forwarded IP', async () => {
    const queue = new FakeQueue();
    const env = edgeEnv(ns, queue);
    await send(env, 'https://t.example.com/e', pageview(), {
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'x-amb-forwarded-for': '66.249.66.1',
    });
    const hit = queue.sent.at(-1);
    expect(hit?.kind === 'bot' && hit.hit.verification).toBe('spoofed');
  });

  it('merges a new visitor with the only same-day IP + UA match when ip_ua is on', async () => {
    const env = edgeEnv(ns);
    const A = '33333333-3333-4333-8333-333333333333';
    const B = '44444444-4444-4444-8444-444444444444';
    const C = '66666666-6666-4666-8666-666666666666';
    const D = '77777777-7777-4777-8777-777777777777';
    const view = (vid: string, sid: string) => pageview({ vid, sid, fs: T0, sn: 1 });
    await send(env, 'https://t.example.com/e', view(A, 's3333333333333333333333333333333a'));
    await send(env, 'https://t.example.com/e', view(B, 's4444444444444444444444444444444a'));
    expect(rows(`SELECT * FROM visitor_merges`)).toEqual([]);

    siteDb().updateIdentitySettings({ ip_ua: true });
    await send(env, 'https://t.example.com/e', view(C, 's6666666666666666666666666666666a'), {
      'cf-connecting-ip': '198.51.100.20',
    });
    await send(env, 'https://t.example.com/e', view(D, 's7777777777777777777777777777777a'), {
      'cf-connecting-ip': '198.51.100.20',
    });
    // A and B share 203.0.113.7: a shared network, never merged; C → D is the only match.
    expect(
      rows<{ child_visitor_id: string; origin_visitor_id: string; mechanism: string }>(
        `SELECT child_visitor_id, origin_visitor_id, mechanism FROM visitor_merges`,
      ),
    ).toEqual([{ child_visitor_id: D, origin_visitor_id: C, mechanism: 'ip_ua' }]);
  });
});
