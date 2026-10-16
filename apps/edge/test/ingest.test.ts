import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKER_BUNDLES } from '@amable/tracker/bundles';
import { sha256Hex } from '../src/analytics/cookieless';
import {
  clearSiteConfigCache,
  consumeAnalyticsBatch,
  localCounters,
} from '../src/analytics/pipeline';
import { analyticsRoutes } from '../src/analytics/routes';
import { newSiteSecret } from '../src/analytics/rpc';
import type { AnalyticsMessage } from '../src/analytics/types';
import type { Env } from '../src/env';
import { edgeEnv, FakeAnalyticsNamespace, FakeQueue, SITE_ID, siteInit, T0 } from './helpers';

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
    expect((await report('66.249.66.1')).bot).toMatchObject({ name: 'Googlebot', verification: 'verified' });
    expect((await report('203.0.113.9')).bot).toMatchObject({ name: 'Googlebot', verification: 'spoofed' });
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
