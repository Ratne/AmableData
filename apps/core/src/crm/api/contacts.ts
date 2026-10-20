import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  activitySchema,
  applyTagsSchema,
  contactCountsSchema,
  contactSchema,
  contactTagSchema,
  createContactSchema,
  createLeadSourceSchema,
  deletedResponseSchema,
  idParamSchema,
  idSchema,
  leadSourceSchema,
  listContactTagsQuerySchema,
  listContactsQuerySchema,
  mergeContactsSchema,
  pageOf,
  pageQuerySchema,
  updateContactSchema,
  type Contact,
} from '@amable/api-types';
import type { Context } from 'hono';
import { callEngine } from '../../automation/api/routes';
import { callMail } from '../../email/http';
import { validateAndApply } from '../../apps/validate-hook';
import { defer, getAuth, getTenant, type AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from './core';

const tags = ['Contacts'];

/** A count read from another Durable Object: `null` when it fails, so the tabs still get the rest. */
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.warn('contact tab count unavailable', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Apps validate their own writes; everyone else's emails/phones go through contact.validate. */
async function validateLater(c: Context<AppEnv>, contact: Contact): Promise<void> {
  if (getAuth(c).kind === 'app') return;
  const email = (contact.emails.find((e) => e.is_primary) ?? contact.emails[0])?.email ?? null;
  const phone = contact.phones[0]?.number ?? null;
  if (email === null && phone === null) return;
  await defer(c, validateAndApply(c.env, getTenant(c).tenant.id, contact.id, { email, phone }, 'crm'));
}

export function registerContactRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/contacts',
      tags,
      summary: 'List contacts',
      description:
        'Cursor-paginated, newest first. `q` uses the full-text index; `email`, `tag_id`, `owner_id`, `company_id` and `updated_since` filter.',
      request: { query: listContactsQuerySchema },
      responses: { 200: json(pageOf(contactSchema), 'A page of contacts') },
    }),
    async (c) => c.json(await callCrm(c, 'contacts.list', c.req.valid('query')), 200),
  );

  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/contacts',
      tags,
      summary: 'Create a contact',
      request: { body: jsonBody(createContactSchema) },
      responses: { 201: json(contactSchema, 'The created contact') },
    }),
    async (c) => {
      const contact = await callCrm(c, 'contacts.create', c.req.valid('json'));
      await validateLater(c, contact);
      return c.json(contact, 201);
    },
  );

  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/contacts/{id}',
      tags,
      summary: 'Get a contact',
      request: {
        params: idParamSchema,
        query: z.object({ include_deleted: z.enum(['true', 'false']).optional() }),
      },
      responses: { 200: json(contactSchema, 'The contact') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'contacts.get', {
          id: c.req.valid('param').id,
          includeDeleted: c.req.valid('query').include_deleted === 'true',
        }),
        200,
      ),
  );

  app.openapi(
    crmRoute('contacts:write', {
      method: 'patch',
      path: '/contacts/{id}',
      tags,
      summary: 'Update a contact',
      description:
        'Lists (emails, phones, addresses) are replaced when present; `custom_fields` are merged, `null` clears.',
      request: { params: idParamSchema, body: jsonBody(updateContactSchema) },
      responses: { 200: json(contactSchema, 'The updated contact') },
    }),
    async (c) => {
      const data = c.req.valid('json');
      const contact = await callCrm(c, 'contacts.update', { id: c.req.valid('param').id, data });
      if (data.emails !== undefined || data.phones !== undefined) await validateLater(c, contact);
      return c.json(contact, 200);
    },
  );

  app.openapi(
    crmRoute('contacts:write', {
      method: 'delete',
      path: '/contacts/{id}',
      tags,
      summary: 'Soft-delete a contact',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'contacts.delete', c.req.valid('param')), 200),
  );

  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/contacts/{id}/restore',
      tags,
      summary: 'Restore a soft-deleted contact',
      request: { params: idParamSchema },
      responses: { 200: json(contactSchema, 'The restored contact') },
    }),
    async (c) => c.json(await callCrm(c, 'contacts.restore', c.req.valid('param')), 200),
  );

  app.openapi(
    crmRoute('contacts:merge', {
      method: 'post',
      path: '/contacts/{id}/merge',
      tags,
      summary: 'Merge contacts into this one',
      description:
        'Fills empty fields from the sources, unions emails/phones/tags, moves notes, tasks, appointments, opportunities and timeline, then soft-deletes the sources.',
      request: { params: idParamSchema, body: jsonBody(mergeContactsSchema) },
      responses: { 200: json(contactSchema, 'The surviving contact') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'contacts.merge', {
          targetId: c.req.valid('param').id,
          sourceIds: c.req.valid('json').source_ids,
        }),
        200,
      ),
  );

  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/contacts/{id}/tags',
      tags,
      summary: 'Apply tags to a contact',
      request: { params: idParamSchema, body: jsonBody(applyTagsSchema) },
      responses: { 200: json(contactSchema, 'The contact with its tags') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'contacts.applyTags', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );

  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/contacts/{id}/tags',
      tags,
      summary: "List a contact's tags",
      description:
        'Cursor-paginated by name (case-insensitive). `q` keeps tags whose name contains it, `category_id` filters by category.',
      request: { params: idParamSchema, query: listContactTagsQuerySchema },
      responses: { 200: json(pageOf(contactTagSchema), 'A page of the contact tags') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'contacts.tags', {
          id: c.req.valid('param').id,
          ...c.req.valid('query'),
        }),
        200,
      ),
  );

  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/contacts/{id}/counts',
      tags,
      summary: 'Counts for the contact page tabs',
      description:
        'Tags, notes, open tasks, appointments, opportunities, orders and form submissions of the contact (TenantDb), emails (MailDb) and active/total automation enrollments (Engine), read in parallel. Counts of records the caller may not read are omitted; so are the email and automation counts when their store does not answer (the response never fails for them).',
      request: { params: idParamSchema },
      responses: { 200: json(contactCountsSchema, 'Counts') },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const tenant = getTenant(c);
      const canAutomations = tenant.can('automations:read');
      const [counts, emails, enrollments] = await Promise.all([
        callCrm(c, 'contacts.counts', { id }),
        optional(() => callMail(c, 'messages.countByContact', { contactId: id })),
        canAutomations
          ? optional(() => callEngine(c, 'contacts.enrollmentCounts', { contactId: id }))
          : Promise.resolve(null),
      ]);
      return c.json(
        {
          tags: counts.tags,
          notes: counts.notes,
          ...(tenant.can('tasks:read')
            ? { tasks_open: counts.tasks_open, appointments: counts.appointments }
            : {}),
          ...(tenant.can('opportunities:read') ? { opportunities: counts.opportunities } : {}),
          ...(tenant.can('orders:read') ? { orders: counts.orders } : {}),
          ...(tenant.can('forms:read') ? { submissions: counts.submissions } : {}),
          ...(tenant.can('esign:read') ? { signatures: counts.signatures } : {}),
          ...(emails === null ? {} : { emails: emails.count }),
          ...(enrollments === null
            ? {}
            : { automations_active: enrollments.active, automations_total: enrollments.total }),
        },
        200,
      );
    },
  );

  app.openapi(
    crmRoute('contacts:write', {
      method: 'delete',
      path: '/contacts/{id}/tags/{tagId}',
      tags,
      summary: 'Remove a tag from a contact',
      request: { params: z.object({ id: idSchema, tagId: idSchema }) },
      responses: { 200: json(contactSchema, 'The contact with its tags') },
    }),
    async (c) => c.json(await callCrm(c, 'contacts.removeTag', c.req.valid('param')), 200),
  );

  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/contacts/{id}/timeline',
      tags,
      summary: 'Activity timeline of a contact',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(pageOf(activitySchema), 'Activities, newest first') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'timeline', {
          subject: 'contact',
          id: c.req.valid('param').id,
          ...c.req.valid('query'),
        }),
        200,
      ),
  );

  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/leadSources',
      tags,
      summary: 'List lead sources',
      responses: { 200: json(z.object({ data: z.array(leadSourceSchema) }), 'Lead sources') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'leadSources.list', {}) }, 200),
  );

  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/leadSources',
      tags,
      summary: 'Create a lead source',
      request: { body: jsonBody(createLeadSourceSchema) },
      responses: { 201: json(leadSourceSchema, 'The lead source') },
    }),
    async (c) => c.json(await callCrm(c, 'leadSources.create', c.req.valid('json')), 201),
  );
}
