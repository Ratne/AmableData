import type { GatewayClientInfo, GatewayResponse, GatewayTenantInfo } from '@amable/api-types';
import type { PublishedPage } from '@amable/builder';
import { z } from 'zod';
import type { Env } from '../env';
import {
  createGatewayContext,
  GatewayError,
  type GatewayHandlers,
  type GatewayRawHandlers,
} from '../public/context';

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

/** Installation op of the edge funnel routes (see `apps/edge/src/analytics/links/hosted-pages.ts`). */
export const PAGE_PUBLIC_URL_GATEWAY_OP = 'pages.publicUrl';

const publicUrlInput = z.strictObject({
  tenant_id: z.string().min(1).max(64),
  page_id: z.string().min(1).max(64),
});

/**
 * Public URL of a published page, used as a funnel destination: its own host,
 * else the `/p/<slug>` fallback on the edge origin. The tenant travels in the
 * input (the edge only knows the tenant id of the analytics site).
 */
export async function handlePagePublicUrlOp(
  env: Env,
  executionCtx: ExecutionContext,
  client: GatewayClientInfo,
  input: unknown,
): Promise<{ status: number; body: GatewayResponse<{ url: string }> }> {
  const fail = (error: GatewayError) => ({ status: error.status, body: { ok: false as const, error: error.toBody() } });
  const parsed = publicUrlInput.safeParse(input);
  if (!parsed.success) return fail(new GatewayError(400, 'bad_request', 'invalid input'));
  const tenant = await env.DB.prepare(`SELECT id, slug, name FROM tenants WHERE id = ?`)
    .bind(parsed.data.tenant_id)
    .first<GatewayTenantInfo>();
  if (tenant === null) return fail(new GatewayError(404, 'not_found', 'tenant not found'));
  const ctx = createGatewayContext({ env, executionCtx, tenant, client });
  try {
    const page = await ctx.crm('pages.get', { id: parsed.data.page_id });
    if (page.status !== 'published') return fail(new GatewayError(404, 'not_found', 'page not published'));
    const path = encodeURI(page.path);
    const url =
      page.host !== null
        ? `https://${page.host}${path}`
        : `${(env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '')}/p/${tenant.slug}${path === '/' ? '' : path}`;
    return { status: 200, body: { ok: true, tenant, value: { url } } };
  } catch (error) {
    if (error instanceof GatewayError) return fail(error.status === 404 ? error : new GatewayError(404, 'not_found', 'page not found'));
    throw error;
  }
}
