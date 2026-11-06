import {
  SHORTLINK_CLICK_GATEWAY_OP,
  SHORTLINK_KEY_RE,
  SHORTLINK_RESOLVE_GATEWAY_OP,
  type GatewayTenantInfo,
  type ShortlinkGatewayOps,
} from '@amable/api-types';
import { z } from 'zod';
import type { Env } from '../env';
import { GatewayError, type GatewayContext, type GatewayHandlers } from '../public/context';

type Output<K extends keyof ShortlinkGatewayOps> = ShortlinkGatewayOps[K]['output'];

const id = z.string().min(1).max(64);
const dimension = z.string().max(253).nullable();
const resolveSchema = z.strictObject({ domainId: id, key: z.string().regex(SHORTLINK_KEY_RE) });
const clickSchema = z.strictObject({
  linkId: id,
  country: dimension,
  referrerHost: dimension,
  device: dimension,
  browser: dimension,
  os: dimension,
  bot: z.boolean(),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new GatewayError(400, 'bad_request', 'invalid input');
  return parsed.data;
}

/**
 * Verified shortlink domain → owning tenant and domain id (installation D1).
 * In dev, pending domains resolve too, like workspace hostnames.
 */
export async function findShortlinkHost(
  env: Env,
  hostname: string,
): Promise<{ tenant: GatewayTenantInfo; domainId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT t.id AS id, t.slug AS slug, t.name AS name, d.id AS domain_id
       FROM domains d JOIN tenants t ON t.id = d.tenant_id
      WHERE d.hostname = ? AND d.kind = 'shortlink' AND (d.status = 'verified' OR ? = 'dev')`,
  )
    .bind(hostname.toLowerCase(), env.ENVIRONMENT ?? '')
    .first<{ id: string; slug: string; name: string; domain_id: string }>();
  if (row === null) return null;
  return { tenant: { id: row.id, slug: row.slug, name: row.name }, domainId: row.domain_id };
}

export const shortlinksGatewayHandlers: GatewayHandlers = {
  async [SHORTLINK_RESOLVE_GATEWAY_OP](
    ctx: GatewayContext,
    input: unknown,
  ): Promise<Output<typeof SHORTLINK_RESOLVE_GATEWAY_OP>> {
    return ctx.crm('shortlinks.resolve', parse(resolveSchema, input));
  },
  async [SHORTLINK_CLICK_GATEWAY_OP](
    ctx: GatewayContext,
    input: unknown,
  ): Promise<Output<typeof SHORTLINK_CLICK_GATEWAY_OP>> {
    return ctx.crm('shortlinks.click', parse(clickSchema, input));
  },
};
