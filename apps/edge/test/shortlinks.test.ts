import type { ShortlinkTarget } from '@amable/api-types';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  clearShortlinkCaches,
  clickFacts,
  composeDestination,
  handleShortlinkRequest,
  ogPreviewHtml,
  resolveShortlinkHost,
} from '../src/shortlinks/redirect';
import { T0 } from './helpers';

const TENANT = { id: 't_1', slug: 'acme', name: 'Acme' };
const HOST = { tenantSlug: 'acme', domainId: 'dom_go' };

function target(overrides: Partial<ShortlinkTarget> = {}): ShortlinkTarget {
  return {
    id: 'sl_1',
    url: 'https://shop.example/sale?ref=x',
    utm: { utm_source: 'news' },
    passQuery: false,
    expiresAt: null,
    expiredUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    ...overrides,
  };
}

/** Fake core gateway answering the shortlink ops from in-memory maps. */
function fakeCore(hosts: Record<string, string>, links: Record<string, ShortlinkTarget>) {
  const seen: Array<{ op: string; input: unknown }> = [];
  let down = false;
  const env = {
    ENVIRONMENT: 'dev',
    CORE: {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (down) throw new Error('Network connection lost');
        const envelope = JSON.parse(String(init?.body)) as {
          op: string;
          tenant: { host?: string };
          input: { key?: string };
        };
        seen.push({ op: envelope.op, input: envelope.input });
        let value: unknown;
        if (envelope.op === 'shortlinks.host') {
          const domainId = hosts[envelope.tenant.host ?? ''];
          if (domainId === undefined) {
            return new Response(
              JSON.stringify({ ok: false, error: { code: 'not_found', status: 404, message: 'nope' } }),
              { status: 404 },
            );
          }
          value = { domainId };
        } else if (envelope.op === 'shortlinks.resolve_link') {
          value = links[envelope.input.key ?? ''] ?? null;
        } else {
          value = { ok: true };
        }
        return new Response(JSON.stringify({ ok: true, tenant: TENANT, value }));
      },
    } as unknown as Fetcher,
  } as unknown as Env;
  return { env, seen, setDown: (value: boolean) => (down = value) };
}

function request(url: string, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36') {
  return new Request(url, { headers: { 'user-agent': ua } });
}

beforeEach(() => clearShortlinkCaches());

describe('composeDestination', () => {
  it('adds the saved UTM and, with pass_query, the visit query which wins', () => {
    const incoming = new URL('https://go.acme.test/k?utm_source=ig&x=1');
    expect(composeDestination(target(), incoming)).toBe('https://shop.example/sale?ref=x&utm_source=news');
    expect(composeDestination(target({ passQuery: true }), incoming)).toBe(
      'https://shop.example/sale?ref=x&utm_source=ig&x=1',
    );
    expect(composeDestination(target({ url: 'not a url' }), incoming)).toBe('not a url');
  });
});

describe('ogPreviewHtml', () => {
  it('escapes the custom og fields and skips the empty ones', () => {
    const html = ogPreviewHtml(target({ ogTitle: '"Spring" <b>', ogDescription: null }), 'https://shop.example/?a=1&b=2');
    expect(html).toContain('<meta property="og:title" content="&quot;Spring&quot; &lt;b&gt;">');
    expect(html).toContain('<meta property="og:url" content="https://shop.example/?a=1&amp;b=2">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain('og:description');
    expect(html).not.toContain('og:image');
  });
});

describe('clickFacts', () => {
  it('collects country, referrer host, device and the bot flag', () => {
    const req = new Request('https://go.acme.test/k', {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Mobile/15E148', referer: 'https://L.Instagram.com/x' },
    });
    Object.defineProperty(req, 'cf', { value: { country: 'IT' } });
    expect(clickFacts(req, 'sl_1')).toMatchObject({
      linkId: 'sl_1',
      country: 'IT',
      referrerHost: 'l.instagram.com',
      device: 'mobile',
      os: 'iOS',
      bot: false,
    });
    expect(clickFacts(request('https://go.acme.test/k', 'curl/8.0'), 'sl_1').bot).toBe(true);
    const verified = request('https://go.acme.test/k');
    Object.defineProperty(verified, 'cf', { value: { verifiedBotCategory: 'Search Engine Crawler' } });
    expect(clickFacts(verified, 'sl_1').bot).toBe(true);
  });
});

describe('resolveShortlinkHost', () => {
  it('caches hits and misses for 60s, never outages', async () => {
    const core = fakeCore({ 'go.acme.test': 'dom_go' }, {});
    expect(await resolveShortlinkHost(core.env, 'Go.Acme.test:443', T0)).toEqual(HOST);
    expect(await resolveShortlinkHost(core.env, 'www.acme.test', T0)).toBeNull();
    await resolveShortlinkHost(core.env, 'go.acme.test', T0 + 59_000);
    await resolveShortlinkHost(core.env, 'www.acme.test', T0 + 59_000);
    expect(core.seen).toHaveLength(2);
    await resolveShortlinkHost(core.env, 'go.acme.test', T0 + 61_000);
    expect(core.seen).toHaveLength(3);
    core.setDown(true);
    expect(await resolveShortlinkHost(core.env, 'other.acme.test', T0)).toBeNull();
    core.setDown(false);
    expect(await resolveShortlinkHost(core.env, 'other.acme.test', T0)).toBeNull();
    expect(core.seen.filter((s) => s.op === 'shortlinks.host')).toHaveLength(4);
    expect(await resolveShortlinkHost(core.env, 'x.workers.dev', T0)).toBeNull();
    expect(core.seen).toHaveLength(4);
  });
});

describe('handleShortlinkRequest', () => {
  it('redirects, counts the click and caches the link config for 60s', async () => {
    const core = fakeCore({}, { promo: target() });
    const waits: Promise<unknown>[] = [];
    const res = await handleShortlinkRequest(request('https://go.acme.test/promo/'), core.env, HOST, (p) => waits.push(p), T0);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://shop.example/sale?ref=x&utm_source=news');
    await Promise.all(waits);
    expect(core.seen.map((s) => s.op)).toEqual(['shortlinks.resolve_link', 'shortlinks.click']);
    await handleShortlinkRequest(request('https://go.acme.test/promo'), core.env, HOST, (p) => waits.push(p), T0 + 30_000);
    await Promise.all(waits);
    expect(core.seen.filter((s) => s.op === 'shortlinks.resolve_link')).toHaveLength(1);
  });

  it('handles expiry, og crawlers and invalid paths', async () => {
    const core = fakeCore(
      {},
      {
        over: target({ expiresAt: T0 - 1, expiredUrl: 'https://shop.example/ended' }),
        gone: target({ expiresAt: T0 }),
        later: target({ expiresAt: T0 + 1 }),
        og: target({ ogTitle: 'Hi' }),
      },
    );
    const waits: Promise<unknown>[] = [];
    const go = (path: string, ua?: string) =>
      handleShortlinkRequest(request(`https://go.acme.test${path}`, ua), core.env, HOST, (p) => waits.push(p), T0);
    const over = await go('/over');
    expect([over.status, over.headers.get('location')]).toEqual([302, 'https://shop.example/ended']);
    expect((await go('/gone')).status).toBe(404);
    expect(waits).toHaveLength(0);
    expect((await go('/later')).status).toBe(302);
    const preview = await go('/og', 'WhatsApp/2.23');
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain('og:title');
    expect((await go('/og')).status).toBe(302);
    for (const path of ['/', '/a/b', '/missing', `/${'x'.repeat(65)}`]) expect((await go(path)).status, path).toBe(404);
  });
});
