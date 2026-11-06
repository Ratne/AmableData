import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createFormSchema,
  deletedResponseSchema,
  formEmbedSchema,
  formIdParamSchema,
  formSchema,
  formSummarySchema,
  listFormsQuerySchema,
  pageOf,
  updateFormSchema,
} from '@amable/api-types';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { assertEditable, LOCKED_RESPONSE, registerEditLockRoutes } from '../../edit-lock/routes';
import { audit, getAuth, getTenant, type AppEnv } from '../../middleware';
import { formsTag, edgeOrigin } from './shared';

export function registerFormRecordRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms',
      tags: formsTag,
      summary: 'List forms (archived ones only with status=archived)',
      request: { query: listFormsQuerySchema },
      responses: { 200: json(pageOf(formSummarySchema), 'Forms') },
    }),
    async (c) => c.json(await callCrm(c, 'forms.list', c.req.valid('query')), 200),
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'post',
      path: '/forms',
      tags: formsTag,
      summary: 'Create a form (without a definition: a starter form)',
      request: { body: jsonBody(createFormSchema) },
      responses: { 201: json(formSchema, 'The form') },
    }),
    async (c) => {
      const locale = getAuth(c).user.locale === 'it' ? 'it' : 'en';
      const form = await callCrm(c, 'forms.create', { ...c.req.valid('json'), locale });
      await audit(c, 'forms.form_created', { target: form.id });
      return c.json(form, 201);
    },
  );
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms/{formId}',
      tags: formsTag,
      summary: 'Get a form with its definition',
      request: { params: formIdParamSchema },
      responses: { 200: json(formSchema, 'The form') },
    }),
    async (c) => c.json(await callCrm(c, 'forms.get', { id: c.req.valid('param').formId }), 200),
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'patch',
      path: '/forms/{formId}',
      tags: formsTag,
      summary: 'Update name, status or definition',
      request: { params: formIdParamSchema, body: jsonBody(updateFormSchema) },
      responses: { 200: json(formSchema, 'The form'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { formId } = c.req.valid('param');
      await assertEditable(c, 'forms', formId);
      return c.json(
        await callCrm(c, 'forms.update', { id: formId, data: c.req.valid('json') }),
        200,
      );
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'delete',
      path: '/forms/{formId}',
      tags: formsTag,
      summary: 'Delete a form (and its connections); submissions are kept',
      request: { params: formIdParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted'), ...LOCKED_RESPONSE },
    }),
    async (c) => {
      const { formId } = c.req.valid('param');
      await assertEditable(c, 'forms', formId);
      const result = await callCrm(c, 'forms.delete', { id: formId });
      await audit(c, 'forms.form_deleted', { target: formId });
      return c.json(result, 200);
    },
  );
  router.openapi(
    crmRoute('forms:write', {
      method: 'post',
      path: '/forms/{formId}/duplicate',
      tags: formsTag,
      summary: 'Copy a form (inactive, without connections)',
      request: {
        params: formIdParamSchema,
        body: {
          required: false,
          content: {
            'application/json': {
              schema: z.strictObject({ name: z.string().trim().min(1).max(200).optional() }),
            },
          },
        },
      },
      responses: { 201: json(formSchema, 'The copy') },
    }),
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
      const name =
        typeof body.name === 'string' && body.name.trim() !== ''
          ? body.name.trim().slice(0, 200)
          : undefined;
      const form = await callCrm(c, 'forms.duplicate', {
        id: c.req.valid('param').formId,
        ...(name === undefined ? {} : { name }),
      });
      return c.json(form, 201);
    },
  );
  for (const [action, op] of [
    ['archive', 'forms.archive'],
    ['restore', 'forms.restore'],
  ] as const) {
    router.openapi(
      crmRoute('forms:write', {
        method: 'post',
        path: `/forms/{formId}/${action}`,
        tags: formsTag,
        summary:
          action === 'archive'
            ? 'Archive a form (stops accepting submissions)'
            : 'Restore an archived form',
        request: { params: formIdParamSchema },
        responses: { 200: json(formSchema, 'The form'), ...LOCKED_RESPONSE },
      }),
      async (c) => {
        const { formId } = c.req.valid('param');
        await assertEditable(c, 'forms', formId);
        return c.json(await callCrm(c, op, { id: formId }), 200);
      },
    );
  }
  registerEditLockRoutes(router, {
    kind: 'forms',
    basePath: '/forms',
    param: 'formId',
    tag: 'Form edit lock',
    write: 'forms:write',
    read: 'forms:read',
    takeover: 'forms:write',
    exists: (c, id) => callCrm(c, 'forms.get', { id }),
  });
  router.openapi(
    crmRoute('forms:read', {
      method: 'get',
      path: '/forms/{formId}/embed',
      tags: formsTag,
      summary: 'Embed snippet and hosted page link',
      request: { params: formIdParamSchema },
      responses: { 200: json(formEmbedSchema, 'Embed facts') },
    }),
    async (c) => {
      const form = await callCrm(c, 'forms.get', { id: c.req.valid('param').formId });
      const slug = getTenant(c).tenant.slug;
      const edge = edgeOrigin(c);
      const settings = form.definition['settings'] as { hosted_enabled?: unknown } | undefined;
      return c.json(
        {
          form_id: form.id,
          tenant: slug,
          script_url: `${edge}/forms.js`,
          config_url: `${edge}/f/${slug}/${form.id}/config`,
          hosted_url: `${edge}/f/${slug}/${form.id}`,
          hosted_enabled: settings?.hosted_enabled !== false,
          snippet: `<div data-amable-form="${form.id}" data-amable-tenant="${slug}"></div>\n<script async src="${edge}/forms.js"></script>`,
        },
        200,
      );
    },
  );
}
