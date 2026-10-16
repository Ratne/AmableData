import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  automationContactParamSchema,
  automationDetailSchema,
  automationEnrollmentParamSchema,
  automationIdParamSchema,
  automationSchema,
  automationStatsSchema,
  automationVersionParamSchema,
  automationVersionSchema,
  automationVersionSummarySchema,
  callNameParamSchema,
  contactEnrollmentSchema,
  createAutomationSchema,
  deletedResponseSchema,
  engineSettingsSchema,
  enrollContactSchema,
  enrollmentDetailSchema,
  enrollmentSchema,
  idParamSchema,
  listAutomationsQuerySchema,
  listContactEnrollmentsQuerySchema,
  listEnrollmentsQuerySchema,
  pageOf,
  publishResultSchema,
  removeContactResultSchema,
  saveDraftSchema,
  signingSecretSchema,
  triggerApiGoalResultSchema,
  triggerApiGoalSchema,
  updateAutomationSchema,
  updateEngineSettingsSchema,
  validationResultSchema,
} from '@amable/api-types';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { getAuth, getTenant, type AppEnv } from '../../middleware';
import { CrmHttpError, crmRoute, json, jsonBody } from '../../crm/api/core';
import type { CrmResult } from '../../crm/ops';
import type { Engine } from '../../do/engine';
import { registerFolderRoutes } from '../../folders/routes';
import type { Env } from '../../env';
import type { AutomationOpInput, AutomationOpName, AutomationOpOutput } from '../ops';

/** Stub of the tenant's Engine DO (tenant id comes from the verified context only). */
export function engineStub(env: Env, tenantId: string): DurableObjectStub<Engine> {
  return env.ENGINE.get(env.ENGINE.idFromName(tenantId));
}

/**
 * Mounts the engine pieces outside the REST router (which registers its
 * routes through `registerAutomationRoutes`): the outbox kick around every v2
 * tenant request, and the dev-only seed route.
 */
export function mountAutomationApi(app: Hono<AppEnv>): void {
  app.use('/v2/t/:slug/*', automationKick());

  // Dev-only (ENVIRONMENT=dev, used by `pnpm seed`): two demo automations in the demo tenant.
  app.post('/dev/seed-automations', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev') return c.notFound();
    const slug = c.req.query('tenant') ?? 'demo';
    const tenant = await c.env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`)
      .bind(slug)
      .first<{ id: string }>();
    if (tenant === null) {
      return c.json({ error: 'tenant_not_found', message: 'run the base seed first' }, 404);
    }
    const summary = await engineStub(c.env, tenant.id).devSeed(tenant.id);
    return c.json({ ok: true, tenant: slug, automations: summary });
  });

  app.get('/dev/engine', async (c) => {
    if (c.env.ENVIRONMENT !== 'dev') return c.notFound();
    const tenant = await c.env.DB.prepare(`SELECT id FROM tenants WHERE slug = ?`)
      .bind(c.req.query('tenant') ?? 'demo')
      .first<{ id: string }>();
    if (tenant === null) return c.json({ error: 'tenant_not_found' }, 404);
    return c.json(await engineStub(c.env, tenant.id).devInspect());
  });
}

/** Runs an automation operation in the verified tenant's Engine DO; domain errors become HTTP errors. */
export async function callEngine<K extends AutomationOpName>(
  c: Context<AppEnv>,
  op: K,
  input: AutomationOpInput<K>,
): Promise<AutomationOpOutput<K>> {
  const tenantId = getTenant(c).tenant.id;
  const result = (await engineStub(c.env, tenantId).automation(
    tenantId,
    op,
    { userId: getAuth(c).user.id },
    input,
  )) as CrmResult<AutomationOpOutput<K>>;
  if (!result.ok) throw new CrmHttpError(result.error);
  return result.value;
}

/**
 * After a successful mutating tenant request, asks the Engine DO to drain the
 * TenantDb outbox (fire-and-forget). Registered before the guards so it wraps
 * every v2 route, CRM included.
 */
export function automationKick(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.res.status >= 400) return;
    const tenant = c.get('tenant');
    if (tenant === undefined) return;
    try {
      c.executionCtx.waitUntil(
        engineStub(c.env, tenant.tenant.id)
          .kick(tenant.tenant.id)
          .catch((error: unknown) => console.error(`[engine] kick failed: ${String(error)}`)),
      );
    } catch {
      // No execution context or engine binding (tests): the periodic poll picks events up.
    }
  };
}

export function registerAutomationRoutes(app: OpenAPIHono<AppEnv>): void {
  const tags = ['Automations'];

  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations',
      tags,
      summary: 'List automations',
      description:
        'Cursor-paginated, newest first. `status` and the folder filter narrow the list; `q` keeps names containing it (case-insensitive, `%` and `_` match literally).',
      request: { query: listAutomationsQuerySchema },
      responses: { 200: json(pageOf(automationSchema), 'A page of automations, newest first') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'post',
      path: '/automations',
      tags,
      summary: 'Create an automation (draft)',
      request: { body: jsonBody(createAutomationSchema) },
      responses: { 201: json(automationDetailSchema, 'The automation with its draft graph') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations/{id}',
      tags,
      summary: 'Get an automation with its draft graph',
      request: { params: automationIdParamSchema },
      responses: { 200: json(automationDetailSchema, 'The automation') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'patch',
      path: '/automations/{id}',
      tags,
      summary: 'Update name, description or settings',
      request: { params: automationIdParamSchema, body: jsonBody(updateAutomationSchema) },
      responses: { 200: json(automationDetailSchema, 'The automation') },
    }),
    async (c) =>
      c.json(
        await callEngine(c, 'automations.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'delete',
      path: '/automations/{id}',
      tags,
      summary: 'Delete an unpublished automation (active enrollments are removed)',
      request: { params: automationIdParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'put',
      path: '/automations/{id}/draft',
      tags,
      summary: 'Save the draft graph (optimistic lock on `revision`)',
      request: { params: automationIdParamSchema, body: jsonBody(saveDraftSchema) },
      responses: { 200: json(automationDetailSchema, 'The automation with the saved draft') },
    }),
    async (c) =>
      c.json(
        await callEngine(c, 'automations.saveDraft', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'post',
      path: '/automations/{id}/validate',
      tags,
      summary: 'Validate the draft graph (publish rules)',
      request: { params: automationIdParamSchema },
      responses: { 200: json(validationResultSchema, 'Errors block publishing, warnings do not') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.validate', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:publish', {
      method: 'post',
      path: '/automations/{id}/publish',
      tags,
      summary: 'Publish the draft as a new immutable version and activate the automation',
      description:
        'Running enrollments stay on the version they started with. A draft with errors is rejected with 422 and the issues as `details`.',
      request: { params: automationIdParamSchema },
      responses: { 200: json(publishResultSchema, 'The published version') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.publish', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:publish', {
      method: 'post',
      path: '/automations/{id}/unpublish',
      tags,
      summary: 'Stop the automation: no new entries, running positions are suspended',
      request: { params: automationIdParamSchema },
      responses: { 200: json(automationSchema, 'The automation') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.unpublish', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations/{id}/versions',
      tags,
      summary: 'List published versions',
      request: { params: automationIdParamSchema },
      responses: {
        200: json(
          z.object({ data: z.array(automationVersionSummarySchema) }),
          'Versions, newest first',
        ),
      },
    }),
    async (c) =>
      c.json({ data: await callEngine(c, 'automations.versions', c.req.valid('param')) }, 200),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations/{id}/versions/{versionId}',
      tags,
      summary: 'Get a published version with its graph',
      request: { params: automationVersionParamSchema },
      responses: { 200: json(automationVersionSchema, 'The version') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.version', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'post',
      path: '/automations/{id}/versions/{versionId}/restore',
      tags,
      summary: 'Copy a published version into the draft',
      request: { params: automationVersionParamSchema },
      responses: { 200: json(automationDetailSchema, 'The automation with the restored draft') },
    }),
    async (c) =>
      c.json(await callEngine(c, 'automations.restoreVersion', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations/{id}/enrollments',
      tags,
      summary: 'List enrollments (contacts that entered the automation)',
      request: { params: automationIdParamSchema, query: listEnrollmentsQuerySchema },
      responses: { 200: json(pageOf(enrollmentSchema), 'A page of enrollments, newest first') },
    }),
    async (c) =>
      c.json(
        await callEngine(c, 'automations.enrollments', {
          id: c.req.valid('param').id,
          query: c.req.valid('query'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations/{id}/enrollments/{enrollmentId}',
      tags,
      summary: 'Get an enrollment with its positions and execution log',
      request: { params: automationEnrollmentParamSchema },
      responses: { 200: json(enrollmentDetailSchema, 'The enrollment') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.enrollment', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'post',
      path: '/automations/{id}/enrollments',
      tags,
      summary: 'Enroll a contact manually (at a goal or a sequence)',
      request: { params: automationIdParamSchema, body: jsonBody(enrollContactSchema) },
      responses: { 201: json(enrollmentSchema, 'The new enrollment') },
    }),
    async (c) =>
      c.json(
        await callEngine(c, 'automations.enroll', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('automations:write', {
      method: 'delete',
      path: '/automations/{id}/contacts/{contactId}',
      tags,
      summary: 'Remove a contact from the automation',
      request: { params: automationContactParamSchema },
      responses: {
        200: json(removeContactResultSchema, 'Whether an active enrollment was removed'),
      },
    }),
    async (c) =>
      c.json(await callEngine(c, 'automations.removeContact', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/contacts/{id}/automations',
      tags,
      summary: 'Automations of a contact (current enrollments or history)',
      description:
        '`scope=current` lists active enrollments with their current node, step and next action; `scope=history` lists completed, removed and failed ones with the outcome. Newest first, cursor-paginated. Remove with `DELETE /automations/{id}/contacts/{contactId}`, add with `POST /automations/{id}/enrollments`.',
      request: { params: idParamSchema, query: listContactEnrollmentsQuerySchema },
      responses: {
        200: json(pageOf(contactEnrollmentSchema), 'A page of enrollments, newest first'),
      },
    }),
    async (c) =>
      c.json(
        await callEngine(c, 'contacts.enrollments', {
          contactId: c.req.valid('param').id,
          query: c.req.valid('query'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automations/{id}/stats',
      tags,
      summary: 'Per-node and per-step counters (entered, active, completed, errors)',
      request: { params: automationIdParamSchema },
      responses: { 200: json(automationStatsSchema, 'Counters') },
    }),
    async (c) => c.json(await callEngine(c, 'automations.stats', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:publish', {
      method: 'get',
      path: '/automations/{id}/signing-secret',
      tags,
      summary: 'HMAC secret used to sign the HTTP steps of this automation',
      request: { params: automationIdParamSchema },
      responses: { 200: json(signingSecretSchema, 'The secret') },
    }, { stepUp: true }),
    async (c) =>
      c.json(await callEngine(c, 'automations.signingSecret', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:publish', {
      method: 'post',
      path: '/automations/{id}/signing-secret/rotate',
      tags,
      summary: 'Rotate the HTTP signing secret',
      request: { params: automationIdParamSchema },
      responses: { 200: json(signingSecretSchema, 'The new secret') },
    }, { stepUp: true }),
    async (c) =>
      c.json(await callEngine(c, 'automations.rotateSigningSecret', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('automations:trigger', {
      method: 'post',
      path: '/automationGoals/{callName}/trigger',
      tags,
      summary: 'Fire every published API goal with this call name for a contact',
      request: { params: callNameParamSchema, body: jsonBody(triggerApiGoalSchema) },
      responses: { 200: json(triggerApiGoalResultSchema, 'Goals achieved by the call') },
    }),
    async (c) =>
      c.json(
        await callEngine(c, 'goals.triggerApi', {
          callName: c.req.valid('param').callName,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('automations:read', {
      method: 'get',
      path: '/automationSettings',
      tags,
      summary: 'Engine settings (tenant time zone)',
      responses: { 200: json(engineSettingsSchema, 'Settings') },
    }),
    async (c) => c.json(await callEngine(c, 'settings.get', {}), 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'put',
      path: '/automationSettings',
      tags,
      summary: 'Set the tenant time zone used when a contact has none',
      request: { body: jsonBody(updateEngineSettingsSchema) },
      responses: { 200: json(engineSettingsSchema, 'Settings') },
    }),
    async (c) => c.json(await callEngine(c, 'settings.update', c.req.valid('json')), 200),
  );

  registerFolderRoutes(app, {
    path: '/automationFolders',
    tag: 'Automation folders',
    items: 'automations',
    read: 'automations:read',
    write: 'automations:write',
    backend: {
      list: (c) => callEngine(c, 'folders.list', {}),
      get: (c, input) => callEngine(c, 'folders.get', input),
      create: (c, input) => callEngine(c, 'folders.create', input),
      update: (c, input) => callEngine(c, 'folders.update', input),
      delete: (c, input) => callEngine(c, 'folders.delete', input),
      moveItems: (c, input) => callEngine(c, 'folders.moveItems', input),
    },
  });
}
