import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  purgeJobSchema,
  suppressionOutcomeSchema,
  suppressionRequestSchema,
  webSuppressionSchema,
  type PurgeJob,
  type SuppressionRequest,
} from '@amable/api-types';
import { siteStub, tenantSitesStub } from '@amable/app-edge/analytics';
import type { Context } from 'hono';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';
import { audit, getAuth, getTenant, type AppEnv } from '../middleware';
import { syncPorts } from './runtime';
import { namespace } from './service';
import { suppressWorkspace } from './suppressions';

const tags = ['Analytics'];

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Runs a suppression for the verified workspace (shared by the v2 and the `/v1` routes). */
export async function runSuppression(c: Context<AppEnv>, input: SuppressionRequest) {
  const tenantId = getTenant(c).tenant.id;
  const outcome = await suppressWorkspace(syncPorts(c.env, namespace(c), tenantId), tenantId, {
    visitorId: input.visitor_id,
    contactId: input.contact_id,
    email: input.email,
    phone: input.phone,
    purge: input.purge,
    reason: input.reason,
    actorId: getAuth(c).user.id,
  });
  await audit(c, input.purge ? 'analytics.visitor_erased' : 'analytics.visitor_suppressed', {
    target: input.contact_id ?? input.visitor_id ?? null,
    details: {
      ...outcome,
      by:
        input.contact_id !== undefined
          ? 'contact'
          : input.visitor_id !== undefined
            ? 'visitor'
            : 'identity',
    },
  });
  return outcome;
}

export function registerSuppressionRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute(
      'analytics:configure',
      {
        method: 'post',
        path: '/suppressions',
        tags,
        summary: 'Opt a person out of web tracking (and erase their tracked data)',
        description:
          'By visitor id, CRM contact (linked visitors + hashed emails/phones) or email/phone. Every site drops their future events; with `purge` (default) their identity rows are deleted, their traffic stays only as anonymous counts and the R2 archive is rewritten in the background.',
        request: { body: jsonBody(suppressionRequestSchema) },
        responses: { 200: json(suppressionOutcomeSchema, 'Applied on every site') },
      },
      { stepUp: true },
    ),
    async (c) => c.json(await runSuppression(c, c.req.valid('json')), 200),
  );

  app.openapi(
    crmRoute('analytics:configure', {
      method: 'get',
      path: '/suppressions',
      tags,
      summary: 'List suppressions and purge jobs',
      request: { query: z.object({ offset: z.coerce.number().int().min(0).optional() }) },
      responses: {
        200: json(
          z.object({ data: z.array(webSuppressionSchema), purge_jobs: z.array(purgeJobSchema) }),
          'Newest first',
        ),
      },
    }),
    async (c) => {
      const rows = await callCrm(c, 'analytics.listSuppressions', {
        limit: 100,
        offset: c.req.valid('query').offset ?? 0,
      });
      const ns = namespace(c);
      const jobs: PurgeJob[] = [];
      for (const siteId of await tenantSitesStub(ns, getTenant(c).tenant.id).indexList()) {
        for (const j of await siteStub(ns, siteId).purgeJobs()) {
          jobs.push({
            id: j.id,
            site_id: siteId,
            status: j.status,
            visitors: j.visitors,
            scanned: j.scanned,
            rewritten: j.rewritten,
            failed: j.failed,
            tail: j.tail === 1,
            tail_until: iso(j.tail_until),
            created_at: iso(j.created_at) as string,
            done_at: iso(j.done_at),
          });
        }
      }
      jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return c.json(
        {
          data: rows.map((r) => ({
            kind: r.kind,
            value: r.value,
            purge: r.purge === 1,
            reason: r.reason,
            created_at: iso(r.created_at) as string,
          })),
          purge_jobs: jobs.slice(0, 100),
        },
        200,
      );
    },
  );
}
