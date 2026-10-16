import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  addSuppressionSchema,
  createEmailTemplateSchema,
  createSnippetSchema,
  deletedResponseSchema,
  emailMessagePageSchema,
  emailMessageSchema,
  emailSettingsSchema,
  emailTemplatePageSchema,
  emailTemplateSchema,
  idParamSchema,
  listSuppressionsQuerySchema,
  pageQuerySchema,
  previewContextQuerySchema,
  previewContextSchema,
  sendSingleEmailResponseSchema,
  sendSingleEmailSchema,
  snippetListSchema,
  snippetSchema,
  suppressionPageSchema,
  suppressionSchema,
  testSendResponseSchema,
  testSendSchema,
  updateEmailSettingsSchema,
  updateEmailTemplateSchema,
  updateSnippetSchema,
} from '@amable/api-types';
import { crmRoute, json, jsonBody } from '../crm/api/core';
import { audit, getAuth, type AppEnv } from '../middleware';
import { callMail } from './http';
import { emailPreviewContext } from './liquid-api';

/** Email REST v2 routes (templates, snippets, suppressions, messages, settings), relative to /api/v2/t/{slug}. */
export function registerEmailRoutes(app: OpenAPIHono<AppEnv>): void {
  // ------------------------------------------------------------- templates
  const templates = ['Email templates'];
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/emailTemplates',
      tags: templates,
      summary: 'List email templates',
      request: { query: pageQuerySchema },
      responses: { 200: json(emailTemplatePageSchema, 'A page of templates, most recently updated first') },
    }),
    async (c) => c.json(await callMail(c, 'templates.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'post',
      path: '/emailTemplates',
      tags: templates,
      summary: 'Create an email template (Tiptap JSON; the compiled HTML is cached)',
      request: { body: jsonBody(createEmailTemplateSchema) },
      responses: { 201: json(emailTemplateSchema, 'The template') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'templates.create', { ...c.req.valid('json'), createdBy: getAuth(c).user.id }),
        201,
      ),
  );
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/emailTemplates/{id}',
      tags: templates,
      summary: 'Get an email template',
      request: { params: idParamSchema },
      responses: { 200: json(emailTemplateSchema, 'The template') },
    }),
    async (c) => c.json(await callMail(c, 'templates.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'patch',
      path: '/emailTemplates/{id}',
      tags: templates,
      summary: 'Update an email template',
      request: { params: idParamSchema, body: jsonBody(updateEmailTemplateSchema) },
      responses: { 200: json(emailTemplateSchema, 'The template') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'templates.update', { id: c.req.valid('param').id, data: c.req.valid('json') }),
        200,
      ),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'delete',
      path: '/emailTemplates/{id}',
      tags: templates,
      summary: 'Delete an email template',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callMail(c, 'templates.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'post',
      path: '/emailTemplates/{id}/test',
      tags: templates,
      summary: 'Send the template to tenant members only, marked [Test]',
      request: { params: idParamSchema, body: jsonBody(testSendSchema) },
      responses: { 200: json(testSendResponseSchema, 'Test emails sent') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'templates.testSend', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
          callerId: getAuth(c).user.id,
        }),
        200,
      ),
  );

  // -------------------------------------------------------------- snippets
  const snippets = ['Dynamic Content snippets'];
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/emailSnippets',
      tags: snippets,
      summary: 'List Dynamic Content snippets (Liquid partials, `{{ snippets.<key> }}`)',
      responses: { 200: json(snippetListSchema, 'Every snippet') },
    }),
    async (c) => c.json(await callMail(c, 'snippets.list', {}), 200),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'post',
      path: '/emailSnippets',
      tags: snippets,
      summary: 'Create a snippet',
      request: { body: jsonBody(createSnippetSchema) },
      responses: { 201: json(snippetSchema, 'The snippet') },
    }),
    async (c) => c.json(await callMail(c, 'snippets.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/emailSnippets/{id}',
      tags: snippets,
      summary: 'Get a snippet',
      request: { params: idParamSchema },
      responses: { 200: json(snippetSchema, 'The snippet') },
    }),
    async (c) => c.json(await callMail(c, 'snippets.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'patch',
      path: '/emailSnippets/{id}',
      tags: snippets,
      summary: 'Update a snippet',
      request: { params: idParamSchema, body: jsonBody(updateSnippetSchema) },
      responses: { 200: json(snippetSchema, 'The snippet') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'snippets.update', { id: c.req.valid('param').id, data: c.req.valid('json') }),
        200,
      ),
  );
  app.openapi(
    crmRoute('templates:write', {
      method: 'delete',
      path: '/emailSnippets/{id}',
      tags: snippets,
      summary: 'Delete a snippet',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callMail(c, 'snippets.delete', c.req.valid('param')), 200),
  );

  // ---------------------------------------------------------- suppressions
  const supp = ['Suppressions'];
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/suppressions',
      tags: supp,
      summary: 'List suppressed addresses',
      request: { query: listSuppressionsQuerySchema },
      responses: { 200: json(suppressionPageSchema, 'A page of suppressions, newest first') },
    }),
    async (c) => c.json(await callMail(c, 'suppressions.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('suppressions:write', {
      method: 'post',
      path: '/suppressions',
      tags: supp,
      summary: 'Suppress an address',
      request: { body: jsonBody(addSuppressionSchema) },
      responses: { 201: json(suppressionSchema, 'The suppression') },
    }),
    async (c) => {
      const result = await callMail(c, 'suppressions.add', c.req.valid('json'));
      await audit(c, 'email.suppression_added', { target: result.email });
      return c.json(result, 201);
    },
  );
  app.openapi(
    crmRoute('suppressions:write', {
      method: 'delete',
      path: '/suppressions/{email}',
      tags: supp,
      summary: 'Remove an address from the suppression list',
      request: { params: z.object({ email: z.string().min(3).max(254) }) },
      responses: { 200: json(z.object({ email: z.string(), deleted: z.literal(true) }), 'Removed') },
    }),
    async (c) => {
      const result = await callMail(c, 'suppressions.remove', c.req.valid('param'));
      await audit(c, 'email.suppression_removed', { target: result.email });
      return c.json(result, 200);
    },
  );

  // --------------------------------------------------------------- messages
  const messages = ['Email messages'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/contacts/{id}/emails',
      tags: messages,
      summary: 'Emails sent to a contact (status, opens, clicks)',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(emailMessagePageSchema, 'A page of messages, newest first') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'messages.byContact', { contactId: c.req.valid('param').id, ...c.req.valid('query') }),
        200,
      ),
  );
  app.openapi(
    crmRoute('emails:send_single', {
      method: 'post',
      path: '/contacts/{id}/emails',
      tags: messages,
      summary: 'Send one email to a contact (queued; same checks as automations)',
      request: { params: idParamSchema, body: jsonBody(sendSingleEmailSchema) },
      responses: { 202: json(sendSingleEmailResponseSchema, 'Queued') },
    }),
    async (c) =>
      c.json(
        await callMail(c, 'messages.sendSingle', {
          contactId: c.req.valid('param').id,
          userId: getAuth(c).user.id,
          data: c.req.valid('json'),
        }),
        202,
      ),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/emailMessages/{id}',
      tags: messages,
      summary: 'Get one email message',
      request: { params: idParamSchema },
      responses: { 200: json(emailMessageSchema, 'The message') },
    }),
    async (c) => c.json(await callMail(c, 'messages.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/email/previewContext',
      tags: messages,
      summary: 'Liquid context of a real contact, for previews',
      description:
        'Built like `POST /liquid/preview`: sensitive custom fields are masked for callers without `contacts:read_sensitive`; `timezone` is the default zone of the `date` filter when sending.',
      request: { query: previewContextQuerySchema },
      responses: { 200: json(previewContextSchema, 'The context') },
    }),
    async (c) => c.json(await emailPreviewContext(c, c.req.valid('query').contact_id), 200),
  );

  // --------------------------------------------------------------- settings
  const settings = ['Email settings'];
  app.openapi(
    crmRoute('broadcasts:read', {
      method: 'get',
      path: '/email/settings',
      tags: settings,
      summary: 'Sender, sending-domain state, warm-up, suspension and health',
      responses: { 200: json(emailSettingsSchema, 'The settings') },
    }),
    async (c) => c.json(await callMail(c, 'settings.get', {}), 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/email/settings',
      tags: settings,
      summary: 'Update sender settings',
      request: { body: jsonBody(updateEmailSettingsSchema) },
      responses: { 200: json(emailSettingsSchema, 'The settings') },
    }),
    async (c) => {
      const result = await callMail(c, 'settings.update', c.req.valid('json'));
      await audit(c, 'email.settings_updated');
      return c.json(result, 200);
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/email/settings/resume',
      tags: settings,
      summary: 'Lift an automatic sending suspension',
      responses: { 200: json(emailSettingsSchema, 'The settings') },
    }),
    async (c) => {
      const result = await callMail(c, 'settings.resume', {});
      await audit(c, 'email.sending_resumed');
      return c.json(result, 200);
    },
  );
}
