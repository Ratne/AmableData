import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createNoteSchema,
  deletedResponseSchema,
  idParamSchema,
  listNotesQuerySchema,
  noteSchema,
  pageOf,
  updateNoteSchema,
} from '@amable/api-types';
import type { AppEnv } from '../../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../core';

export function registerNotesRoutes(app: OpenAPIHono<AppEnv>): void {
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
}
