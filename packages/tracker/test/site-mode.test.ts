import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import type { EventPayload } from '../src/protocol';
import { boot } from '../src/tracker';
import { cookieMap } from './helpers';

function page(answer: () => Promise<Response>, cookies: string[] = []) {
  const dom = new JSDOM(
    '<!doctype html><html><head><script data-site="site_test" src="https://t.example.com/s.js"></script></head><body></body></html>',
    { url: 'https://www.example.com/pricing', pretendToBeVisual: true },
  );
  const win = dom.window as unknown as Window;
  for (const c of cookies) win.document.cookie = c;
  const lookups: string[] = [];
  Object.assign(win, {
    fetch: (url: string) => {
      lookups.push(url);
      return answer();
    },
  });
  const sent: EventPayload[] = [];
  const transport = (_endpoint: string, body: string) => {
    sent.push(JSON.parse(body) as EventPayload);
  };
  return { win, lookups, sent, transport };
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
    expect(p.lookups).toEqual(['https://t.example.com/e?site=site_test']);
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
