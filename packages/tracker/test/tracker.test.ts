import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot, createTracker } from '../src/tracker';
import { goalOf, sanitizeName, sanitizeParams, sanitizeValue } from '../src/sanitize';
import { decorateLink, readHandoff, stripHandoff } from '../src/identity';
import { isLikelyBot } from '../src/env-checks';
import { buildBundles, renderModule } from '../scripts/build.mjs';
import { CookieJar, cookieMap, openPage } from './helpers';

const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('cookies and identity', () => {
  it('creates visitor, session, first-seen and session-count cookies on the root domain', () => {
    const page = openPage();
    const c = cookieMap(page.win);
    expect(c['amb_vid']).toMatch(/^[0-9a-f-]{36}$/);
    expect(c['amb_sid']).toMatch(/^s[0-9a-f]{32}$/);
    expect(c['amb_fs']).toBe(String(T0));
    expect(c['amb_sn']).toBe('1');
    const pv = page.sent[0];
    expect(pv).toMatchObject({
      type: 'pageview',
      site: 'site_test',
      vid: c['amb_vid'],
      sid: c['amb_sid'],
      sn: 1,
      fs: T0,
    });
    // Cookie set for example.com is visible from another subdomain.
    const jar = page.dom.cookieJar;
    expect(jar.getCookieStringSync('https://shop.example.com/')).toContain('amb_vid=');
  });

  it('keeps ids across page loads and slides the session', () => {
    const jar = new CookieJar();
    const first = openPage({ jar });
    vi.setSystemTime(T0 + 20 * 60_000);
    const second = openPage({ jar, url: 'https://www.example.com/docs' });
    vi.setSystemTime(T0 + 45 * 60_000); // 25 min after the last event: still alive
    const third = openPage({ jar, url: 'https://www.example.com/blog' });
    expect(second.sent[0]?.vid).toBe(first.sent[0]?.vid);
    expect(second.sent[0]?.sid).toBe(first.sent[0]?.sid);
    expect(third.sent[0]?.sid).toBe(first.sent[0]?.sid);
    expect(third.sent[0]?.sn).toBe(1);
  });

  it('rolls over to a new session after 30 minutes of inactivity', () => {
    const jar = new CookieJar();
    const first = openPage({ jar });
    vi.setSystemTime(T0 + 31 * 60_000);
    const second = openPage({ jar, url: 'https://www.example.com/again' });
    expect(second.sent[0]?.vid).toBe(first.sent[0]?.vid);
    expect(second.sent[0]?.sid).not.toBe(first.sent[0]?.sid);
    expect(second.sent[0]?.sn).toBe(2);
    expect(second.sent[0]?.fs).toBe(T0);
  });

  it('cookieless build sets no cookies and flags the payload', () => {
    const page = openPage({ options: { cookieless: true } });
    expect(page.win.document.cookie).toBe('');
    expect(page.sent[0]).toMatchObject({ type: 'pageview', cl: 1 });
    expect(page.sent[0]?.vid).toBeUndefined();
  });

  it('honours data-domain for the cookie domain', () => {
    const page = openPage({ attrs: { 'data-domain': 'www.example.com' } });
    expect(page.dom.cookieJar.getCookieStringSync('https://shop.example.com/')).not.toContain(
      'amb_vid=',
    );
  });
});

describe('payload', () => {
  it('captures url, referrer, sizes, language, timezone, click ids and source params', () => {
    const page = openPage({
      url: 'https://www.example.com/p?utm_source=nl&utm_medium=email&utm_campaign=oct&ref=hn&via=ann&fbclid=F&li_fat_id=L#top',
    });
    const pv = page.sent[0];
    expect(pv?.url).toBe(
      'https://www.example.com/p?utm_source=nl&utm_medium=email&utm_campaign=oct&ref=hn&via=ann&fbclid=F&li_fat_id=L',
    );
    expect(pv?.ref).toBe('https://www.google.com/');
    expect(pv?.clk).toEqual({ fbclid: 'F', li_fat_id: 'L' });
    expect(pv?.src).toEqual({
      utm_source: 'nl',
      utm_medium: 'email',
      utm_campaign: 'oct',
      ref: 'hn',
      via: 'ann',
    });
    expect(typeof pv?.vw).toBe('number');
    expect(typeof pv?.sw).toBe('number');
    expect(pv?.tz).toBeTypeOf('string');
    expect(pv?.lang).toBe('en-US');
    expect(page.endpoints[0]).toBe('https://t.example.com/e');
  });

  it('uses data-api as endpoint when present', () => {
    const page = openPage({ attrs: { 'data-api': 'https://collect.example.com/e' } });
    expect(page.endpoints[0]).toBe('https://collect.example.com/e');
  });

  it('hash-routing build keeps the hash and reads params after #…?', () => {
    const page = openPage({
      url: 'https://app.example.com/#/start?utm_source=x',
      options: { hashRouting: true },
    });
    expect(page.sent[0]?.url).toBe('https://app.example.com/#/start?utm_source=x');
    expect(page.sent[0]?.src).toEqual({ utm_source: 'x' });
    page.win.location.hash = '#/next';
    page.win.dispatchEvent(new page.dom.window.HashChangeEvent('hashchange'));
    expect(page.sent.at(-1)?.url).toBe('https://app.example.com/#/next');
  });

  it('sends with fetch (acked) while the page is visible, without keepalive', () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const page = openPage();
    const win = page.win as unknown as {
      fetch: (url: string, init: RequestInit) => Promise<unknown>;
      navigator: { sendBeacon?: () => boolean };
    };
    win.fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({});
    };
    Object.defineProperty(win.navigator, 'sendBeacon', { value: () => false, configurable: true });
    createTracker(page.win, { cookieless: false, hashRouting: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({ method: 'POST', keepalive: false, credentials: 'omit' });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ type: 'pageview' });
  });
});

describe('SPA navigation', () => {
  it('tracks pushState and popstate with 60s same-URL dedupe', () => {
    const page = openPage({ url: 'https://www.example.com/' });
    expect(page.sent).toHaveLength(1);
    page.win.history.pushState({}, '', '/a');
    page.win.history.pushState({}, '', '/a'); // same URL right away: dropped
    expect(page.sent.map((e) => new URL(e.url).pathname)).toEqual(['/', '/a']);
    vi.setSystemTime(T0 + 61_000);
    page.win.history.pushState({}, '', '/a'); // same URL after 60s: tracked
    page.win.history.pushState({}, '', '/b');
    page.win.dispatchEvent(new page.dom.window.PopStateEvent('popstate'));
    expect(page.sent.map((e) => new URL(e.url).pathname)).toEqual(['/', '/a', '/a', '/b']);
    page.win.history.replaceState({}, '', '/c');
    page.win.dispatchEvent(new page.dom.window.PopStateEvent('popstate'));
    expect(page.sent.at(-1)?.url).toBe('https://www.example.com/c');
  });
});

describe('goals', () => {
  it('sanitizes names, values and params (max 10, 255 chars)', () => {
    expect(sanitizeName('  Sign Up-Now!! ')).toBe('sign_up_now');
    expect(sanitizeName('<>')).toBe('');
    expect(sanitizeValue(`  a<b>\u0007${'x'.repeat(300)}`)).toHaveLength(255);
    expect(sanitizeValue(' <script>ok ')).toBe('scriptok');
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeParams(many) ?? {})).toHaveLength(10);
    expect(sanitizeParams({ 'Plan Name': 'Pro', nested: { a: 1 }, empty: null })).toEqual({
      plan_name: 'Pro',
    });
    expect(sanitizeParams('x')).toBeUndefined();
  });

  it('parses data-amable-goal and data-amable-goal-* attributes', () => {
    const page = openPage({
      body: '<button id="b" data-amable-goal="Start Trial" data-amable-goal-plan="pro" data-amable-goal-seat-count="3"><span id="s">go</span></button>',
    });
    const el = page.win.document.getElementById('b');
    if (el === null) throw new Error('missing');
    expect(goalOf(el)).toEqual({ name: 'start_trial', params: { plan: 'pro', seat_count: '3' } });
    page.win.document.getElementById('s')?.click();
    expect(page.sent.at(-1)).toMatchObject({
      type: 'goal',
      name: 'start_trial',
      data: { plan: 'pro', seat_count: '3' },
    });
  });

  it('amable() commands and the pre-load queue', () => {
    const page = openPage({
      before: (win) => {
        (win as unknown as { amable: { q: unknown[][] } }).amable = {
          q: [
            ['goal', 'queued_goal', { a: 'b' }],
            ['identify', { user_id: 'u1', email: 'a@b.co' }],
          ],
        };
      },
    });
    expect(page.sent.map((e) => e.type)).toEqual(['pageview', 'goal', 'identify']);
    expect(page.sent[1]).toMatchObject({ name: 'queued_goal', data: { a: 'b' } });
    page.handle.command('payment', { amount: 19.99, currency: 'EUR', transaction_id: 'tx1' });
    expect(page.sent.at(-1)).toMatchObject({
      type: 'payment',
      data: { amount: '19.99', currency: 'EUR' },
    });
    page.handle.command('goal', '!!!');
    expect(page.sent.at(-1)?.type).toBe('payment');
  });

  it('scroll goals fire once after threshold + delay', () => {
    type Cb = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;
    const observers: Array<{ cb: Cb; threshold: number; disconnected: boolean }> = [];
    class FakeIO {
      private readonly rec: { cb: Cb; threshold: number; disconnected: boolean };
      constructor(cb: Cb, init: { threshold: number }) {
        this.rec = { cb, threshold: init.threshold, disconnected: false };
        observers.push(this.rec);
      }
      observe(): void {}
      disconnect(): void {
        this.rec.disconnected = true;
      }
    }
    const page = openPage({
      body: '<section data-amable-scroll="Pricing Seen" data-amable-scroll-threshold="0.75" data-amable-scroll-delay="500" data-amable-goal-section="pricing"></section>',
      before: (win) => {
        (win as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
      },
    });
    const io = observers[0];
    if (io === undefined) throw new Error('no observer');
    expect(io.threshold).toBe(0.75);
    io.cb([{ isIntersecting: true, intersectionRatio: 0.8 }]);
    vi.advanceTimersByTime(200);
    io.cb([{ isIntersecting: false, intersectionRatio: 0 }]); // left before the delay
    vi.advanceTimersByTime(1000);
    expect(page.sent.filter((e) => e.type === 'goal')).toHaveLength(0);
    io.cb([{ isIntersecting: true, intersectionRatio: 0.9 }]);
    vi.advanceTimersByTime(500);
    expect(page.sent.filter((e) => e.type === 'goal')).toEqual([
      expect.objectContaining({ name: 'pricing_seen', data: { section: 'pricing' } }),
    ]);
    expect(io.disconnected).toBe(true);
  });
});

describe('links', () => {
  it('tracks external links and leaves internal ones alone', () => {
    const page = openPage({
      body: '<a id="ext" href="https://other.org/x">x</a><a id="int" href="/local">y</a>',
    });
    const prevent = (e: Event): void => e.preventDefault();
    page.win.document.addEventListener('click', prevent);
    page.win.document.getElementById('int')?.click();
    page.win.document.getElementById('ext')?.click();
    expect(page.sent.filter((e) => e.type === 'external_link')).toEqual([
      expect.objectContaining({ data: { url: 'https://other.org/x' } }),
    ]);
  });

  it('decorates cross-domain links and the target page adopts then strips the params', () => {
    const page = openPage({
      attrs: { 'data-cross-domain': 'shop.other.com' },
      body: '<a id="x" href="https://shop.other.com/cart?item=1">cart</a>',
    });
    page.win.document.addEventListener('click', (e) => e.preventDefault());
    const a = page.win.document.getElementById('x') as HTMLAnchorElement;
    a.click();
    const url = new URL(a.href);
    const ids = cookieMap(page.win);
    expect(url.searchParams.get('_amb_vid')).toBe(ids['amb_vid']);
    expect(url.searchParams.get('_amb_sid')).toBe(ids['amb_sid']);
    expect(page.sent.some((e) => e.type === 'external_link')).toBe(false);

    vi.setSystemTime(T0 + 5_000);
    const target = openPage({
      url: url.toString(),
      attrs: { 'data-cross-domain': 'www.example.com' },
    });
    expect(target.win.location.href).toBe('https://shop.other.com/cart?item=1');
    expect(target.sent[0]).toMatchObject({
      vid: ids['amb_vid'],
      sid: ids['amb_sid'],
      url: 'https://shop.other.com/cart?item=1',
    });
  });

  it('sends the email-click contact token once and strips it with the handoff params', () => {
    const ids = {
      vid: '11111111-2222-4333-8444-555555555555',
      sid: 'sabcdef0123456789',
      fs: T0,
      sn: 2,
    };
    const href = new URL(decorateLink('https://www.example.com/pricing?a=1', ids, T0));
    href.searchParams.set('_amb_c', 'eyJ0IjoiZGVtbyJ9.c2ln');
    const page = openPage({ url: href.toString() });
    expect(page.win.location.href).toBe('https://www.example.com/pricing?a=1');
    expect(page.sent[0]).toMatchObject({
      type: 'pageview',
      vid: ids.vid,
      ct: 'eyJ0IjoiZGVtbyJ9.c2ln',
    });
    page.win.history.pushState({}, '', '/signup');
    expect(page.sent.at(-1)?.url).toBe('https://www.example.com/signup');
    expect(page.sent.slice(1).every((e) => e.ct === undefined)).toBe(true);

    const malformed = openPage({ url: 'https://www.example.com/?_amb_c=%3Cscript%3E' });
    expect(malformed.win.location.href).toBe('https://www.example.com/');
    expect(malformed.sent[0]?.ct).toBeUndefined();
  });

  it('ignores stale handoff params but still strips them', () => {
    const ids = {
      vid: '11111111-2222-4333-8444-555555555555',
      sid: 'sabcdef0123456789',
      fs: T0,
      sn: 3,
    };
    const href = decorateLink('https://www.example.com/?a=1', ids, T0 - 11 * 60_000);
    expect(readHandoff(new URL(href), T0)).toBeUndefined();
    expect(readHandoff(new URL(href), T0 - 10 * 60_000)).toEqual(ids);
    expect(stripHandoff(new URL(href))).toBe('https://www.example.com/?a=1');
    const page = openPage({ url: href });
    expect(page.win.location.href).toBe('https://www.example.com/?a=1');
    expect(page.sent[0]?.vid).not.toBe(ids.vid);
  });
});

describe('exclusions', () => {
  it('detects bots on the client', () => {
    const page = openPage();
    expect(isLikelyBot(page.win)).toBe(false);
    const bot = openPage({
      before: (win) =>
        Object.defineProperty(win.navigator, 'webdriver', { value: true, configurable: true }),
    });
    expect(bot.handle).toMatchObject({ enabled: false, reason: 'bot' });
    expect(bot.sent).toHaveLength(0);
    const headless = openPage({
      before: (win) =>
        Object.defineProperty(win.navigator, 'userAgent', {
          value: 'Mozilla/5.0 HeadlessChrome/120.0',
          configurable: true,
        }),
    });
    expect(headless.handle.reason).toBe('bot');
  });

  it('skips localhost and iframes unless opted in', () => {
    expect(openPage({ url: 'http://localhost:5173/' }).handle.reason).toBe('localhost');
    expect(
      openPage({ url: 'http://localhost:5173/', attrs: { 'data-allow-localhost': '' } }).handle
        .enabled,
    ).toBe(true);
    const iframe = (win: Window): void => {
      Object.defineProperty(win, 'self', { value: {}, configurable: true });
    };
    expect(openPage({ before: iframe }).handle.reason).toBe('iframe');
    expect(openPage({ before: iframe, attrs: { 'data-allow-iframe': '' } }).handle.enabled).toBe(
      true,
    );
  });

  it('opt-out stops the page at once and forgets the ids', () => {
    const page = openPage();
    const before = page.sent.length;
    expect(page.win.document.cookie).toContain('amb_vid=');
    page.handle.command('optout');
    page.win.history.pushState({}, '', '/after');
    page.win.dispatchEvent(
      new (page.win as unknown as typeof globalThis).PopStateEvent('popstate'),
    );
    page.handle.command('goal', 'signup');
    page.win.document.body.click();
    expect(page.sent.length).toBe(before);
    expect(page.win.document.cookie).not.toContain('amb_vid=');
  });

  it('opt-out strips the ids from links the tracker decorated', () => {
    const page = openPage({
      url: 'https://www.example.com/lander?f=fun1&n=nd3',
      body: '<a id="act" href="https://trk.example.com/a/1?x=1">go</a><a id="mine" href="/p?vid=keep">x</a>',
    });
    const act = page.win.document.getElementById('act') as HTMLAnchorElement;
    expect(act.href).toContain('vid=');
    page.handle.command('optout');
    expect(act.href).toBe('https://trk.example.com/a/1?x=1');
    expect((page.win.document.getElementById('mine') as HTMLAnchorElement).href).toContain(
      'vid=keep',
    );
  });

  it('opt-out via localStorage and commands', () => {
    const page = openPage();
    page.handle.command('optout');
    expect(page.win.localStorage.getItem('amable_ignore')).toBe('true');
    const optedOut = openPage({
      before: (win) => win.localStorage.setItem('amable_ignore', 'true'),
    });
    expect(optedOut.handle.reason).toBe('opted_out');
    optedOut.handle.command('optin');
    expect(optedOut.win.localStorage.getItem('amable_ignore')).toBeNull();
  });

  it('requires data-site', () => {
    expect(openPage({ attrs: { 'data-site': '' } }).handle.reason).toBe('no_site');
  });

  it('survives a tag manager that drops data-site (GTM): queued site, endpoint from src', () => {
    // GTM recreates the script element keeping only src. The snippet also
    // queues amable('site', id), and the executing script still names our origin.
    const page = openPage({
      attrs: { 'data-site': undefined, src: 'https://t.example.com/c5dqsd1f/main.js' },
      before: (win) => {
        const el = win.document.querySelector('script');
        Object.defineProperty(win.document, 'currentScript', { value: el, configurable: true });
        (win as unknown as { amable: { q: unknown[][] } }).amable = {
          q: [['site', 'st_from_queue']],
        };
      },
    });
    expect(page.handle.enabled).toBe(true);
    expect(page.sent[0]).toMatchObject({ type: 'pageview', site: 'st_from_queue' });
    // The events go to the script's own origin, never to the page's /e.
    expect(page.endpoints[0]).toBe('https://t.example.com/c5dqsd1f/main');
    // An explicit data-site always wins over the queued one.
    const both = openPage({
      before: (win) => {
        (win as unknown as { amable: { q: unknown[][] } }).amable = { q: [['site', 'st_other']] };
      },
    });
    expect(both.sent[0]).toMatchObject({ site: 'site_test' });
  });
});

describe('bundles', () => {
  it('generated/bundles.ts is up to date and each variant stays under its gzip budget', async () => {
    vi.useRealTimers();
    const bundles = await buildBundles();
    const onDisk = readFileSync(join(import.meta.dirname, '../generated/bundles.ts'), 'utf8');
    expect(onDisk, 'run `pnpm --filter @amable/tracker build`').toBe(renderModule(bundles));
    for (const code of Object.values(bundles)) {
      // 6 KB, plus the acked transport with its offline buffer, plus the extended form
      // capture (twelve kinds in six languages, form_submit, payload, hidden fields) 2 KB,
      // the layered identity (server cookie, storage mirror, platform cookies, URL aliases) 1 KB,
      // embeds (shadow DOM, iframes, parent handshake, provider messages) 1 KB.
      expect(gzipSync(code).length).toBeLessThan(10 * 1024 + 256);
      // v1 was 8588 bytes minified; v2 (forms, link params, action links) may add at most 4 KB,
      // the site mode lookup of the cookie builds 1 KB more, the acked transport with its
      // offline buffer 1 KB more, the immediate opt-out teardown 512 bytes more, the
      // extended form capture 5 KB more, the layered identity 2 KB more, embeds 3.5 KB more.
      expect(code.length).toBeLessThanOrEqual(8588 + 4096 + 1024 + 1024 + 512 + 5120 + 2048 + 3584);
    }
  });
});

describe('boot', () => {
  it('installs window.amable and the short amb alias without clobbering an existing amb', () => {
    const page = openPage();
    const win = page.win as unknown as Record<string, unknown>;
    boot(page.win, { cookieless: true, hashRouting: false });
    expect(typeof win['amable']).toBe('function');
    expect(win['amb']).toBe(win['amable']);
    const other = openPage();
    const own = (): void => undefined;
    (other.win as unknown as Record<string, unknown>)['amb'] = own;
    boot(other.win, { cookieless: true, hashRouting: false });
    expect((other.win as unknown as Record<string, unknown>)['amb']).toBe(own);
  });
});
