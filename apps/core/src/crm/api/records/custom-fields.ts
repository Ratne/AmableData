import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createCustomFieldGroupSchema,
  createCustomFieldSchema,
  createCustomFieldTabSchema,
  CUSTOM_FIELD_ENTITY_BY_PATH,
  customFieldEntityPathSchema,
  customFieldGroupSchema,
  customFieldLayoutSchema,
  customFieldSchema,
  customFieldTabSchema,
  deletedResponseSchema,
  updateCustomFieldGroupSchema,
  updateCustomFieldSchema,
  updateCustomFieldTabSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../core';
import { entityParam, entityIdParam } from './shared';

export function registerCustomFieldsRoutes(app: OpenAPIHono<AppEnv>): void {
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
