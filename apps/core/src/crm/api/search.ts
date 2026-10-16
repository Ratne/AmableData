import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createImportSchema,
  createSavedSearchSchema,
  deletedResponseSchema,
  executeSavedSearchSchema,
  GLOBAL_SEARCH_TYPES,
  globalSearchQuerySchema,
  globalSearchResponseSchema,
  idParamSchema,
  importJobSchema,
  savedSearchSchema,
  searchEntitySchema,
  searchQuerySchema,
  searchResultSchema,
  updateSavedSearchSchema,
} from '@amable/api-types';
import type { Context } from 'hono';
import type { AppEnv } from '../../middleware';
import { CrmError } from '../errors';
import { CsvParser, detectDelimiter } from '../import/csv';
import type { SearchEntityKind } from '../search/index-store';
import { callCrm, crmRoute, json, jsonBody } from './core';

const IMPORT_BATCH_ROWS = 250;
const IMPORT_MAX_ROWS = 100_000;
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

const fieldDescriptionSchema = z.object({
  field: z.string(),
  kind: z.string(),
  operators: z.array(z.string()),
  sortable: z.boolean(),
  selectable: z.boolean(),
});

export function registerSearchRoutes(app: OpenAPIHono<AppEnv>): void {
  const search = ['Search'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'post',
      path: '/search',
      tags: search,
      summary: 'Run a query-builder search',
      description:
        'Full-text `q` + boolean filter tree (field operators per type, tags any/all/none, custom fields as `custom.<key>`), selected columns, sort and cursor pagination.',
      request: { body: jsonBody(searchQuerySchema) },
      responses: { 200: json(searchResultSchema, 'Matching rows') },
    }),
    async (c) => c.json(await callCrm(c, 'search.query', c.req.valid('json')), 200),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/search',
      tags: search,
      summary: 'Global full-text search across contacts, companies and notes',
      request: { query: globalSearchQuerySchema },
      responses: { 200: json(globalSearchResponseSchema, 'Hits, best first') },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const requested = (query.types ?? GLOBAL_SEARCH_TYPES.join(','))
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is SearchEntityKind =>
          (GLOBAL_SEARCH_TYPES as readonly string[]).includes(t),
        );
      return c.json(
        await callCrm(c, 'search.global', { q: query.q, types: requested, limit: query.limit }),
        200,
      );
    },
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/search/fields',
      tags: search,
      summary: 'Filterable/selectable fields and their operators',
      request: { query: z.object({ entity: searchEntitySchema }) },
      responses: { 200: json(z.object({ data: z.array(fieldDescriptionSchema) }), 'Fields') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'search.fields', c.req.valid('query')) }, 200),
  );

  // -------------------------------------------------------- saved searches
  const saved = ['Saved searches'];
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/savedSearches',
      tags: saved,
      summary: 'List saved searches (shared + own)',
      responses: { 200: json(z.object({ data: z.array(savedSearchSchema) }), 'Saved searches') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'savedSearches.list', {}) }, 200),
  );
  app.openapi(
    crmRoute('saved_searches:write', {
      method: 'post',
      path: '/savedSearches',
      tags: saved,
      summary: 'Save a search (reusable as a segment)',
      request: { body: jsonBody(createSavedSearchSchema) },
      responses: { 201: json(savedSearchSchema, 'The saved search') },
    }),
    async (c) => c.json(await callCrm(c, 'savedSearches.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'get',
      path: '/savedSearches/{id}',
      tags: saved,
      summary: 'Get a saved search',
      request: { params: idParamSchema },
      responses: { 200: json(savedSearchSchema, 'The saved search') },
    }),
    async (c) => c.json(await callCrm(c, 'savedSearches.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('saved_searches:write', {
      method: 'patch',
      path: '/savedSearches/{id}',
      tags: saved,
      summary: 'Update a saved search',
      request: { params: idParamSchema, body: jsonBody(updateSavedSearchSchema) },
      responses: { 200: json(savedSearchSchema, 'The saved search') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'savedSearches.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('saved_searches:write', {
      method: 'delete',
      path: '/savedSearches/{id}',
      tags: saved,
      summary: 'Delete a saved search',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'savedSearches.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:read', {
      method: 'post',
      path: '/savedSearches/{id}/execute',
      tags: saved,
      summary: 'Execute a saved search',
      request: {
        params: idParamSchema,
        body: {
          required: false,
          content: { 'application/json': { schema: executeSavedSearchSchema } },
        },
      },
      responses: { 200: json(searchResultSchema, 'Matching rows') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'savedSearches.execute', {
          id: c.req.valid('param').id,
          options: c.req.valid('json'),
        }),
        200,
      ),
  );

  // ----------------------------------------------------------- CSV import
  const imports = ['Imports'];
  app.openapi(
    crmRoute('contacts:import', {
      method: 'post',
      path: '/imports',
      tags: imports,
      summary: 'Create a contact import job (column mapping)',
      description:
        'Step 1 of 2. Map CSV headers to contact fields, `tags`, `custom.<key>` or `ignore`. Then upload the CSV with PUT /imports/{id}/csv.',
      request: { body: jsonBody(createImportSchema) },
      responses: { 201: json(importJobSchema, 'The pending import') },
    }),
    async (c) => c.json(await callCrm(c, 'imports.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('contacts:import', {
      method: 'get',
      path: '/imports/{id}',
      tags: imports,
      summary: 'Get an import job',
      request: { params: idParamSchema },
      responses: { 200: json(importJobSchema, 'The import') },
    }),
    async (c) => c.json(await callCrm(c, 'imports.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('contacts:import', {
      method: 'put',
      path: '/imports/{id}/csv',
      tags: imports,
      summary: 'Upload the CSV (streamed)',
      description:
        'Step 2 of 2. The body is streamed and processed in batches of 250 rows (max 100,000 rows / 50 MB). Delimiter (`,` `;` or tab) is detected from the header. Rows matching an existing contact by email update it (unless disabled in the job options).',
      request: {
        params: idParamSchema,
        body: { required: true, content: { 'text/csv': { schema: z.string() } } },
      },
      responses: { 200: json(importJobSchema, 'The completed import') },
    }),
    async (c) => c.json(await streamCsvImport(c, c.req.valid('param').id), 200),
  );
}

async function streamCsvImport(c: Context<AppEnv>, importId: string) {
  const job = await callCrm(c, 'imports.get', { id: importId });
  if (job.status !== 'pending')
    throw new CrmError('conflict', `import ${importId} is ${job.status}`);
  const body = c.req.raw.body;
  if (body === null) throw new CrmError('bad_request', 'empty body: send the CSV file');

  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let parser: CsvParser | null = null;
  let header: string[] | null = null;
  let batch: string[][] = [];
  let nextRowNumber = 1;
  let rows = 0;
  let bytes = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0 || header === null) return;
    const firstRowNumber = nextRowNumber;
    nextRowNumber += batch.length;
    const current = batch;
    batch = [];
    await callCrm(c, 'imports.rows', { importId, header, rows: current, firstRowNumber });
  };
  const accept = async (parsed: string[][]): Promise<void> => {
    for (const row of parsed) {
      if (header === null) {
        header = row.map((h) => h.trim());
        continue;
      }
      rows += 1;
      if (rows > IMPORT_MAX_ROWS)
        throw new CrmError('payload_too_large', `more than ${IMPORT_MAX_ROWS} rows`);
      batch.push(row);
      if (batch.length >= IMPORT_BATCH_ROWS) await flush();
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > IMPORT_MAX_BYTES)
        throw new CrmError('payload_too_large', 'CSV larger than 50 MB');
      if (parser === null) parser = new CsvParser(detectDelimiter(value.split('\n', 1)[0] ?? ''));
      await accept(parser.push(value));
    }
    if (parser !== null) await accept(parser.finish());
    await flush();
    if (header === null) throw new CrmError('bad_request', 'the CSV has no header row');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await callCrm(c, 'imports.finish', { importId, error: message });
    if (error instanceof CrmError) throw error;
    throw new CrmError('bad_request', message);
  }
  return callCrm(c, 'imports.finish', { importId });
}
