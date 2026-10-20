import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { createCrmRouter, crmRoute, json, jsonBody } from '../crm/api/core';
import { sendingState } from '../email/runtime';
import { audit, getTenant, handleError, type AppEnv } from '../middleware';
import { domainService, edgeHostname } from './runtime';
import { DomainError } from './service';

const tags = ['Domains'];

const recordSchema = z.object({ type: z.enum(['TXT', 'CNAME', 'MX']), name: z.string(), value: z.string() });

const domainSchema = z
  .object({
    id: z.string(),
    hostname: z.string(),
    kind: z.enum(['sending', 'tracking', 'app']),
    status: z.enum(['pending', 'verified', 'failed']),
    records: z.array(recordSchema).describe('DNS records to create on the zone (manual mode)'),
    paths: z.array(z.string()).describe('Site only: landing paths served on an existing hostname'),
    routes: z.array(z.string()).describe('Site only: Workers Routes patterns to the edge worker'),
    zone_id: z.string().nullable(),
    dns_applied_at: z.string().nullable(),
    verified_at: z.string().nullable(),
    checked_at: z.string().nullable(),
    last_error: z.string().nullable(),
    dns_changed_at: z
      .string()
      .nullable()
      .describe('Sending only: the email provider changed the DNS records (infrastructure move); publish `records` and verify again'),
    created_at: z.string(),
  })
  .openapi('TenantDomain');

const listSchema = z.object({
  automation: z.enum(['cloudflare', 'fake', 'manual']),
  edge_hostname: z.string(),
  data: z.array(domainSchema),
});

const createSchema = z
  .strictObject({
    kind: z.enum(['sending', 'tracking', 'app']),
    hostname: z.string().min(4).max(253),
    paths: z.array(z.string().max(64)).max(10).optional(),
  })
  .openapi('TenantDomainCreate');

const sendingStatusSchema = z.object({
  state: z.enum(['verified', 'unverified', 'dev_override']),
  can_send: z.boolean(),
  verified_domains: z.array(z.string()),
  dns_update_needed: z.array(z.string()).describe('Sending domains whose DNS records changed at the provider and must be published again'),
});

const idParam = z.object({ id: z.string().min(1).max(64) });

export function registerDomainRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/domains/sending-status',
      tags,
      summary: 'Whether the tenant may send marketing email',
      description: 'Sending stays blocked until a sending domain is verified.',
      responses: { 200: json(sendingStatusSchema, 'Sending status') },
    }),
    async (c) => {
      const tenantId = getTenant(c).tenant.id;
      const state = await sendingState(c.env, tenantId)();
      const changed = await c.env.DB.prepare(
        `SELECT hostname FROM domains WHERE tenant_id = ? AND kind = 'sending' AND dns_changed_at IS NOT NULL ORDER BY hostname`,
      )
        .bind(tenantId)
        .all<{ hostname: string }>();
      return c.json(
        {
          state: state.state,
          can_send: state.state !== 'unverified',
          verified_domains: state.domains
            .filter((d) => d.kind === 'sending' && d.status === 'verified')
            .map((d) => d.hostname),
          dns_update_needed: changed.results.map((r) => r.hostname),
        },
        200,
      );
    },
  );

  app.openapi(
    crmRoute('domains:manage', {
      method: 'get',
      path: '/domains',
      tags,
      summary: 'List the connected domains',
      responses: { 200: json(listSchema, 'Domains and the DNS automation mode') },
    }),
    async (c) => {
      const service = domainService(c.env);
      return c.json(
        {
          automation: service.automation,
          edge_hostname: edgeHostname(c.env),
          data: await service.list(getTenant(c).tenant.id),
        },
        200,
      );
    },
  );

  app.openapi(
    crmRoute('domains:manage', {
      method: 'post',
      path: '/domains',
      tags,
      summary: 'Connect a domain',
      description:
        '`sending`: registered with the email provider, returns its SPF / DKIM / DMARC records. `tracking`: click / open / tracker hostname (CNAME or Workers custom domain to the edge). `app`: landing pages and booking pages on a hostname — whole host, or only `paths` of an existing site via Workers Routes.',
      request: { body: jsonBody(createSchema) },
      responses: { 201: json(domainSchema, 'The connected domain') },
    }, { stepUp: true }),
    async (c) => {
      const body = c.req.valid('json');
      const domain = await domainService(c.env).add(getTenant(c).tenant.id, {
        kind: body.kind,
        hostname: body.hostname,
        ...(body.paths === undefined ? {} : { paths: body.paths }),
      });
      await audit(c, 'domain.added', { target: domain.hostname, details: { kind: domain.kind } });
      return c.json(domain, 201);
    },
  );

  app.openapi(
    crmRoute('domains:manage', {
      method: 'post',
      path: '/domains/{id}/apply-dns',
      tags,
      summary: 'Create the DNS records on the Cloudflare zone',
      description: 'Needs the Cloudflare API token of the installation (409 `automation_unavailable` otherwise).',
      request: { params: idParam },
      responses: { 200: json(domainSchema, 'Domain after the zone changes') },
    }, { stepUp: true }),
    async (c) => {
      const domain = await domainService(c.env).applyDns(getTenant(c).tenant.id, c.req.valid('param').id);
      await audit(c, 'domain.dns_applied', { target: domain.hostname });
      return c.json(domain, 200);
    },
  );

  app.openapi(
    crmRoute('domains:manage', {
      method: 'post',
      path: '/domains/{id}/verify',
      tags,
      summary: 'Verify a domain',
      request: { params: idParam },
      responses: { 200: json(domainSchema, 'Domain with the verification result') },
    }),
    async (c) => {
      const domain = await domainService(c.env).verify(getTenant(c).tenant.id, c.req.valid('param').id);
      await audit(c, 'domain.verified', { target: domain.hostname, details: { status: domain.status } });
      return c.json(domain, 200);
    },
  );

  app.openapi(
    crmRoute('domains:manage', {
      method: 'delete',
      path: '/domains/{id}',
      tags,
      summary: 'Disconnect a domain',
      request: { params: idParam },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Removed') },
    }, { stepUp: true }),
    async (c) => {
      const { id } = c.req.valid('param');
      await domainService(c.env).remove(getTenant(c).tenant.id, id);
      await audit(c, 'domain.removed', { target: id });
      return c.json({ ok: true as const }, 200);
    },
  );
}

/** Domain REST v2 routes, relative to `/api/v2/t/{slug}`. */
export const domainsApi = createCrmRouter();
domainsApi.onError((error, c) => {
  if (error instanceof DomainError) return c.json({ error: error.code, message: error.message }, error.status);
  return handleError(error, c);
});
registerDomainRoutes(domainsApi);

export function domainsOpenApiDocument(): ReturnType<typeof domainsApi.getOpenAPI31Document> {
  return domainsApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'amabledata REST API — domains', version: '2.0.0' },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
  });
}
