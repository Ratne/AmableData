import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  activitySchema,
  companySchema,
  createCompanySchema,
  createCustomFieldGroupSchema,
  createCustomFieldSchema,
  createCustomFieldTabSchema,
  createNoteSchema,
  createTagCategorySchema,
  createTagSchema,
  CUSTOM_FIELD_ENTITY_BY_PATH,
  customFieldEntityPathSchema,
  customFieldGroupSchema,
  customFieldLayoutSchema,
  customFieldSchema,
  customFieldTabSchema,
  deletedResponseSchema,
  idParamSchema,
  idSchema,
  listCompaniesQuerySchema,
  listNotesQuerySchema,
  listTagsQuerySchema,
  noteSchema,
  pageOf,
  pageQuerySchema,
  tagCategorySchema,
  tagContactsResultSchema,
  tagContactsSchema,
  tagSchema,
  updateCompanySchema,
  updateCustomFieldGroupSchema,
  updateCustomFieldSchema,
  updateCustomFieldTabSchema,
  updateNoteSchema,
  updateTagCategorySchema,
  updateTagSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from './core';

const entityParam = z.object({ entity: customFieldEntityPathSchema });
const entityIdParam = z.object({ entity: customFieldEntityPathSchema, id: idSchema });

export function registerRecordRoutes(app: OpenAPIHono<AppEnv>): void {
  // ------------------------------------------------------------- companies
  const companies = ['Companies'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/companies',
      tags: companies,
      summary: 'List companies',
      request: { query: listCompaniesQuerySchema },
      responses: { 200: json(pageOf(companySchema), 'A page of companies, by name') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/companies',
      tags: companies,
      summary: 'Create a company',
      request: { body: jsonBody(createCompanySchema) },
      responses: { 201: json(companySchema, 'The company') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/companies/{id}',
      tags: companies,
      summary: 'Get a company',
      request: { params: idParamSchema },
      responses: { 200: json(companySchema, 'The company') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'patch',
      path: '/companies/{id}',
      tags: companies,
      summary: 'Update a company',
      request: { params: idParamSchema, body: jsonBody(updateCompanySchema) },
      responses: { 200: json(companySchema, 'The company') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'companies.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'delete',
      path: '/companies/{id}',
      tags: companies,
      summary: 'Soft-delete a company',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/companies/{id}/restore',
      tags: companies,
      summary: 'Restore a company',
      request: { params: idParamSchema },
      responses: { 200: json(companySchema, 'The company') },
    }),
    async (c) => c.json(await callCrm(c, 'companies.restore', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/companies/{id}/timeline',
      tags: companies,
      summary: 'Activity timeline of a company',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(pageOf(activitySchema), 'Activities, newest first') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'timeline', {
          subject: 'company',
          id: c.req.valid('param').id,
          ...c.req.valid('query'),
        }),
        200,
      ),
  );

  // ------------------------------------------------------------------ tags
  const tagTags = ['Tags'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/tagCategories',
      tags: tagTags,
      summary: 'List tag categories',
      responses: { 200: json(z.object({ data: z.array(tagCategorySchema) }), 'Categories') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'tagCategories.list', {}) }, 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/tagCategories',
      tags: tagTags,
      summary: 'Create a tag category',
      request: { body: jsonBody(createTagCategorySchema) },
      responses: { 201: json(tagCategorySchema, 'The category') },
    }),
    async (c) => c.json(await callCrm(c, 'tagCategories.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/tagCategories/{id}',
      tags: tagTags,
      summary: 'Update a tag category',
      request: { params: idParamSchema, body: jsonBody(updateTagCategorySchema) },
      responses: { 200: json(tagCategorySchema, 'The category') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'tagCategories.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/tagCategories/{id}',
      tags: tagTags,
      summary: 'Delete a tag category (its tags become uncategorized)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'tagCategories.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/tags',
      tags: tagTags,
      summary: 'List tags',
      request: { query: listTagsQuerySchema },
      responses: { 200: json(pageOf(tagSchema), 'A page of tags, by name') },
    }),
    async (c) => c.json(await callCrm(c, 'tags.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('tags:write', {
      method: 'post',
      path: '/tags',
      tags: tagTags,
      summary: 'Create a tag',
      request: { body: jsonBody(createTagSchema) },
      responses: { 201: json(tagSchema, 'The tag') },
    }),
    async (c) => c.json(await callCrm(c, 'tags.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/tags/{id}',
      tags: tagTags,
      summary: 'Get a tag',
      request: { params: idParamSchema },
      responses: { 200: json(tagSchema, 'The tag') },
    }),
    async (c) => c.json(await callCrm(c, 'tags.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('tags:write', {
      method: 'patch',
      path: '/tags/{id}',
      tags: tagTags,
      summary: 'Update a tag',
      request: { params: idParamSchema, body: jsonBody(updateTagSchema) },
      responses: { 200: json(tagSchema, 'The tag') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'tags.update', { id: c.req.valid('param').id, data: c.req.valid('json') }),
        200,
      ),
  );
  app.openapi(
    crmRoute('tags:write', {
      method: 'delete',
      path: '/tags/{id}',
      tags: tagTags,
      summary: 'Delete a tag (contacts stop having it; restorable)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'tags.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('tags:write', {
      method: 'post',
      path: '/tags/{id}/restore',
      tags: tagTags,
      summary: 'Restore a deleted tag (with its contact links)',
      request: { params: idParamSchema },
      responses: { 200: json(tagSchema, 'The restored tag') },
    }),
    async (c) => c.json(await callCrm(c, 'tags.restore', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/tags/{id}/apply',
      tags: tagTags,
      summary: 'Apply a tag to many contacts',
      description: 'Emits one `contact.tag_applied` event per contact that did not have the tag.',
      request: { params: idParamSchema, body: jsonBody(tagContactsSchema) },
      responses: { 200: json(tagContactsResultSchema, 'Result') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'tags.apply', {
          tagId: c.req.valid('param').id,
          contactIds: c.req.valid('json').contact_ids,
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/tags/{id}/remove',
      tags: tagTags,
      summary: 'Remove a tag from many contacts',
      request: { params: idParamSchema, body: jsonBody(tagContactsSchema) },
      responses: { 200: json(tagContactsResultSchema, 'Result') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'tags.remove', {
          tagId: c.req.valid('param').id,
          contactIds: c.req.valid('json').contact_ids,
        }),
        200,
      ),
  );

  // ----------------------------------------------------------------- notes
  const notes = ['Notes'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/notes',
      tags: notes,
      summary: 'List notes',
      request: { query: listNotesQuerySchema },
      responses: { 200: json(pageOf(noteSchema), 'A page of notes, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'notes.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'post',
      path: '/notes',
      tags: notes,
      summary: 'Add a note',
      description: '`body` is a rich text document (editor JSON, max 256 KB).',
      request: { body: jsonBody(createNoteSchema) },
      responses: { 201: json(noteSchema, 'The note') },
    }),
    async (c) => c.json(await callCrm(c, 'notes.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/notes/{id}',
      tags: notes,
      summary: 'Get a note',
      request: { params: idParamSchema },
      responses: { 200: json(noteSchema, 'The note') },
    }),
    async (c) => c.json(await callCrm(c, 'notes.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'patch',
      path: '/notes/{id}',
      tags: notes,
      summary: 'Update a note',
      request: { params: idParamSchema, body: jsonBody(updateNoteSchema) },
      responses: { 200: json(noteSchema, 'The note') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'notes.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('contacts:write', {
      method: 'delete',
      path: '/notes/{id}',
      tags: notes,
      summary: 'Delete a note',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'notes.delete', c.req.valid('param')), 200),
  );

  // --------------------------------------------------------- custom fields
  const cf = ['Custom fields'];
  const entityOf = (path: z.infer<typeof customFieldEntityPathSchema>) =>
    CUSTOM_FIELD_ENTITY_BY_PATH[path];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/customFields/{entity}',
      tags: cf,
      summary: 'List custom fields of an entity',
      request: { params: entityParam },
      responses: { 200: json(z.object({ data: z.array(customFieldSchema) }), 'Fields') },
    }),
    async (c) =>
      c.json(
        {
          data: await callCrm(c, 'customFields.list', {
            entity: entityOf(c.req.valid('param').entity),
          }),
        },
        200,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/customFields/{entity}',
      tags: cf,
      summary: 'Create a custom field',
      description:
        'One of 24 types; DROPDOWN/RADIO/LIST_BOX/DRILLDOWN need options. Values are validated per type.',
      request: { params: entityParam, body: jsonBody(createCustomFieldSchema) },
      responses: { 201: json(customFieldSchema, 'The field') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'customFields.create', {
          entity: entityOf(c.req.valid('param').entity),
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/customFields/{entity}/layout',
      tags: cf,
      summary: 'Tabs, groups and fields of an entity',
      request: { params: entityParam },
      responses: { 200: json(customFieldLayoutSchema, 'Layout') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'customFields.layout', { entity: entityOf(c.req.valid('param').entity) }),
        200,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/customFields/{entity}/tabs',
      tags: cf,
      summary: 'Create a custom field tab',
      request: { params: entityParam, body: jsonBody(createCustomFieldTabSchema) },
      responses: { 201: json(customFieldTabSchema, 'The tab') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'customFields.createTab', {
          entity: entityOf(c.req.valid('param').entity),
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/customFields/{entity}/tabs/{id}',
      tags: cf,
      summary: 'Update a custom field tab',
      request: { params: entityIdParam, body: jsonBody(updateCustomFieldTabSchema) },
      responses: { 200: json(customFieldTabSchema, 'The tab') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(
        await callCrm(c, 'customFields.updateTab', {
          entity: entityOf(entity),
          id,
          data: c.req.valid('json'),
        }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/customFields/{entity}/tabs/{id}',
      tags: cf,
      summary: 'Delete a custom field tab (fields become ungrouped)',
      request: { params: entityIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(
        await callCrm(c, 'customFields.deleteTab', { entity: entityOf(entity), id }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/customFields/{entity}/groups',
      tags: cf,
      summary: 'Create a custom field group inside a tab',
      request: { params: entityParam, body: jsonBody(createCustomFieldGroupSchema) },
      responses: { 201: json(customFieldGroupSchema, 'The group') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'customFields.createGroup', {
          entity: entityOf(c.req.valid('param').entity),
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/customFields/{entity}/groups/{id}',
      tags: cf,
      summary: 'Update a custom field group',
      request: { params: entityIdParam, body: jsonBody(updateCustomFieldGroupSchema) },
      responses: { 200: json(customFieldGroupSchema, 'The group') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(
        await callCrm(c, 'customFields.updateGroup', {
          entity: entityOf(entity),
          id,
          data: c.req.valid('json'),
        }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/customFields/{entity}/groups/{id}',
      tags: cf,
      summary: 'Delete a custom field group',
      request: { params: entityIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(
        await callCrm(c, 'customFields.deleteGroup', { entity: entityOf(entity), id }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/customFields/{entity}/{id}',
      tags: cf,
      summary: 'Get a custom field',
      request: { params: entityIdParam },
      responses: { 200: json(customFieldSchema, 'The field') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(await callCrm(c, 'customFields.get', { entity: entityOf(entity), id }), 200);
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/customFields/{entity}/{id}',
      tags: cf,
      summary: 'Update a custom field (type and key are immutable)',
      request: { params: entityIdParam, body: jsonBody(updateCustomFieldSchema) },
      responses: { 200: json(customFieldSchema, 'The field') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(
        await callCrm(c, 'customFields.update', {
          entity: entityOf(entity),
          id,
          data: c.req.valid('json'),
        }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/customFields/{entity}/{id}',
      tags: cf,
      summary: 'Delete a custom field and its values',
      request: { params: entityIdParam },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const { entity, id } = c.req.valid('param');
      return c.json(await callCrm(c, 'customFields.delete', { entity: entityOf(entity), id }), 200);
    },
  );
}
