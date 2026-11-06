import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createTagCategorySchema,
  createTagSchema,
  deletedResponseSchema,
  idParamSchema,
  listTagsQuerySchema,
  pageOf,
  tagCategorySchema,
  tagContactsResultSchema,
  tagContactsSchema,
  tagSchema,
  updateTagCategorySchema,
  updateTagSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../core';

export function registerTagsRoutes(app: OpenAPIHono<AppEnv>): void {
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
}
