import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import type { EventPayload } from '../src/protocol';
import { boot, deviceScriptUrl } from '../src/tracker';
import { cookieMap } from './helpers';

function page(
  answer: () => Promise<Response>,
  cookies: string[] = [],
  src = 'https://t.example.com/s.js',
) {
  const dom = new JSDOM(
    `<!doctype html><html><head><script data-site="site_test" src="${src}"></script></head><body></body></html>`,
    { url: 'https://www.example.com/pricing', pretendToBeVisual: true },
  );
  const win = dom.window as unknown as Window;
  for (const c of cookies) win.document.cookie = c;
  const lookups: string[] = [];
  const credentials: Array<string | undefined> = [];
  Object.assign(win, {
    fetch: (url: string, init?: RequestInit) => {
      lookups.push(url);
      credentials.push(init?.credentials);
      return answer();
    },
  });
  const sent: EventPayload[] = [];
  const transport = (_endpoint: string, body: string) => {
    sent.push(JSON.parse(body) as EventPayload);
  };
  return { win, lookups, credentials, sent, transport };
}

const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body)));

describe('standard build on a cookieless site', () => {
  it('asks the edge for the site mode and writes no cookies when cookieless', async () => {
    const p = page(json({ cookieless: true }), [
      'amb_vid=11111111-1111-4111-8111-111111111111; path=/; domain=example.com',
    ]);
    const ready = boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    (p.win as unknown as { amable: (...a: unknown[]) => void }).amable('goal', 'signup');
    await ready;
    expect(p.lookups).toEqual([
      'https://t.example.com/e?site=site_test&vid=11111111-1111-4111-8111-111111111111',
    ]);
    expect(Object.keys(cookieMap(p.win)).filter((k) => k.startsWith('amb_'))).toEqual([]);
    expect(p.sent.map((e) => [e.type, e.cl, e.vid])).toEqual([
      ['pageview', 1, undefined],
      ['goal', 1, undefined],
    ]);
  });

  it('keeps cookies when the site uses them or the edge cannot tell', async () => {
    for (const answer of [
      json({ cookieless: false }),
      () => Promise.resolve(new Response('', { status: 404 })),
      () => Promise.reject(new Error('offline')),
    ]) {
      const p = page(answer);
      await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
      expect(cookieMap(p.win).amb_vid).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.sent[0]?.cl).toBeUndefined();
    }
  });

  it('the cookieless build never asks', async () => {
    const p = page(json({ cookieless: false }));
    await boot(p.win, { cookieless: true, hashRouting: false }, p.transport);
    expect(p.lookups).toEqual([]);
    expect(p.sent[0]?.cl).toBe(1);
  });
});

describe('server-set visitor cookie on the tracking domain', () => {
  const VID = '22222222-2222-4222-8222-222222222222';

  it('a same-site tracking domain is asked with credentials and restores a lost id', async () => {
    const p = page(json({ cookieless: false, vid: VID }));
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    expect(p.credentials).toEqual(['include']);
    expect(p.lookups).toEqual(['https://t.example.com/e?site=site_test']);
    expect(cookieMap(p.win).amb_vid).toBe(VID);
    expect(p.sent[0]?.vid).toBe(VID);
  });

  it('the script cookie wins over the server one', async () => {
    const own = '33333333-3333-4333-8333-333333333333';
    const p = page(json({ cookieless: false, vid: VID }), [
      `amb_vid=${own}; path=/; domain=example.com`,
    ]);
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    expect(p.sent[0]?.vid).toBe(own);
  });

  it('another site domain is asked without credentials nor id', async () => {
    const p = page(json({ cookieless: false, vid: VID }), [], 'https://cdn.other.net/s.js');
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    expect(p.credentials).toEqual(['omit']);
    expect(p.lookups).toEqual(['https://cdn.other.net/e?site=site_test']);
    expect(cookieMap(p.win).amb_vid).not.toBe(VID);
  });
});

describe('neutral script path', () => {
  it('asks the site mode and posts events on /<dir>/<name> of the script', async () => {
    const p = page(json({ cookieless: false }), [], 'https://t.example.com/k3x9ab2q/app.js');
    const endpoints: string[] = [];
    const ready = boot(p.win, { cookieless: false, hashRouting: false }, (endpoint, body) => {
      endpoints.push(endpoint);
      p.transport(endpoint, body);
    });
    await ready;
    expect(p.lookups[0]).toMatch(/^https:\/\/t\.example\.com\/k3x9ab2q\/app\?site=site_test/);
    expect(endpoints[0]).toBe('https://t.example.com/k3x9ab2q/app');
  });

  it('keeps /e for the classic script names and data-api wins', async () => {
    const p = page(json({ cookieless: false }), [], 'https://t.example.com/s.cookieless.js');
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    expect(p.lookups[0]).toMatch(/^https:\/\/t\.example\.com\/e\?/);
  });

  it('keeps /e for a self-hosted classic bundle under a word directory', async () => {
    const p = page(json({ cookieless: false }), [], 'https://www.example.com/static/sa.js');
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    expect(p.lookups[0]).toMatch(/^https:\/\/www\.example\.com\/e\?/);
  });
});

describe('device signals module', () => {
  const scripts = (win: Window) =>
    [...win.document.querySelectorAll('script')].map((s) => s.src).slice(1);

  it('loads next to the tracker only when the edge says the site turned it on', async () => {
    const on = page(
      json({ cookieless: false, device: true }),
      [],
      'https://t.example.com/k3x9ab2q/app-h.js',
    );
    await boot(on.win, { cookieless: false, hashRouting: true }, on.transport);
    expect(scripts(on.win)).toEqual(['https://t.example.com/k3x9ab2q/app-d.js']);

    for (const answer of [json({ cookieless: false }), json({ cookieless: true, device: true })]) {
      const off = page(answer);
      await boot(off.win, { cookieless: false, hashRouting: false }, off.transport);
      expect(scripts(off.win)).toEqual([]);
    }
  });

  it('never loads with Global Privacy Control', async () => {
    const p = page(json({ cookieless: false, device: true }));
    Object.defineProperty(p.win.navigator, 'globalPrivacyControl', { value: true });
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    expect(scripts(p.win)).toEqual([]);
  });

  it('loads nothing when the tracker has no .js name to derive the module from', async () => {
    for (const src of [
      'https://www.example.com/assets/tracker',
      'https://www.example.com/assets/tracker.mjs',
      'https://www.example.com/wp-json/acme/t.php',
      // `.js` in the query or the fragment names no file.
      'https://www.example.com/index.php?route=tracker.js',
      'https://www.example.com/assets/tracker#v.js',
    ]) {
      expect(deviceScriptUrl(src)).toBeNull();
      const p = page(json({ cookieless: false, device: true }), [], src);
      await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
      // Loading the same URL again would run the tracker twice and silence it.
      expect(scripts(p.win)).toEqual([]);
      (p.win as unknown as { amable: (...a: unknown[]) => void }).amable('goal', 'signup');
      expect(p.sent.map((e) => e.type)).toEqual(['pageview', 'goal']);
    }
  });

  it('loads nothing where the tracker itself is off (localhost)', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><head><script data-site="site_test" src="http://localhost:8788/s.js"></script></head><body></body></html>`,
      { url: 'http://localhost:3000/pricing', pretendToBeVisual: true },
    );
    const win = dom.window as unknown as Window;
    Object.assign(win, { fetch: json({ cookieless: false, device: true }) });
    await boot(win, { cookieless: false, hashRouting: false }, () => undefined);
    expect(scripts(win)).toEqual([]);
  });

  it('maps every script name to the module and sends at most 20 signals', async () => {
    expect(deviceScriptUrl('https://t.example.com/s.js')).toBe('https://t.example.com/s-d.js');
    expect(deviceScriptUrl('https://t.example.com/s.hash.js?v=2')).toBe(
      'https://t.example.com/s-d.js?v=2',
    );
    expect(deviceScriptUrl('https://t.example.com/k3x9ab2q/app.js')).toBe(
      'https://t.example.com/k3x9ab2q/app-d.js',
    );
    const p = page(json({ cookieless: false, device: true }));
    await boot(p.win, { cookieless: false, hashRouting: false }, p.transport);
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    (p.win as unknown as { amable: (...a: unknown[]) => void }).amable('device', many);
    const device = p.sent.find((e) => e.type === 'device');
    expect(Object.keys(device?.data ?? {})).toHaveLength(20);
  });
});
