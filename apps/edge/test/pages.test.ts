import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { pagesCatchAll, pagesEdgeRoutes, trackerSiteId } from '../src/pages/routes';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

function analytics(sites: Record<string, string[]>, fail = false): Env['ANALYTICS'] {
  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      indexList: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve(Object.keys(sites))),
      getSite: () => {
        const id = name.replace(/^site:/, '');
        const hostnames = sites[id];
        return Promise.resolve(hostnames === undefined ? null : { site: { id, hostnames }, deleted: false });
      },
    }),
  } as unknown as Env['ANALYTICS'];
}

describe('landing tracker site', () => {
  const env = { ANALYTICS: analytics({ st_one: ['one.test'], st_two: ['two.test'] }) } as Env;

  it('prefers the page setting, then the host match (subdomains included), then the first site', async () => {
    expect(await trackerSiteId(env, 't1', 'st_explicit', 'two.test')).toBe('st_explicit');
    expect(await trackerSiteId(env, 't1', null, 'www.two.test')).toBe('st_two');
    expect(await trackerSiteId(env, 't1', null, 'other.test')).toBe('st_one');
    expect(await trackerSiteId({ ANALYTICS: analytics({}) } as Env, 't1', null, 'x.test')).toBeNull();
    expect(await trackerSiteId({ ANALYTICS: analytics({}, true) } as Env, 't1', null, 'x.test')).toBeNull();
  });
});

describe('landing edge routes without the core binding', () => {
  it('answers 503 for pages, 404 for malformed URLs and serves robots.txt', async () => {
    const env = { ANALYTICS: analytics({}) } as Env;
    expect((await pagesEdgeRoutes.request('https://e.test/p/acme/x', {}, env)).status).toBe(503);
    expect((await pagesEdgeRoutes.request('https://e.test/p/bad_slug!/x', {}, env)).status).toBe(404);
    expect((await pagesEdgeRoutes.request('https://e.test/m/acme/not-a-file', {}, env)).status).toBe(404);
    const { Hono } = await import('hono');
    const app = new Hono<{ Bindings: Env }>().get('*', pagesCatchAll);
    const robots = await app.request('https://shop.test/robots.txt', {}, env);
    expect(await robots.text()).toBe('User-agent: *\nAllow: /\nSitemap: https://shop.test/sitemap.xml\n');
  });
});
