import { z } from '@hono/zod-openapi';
import { siteQuery } from './params';
import {
  OUTBOUND_STATUSES,
  OUTBOUND_TARGETS,
  outboundConversionJobSchema,
  type OutboundConversionJob,
} from '@amable/api-types';
import { siteStub } from '@amable/app-edge/analytics';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { audit, type AppEnv } from '../middleware';
import { epochBound, rangeBound } from './routes-funnels';
import { namespace, siteForQuery, siteRecord, unwrap } from './service';

const tags = ['Analytics'];
const idParam = z.object({ id: z.string().min(1).max(128) });

const filterShape = {
  platform: z.enum(OUTBOUND_TARGETS).optional(),
  connection_id: z.string().min(1).max(64).optional(),
  /** `created_at` range: local days of the site (`to` inclusive) or ISO date-times. */
  from: rangeBound.optional(),
  to: rangeBound.optional(),
};

const listQuery = siteQuery.extend({
  ...filterShape,
  status: z.enum(OUTBOUND_STATUSES).optional(),
  event_id: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const statsSchema = z.object(
  Object.fromEntries(OUTBOUND_STATUSES.map((s) => [s, z.number().int()])) as Record<
    (typeof OUTBOUND_STATUSES)[number],
    z.ZodNumber
  >,
);

const resendBodySchema = z.union([
  z.strictObject({ ids: z.array(z.string().min(1).max(128)).min(1).max(1000) }),
  z.strictObject(filterShape),
]);
const requeuedSchema = z.object({ requeued: z.number().int() });

/** Jobs as exposed by the API: personal data of pending jobs never leaves the server. */
function redact(job: OutboundConversionJob): OutboundConversionJob {
  const { email: _email, phone: _phone, ip: _ip, user_agent: _ua, ...payload } = job.payload;
  return { ...job, payload };
}

function epochRange(filter: { from?: string | undefined; to?: string | undefined }, timeZone: string) {
  return {
    ...(filter.from === undefined ? {} : { from: epochBound(filter.from, false, timeZone) }),
    ...(filter.to === undefined ? {} : { to: epochBound(filter.to, true, timeZone) }),
  };
}

/** Outbound conversion log (server-side conversions sent to the ad platforms) and resend. */
export function registerOutboundRoutes(api: OpenAPIHono<AppEnv>): void {
  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/outbound',
      tags,
      summary: 'Outbound conversion log (newest first) with the job count per status',
      request: { query: listQuery },
      responses: {
        200: json(
          z.object({
            data: z.array(outboundConversionJobSchema),
            stats: statsSchema,
            /** More jobs match the filter than `limit`: only the newest are listed. */
            truncated: z.boolean(),
          }),
          'Jobs',
        ),
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const record = await siteRecord(c, q.site_id);
      const stub = siteStub(namespace(c), q.site_id);
      const filter = {
        platform: q.platform,
        connection_id: q.connection_id,
        ...epochRange(q, record.site.timezone),
      };
      const [jobs, stats] = await Promise.all([
        stub.listOutbound({ ...filter, status: q.status, event_id: q.event_id, limit: q.limit }),
        stub.outboundStats({ ...filter, event_id: q.event_id }),
      ]);
      const matching = q.status === undefined ? OUTBOUND_STATUSES.reduce((n, s) => n + stats[s], 0) : stats[q.status];
      return c.json({ data: jobs.map(redact), stats, truncated: matching > jobs.length }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/outbound/resend',
      tags,
      summary: 'Resend failed jobs: the listed ids, or every failed job matching the filter',
      request: { query: siteQuery, body: jsonBody(resendBodySchema) },
      responses: { 200: json(requeuedSchema, 'Jobs put back in the queue') },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const body = c.req.valid('json');
      const record = await siteRecord(c, site_id);
      const stub = siteStub(namespace(c), site_id);
      const result =
        'ids' in body
          ? await stub.resendOutbound(body.ids)
          : unwrap(
              await stub.resendFailedOutbound({
                platform: body.platform,
                connection_id: body.connection_id,
                ...epochRange(body, record.site.timezone),
              }),
            );
      await audit(c, 'analytics.outbound_resent', { details: { site: site_id, requeued: result.requeued } });
      return c.json({ requeued: result.requeued }, 200);
    },
  );

  api.openapi(
    crmRoute('analytics:read', {
      method: 'get',
      path: '/outbound/{id}',
      tags,
      summary: 'One outbound conversion job',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(outboundConversionJobSchema, 'Job') },
    }),
    async (c) => {
      const stub = await siteForQuery(c, c.req.valid('query').site_id);
      const job = await stub.getOutbound(c.req.valid('param').id);
      if (job === null) throw new CrmError('not_found', 'outbound job not found');
      return c.json(redact(job), 200);
    },
  );

  api.openapi(
    crmRoute('analytics:configure', {
      method: 'post',
      path: '/outbound/{id}/resend',
      tags,
      summary: 'Resend one failed job (other statuses are left alone: `requeued` is 0)',
      request: { params: idParam, query: siteQuery },
      responses: { 200: json(requeuedSchema, 'Requeued count') },
    }),
    async (c) => {
      const { site_id } = c.req.valid('query');
      const { id } = c.req.valid('param');
      const stub = await siteForQuery(c, site_id);
      if ((await stub.getOutbound(id)) === null) throw new CrmError('not_found', 'outbound job not found');
      const { requeued } = await stub.resendOutbound([id]);
      if (requeued > 0) await audit(c, 'analytics.outbound_resent', { target: id, details: { site: site_id, requeued } });
      return c.json({ requeued }, 200);
    },
  );
}
