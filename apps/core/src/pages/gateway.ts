import type { PublishedPage } from '@amable/builder';
import { z } from 'zod';
import { GatewayError, type GatewayHandlers, type GatewayRawHandlers } from '../public/context';

/** Public ops reachable from the edge worker: published pages, sitemap, media files. */

const hostSchema = z.string().trim().toLowerCase().max(253).nullable();

const resolveInput = z.strictObject({ host: hostSchema, path: z.string().max(2000) });
const sitemapInput = z.strictObject({ host: hostSchema });
const mediaInput = z.strictObject({ file: z.string().regex(/^[A-Za-z0-9]{10,40}\.[a-z0-9]{2,5}$/) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new GatewayError(400, 'bad_request', 'invalid input');
  return result.data;
}

export const pagesGatewayHandlers: GatewayHandlers = {
  async 'pages.resolve'(ctx, input): Promise<PublishedPage> {
    const { host, path } = parse(resolveInput, input);
    const found = await ctx.crm('pages.resolve', { host, path: decodePath(path) });
    if (found === null) throw new GatewayError(404, 'not_found', 'page not found');
    return {
      page: { id: found.page.id, title: found.page.title, path: found.page.path, host: found.page.host },
      version: found.version,
      document: found.document,
      seo: found.seo,
      settings: found.settings,
    };
  },

  async 'pages.sitemap'(ctx, input) {
    const { host } = parse(sitemapInput, input);
    return ctx.crm('pages.sitemap', { host });
  },
};

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export const pagesGatewayRawHandlers: GatewayRawHandlers = {
  /** Media file from R2; long-cached (file names are immutable ids). */
  async 'pages.media'(ctx, input) {
    const { file } = parse(mediaInput, input);
    const row = await ctx.crm('pages.mediaByFile', { file });
    if (row === null) return new Response('Not found', { status: 404 });
    const object = await ctx.env.FILES.get(row.r2_key);
    if (object === null) return new Response('Not found', { status: 404 });
    return new Response(object.body, {
      headers: {
        'content-type': row.content_type,
        'content-length': String(row.size),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        etag: `"${row.sha256 ?? row.id}"`,
      },
    });
  },
};
