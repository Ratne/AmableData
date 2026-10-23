import { PERMISSIONS, type Permission } from '@amable/core';
import { listOperations, mergedOpenApiDocument, OPENAPI_SOURCES } from '../developers/openapi';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How an operation travels: JSON in/out, a raw request body (CSV, images, PDF),
 * or a WebSocket upgrade (edit locks), which no MCP client can hold open.
 */
export type OperationTransport = 'json' | 'raw_body' | 'websocket';

export interface OperationParam {
  readonly name: string;
  readonly required: boolean;
  readonly schema: JsonObject;
  readonly description: string | null;
}

export interface CatalogOperation {
  /** `<module>.<method>_<path>`: stable across deploys as long as the route keeps its path. */
  readonly id: string;
  readonly module: string;
  readonly method: HttpMethod;
  /** Relative to `/api/v2/t/{slug}`. */
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly description: string;
  readonly permission: Permission | null;
  /** Besides `permission`, at least one of these. */
  readonly permissionAny: readonly Permission[] | null;
  readonly pathParams: readonly OperationParam[];
  readonly queryParams: readonly OperationParam[];
  readonly bodySchema: JsonObject | null;
  readonly bodyRequired: boolean;
  readonly bodyContentType: string | null;
  readonly responseSchema: JsonObject | null;
  readonly transport: OperationTransport;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
}

export interface CatalogModule {
  readonly id: string;
  readonly title: string;
}

export interface Catalog {
  readonly operations: readonly CatalogOperation[];
  readonly byId: ReadonlyMap<string, CatalogOperation>;
  readonly modules: readonly CatalogModule[];
}

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
const COMPONENT_REF = '#/components/schemas/';

/** POSTs that only read (search, previews, report runs, validation). */
const READ_ONLY_POSTS = new Set([
  'POST /search',
  'POST /savedSearches/{id}/execute',
  'POST /automations/{id}/validate',
  'POST /liquid/preview',
  'POST /reports/run',
  'POST /reports/{reportId}/run',
]);

/** Last path segments of actions that remove, revoke or stop something. */
const DESTRUCTIVE_ACTIONS = new Set([
  'cancel',
  'void',
  'unpublish',
  'merge',
  'archive',
  'refunds',
  'remove',
  'rotate',
  'rotate-secret',
  'rotateSecret',
  'secret',
  'webhook-secret',
  'pause',
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snake(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** `crm` + `GET /contacts/{id}/tags` → `crm.get_contacts_id_tags`. */
export function operationId(module: string, method: string, path: string): string {
  const parts = path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => snake(segment.replace(/[{}]/g, '')))
    .filter((segment) => segment !== '');
  return `${module}.${method.toLowerCase()}_${parts.join('_')}`;
}

/** Inlines `#/components/schemas/*` references (cycles stop at the second visit). */
export function resolveRefs(node: Json, schemas: JsonObject, seen: readonly string[] = []): Json {
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, schemas, seen));
  if (!isObject(node)) return node;
  const ref = node['$ref'];
  if (typeof ref === 'string' && ref.startsWith(COMPONENT_REF)) {
    const name = ref.slice(COMPONENT_REF.length);
    const target = schemas[name];
    if (target === undefined || seen.includes(name))
      return { type: 'object', description: `See ${name}` };
    return resolveRefs(target, schemas, [...seen, name]);
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) out[key] = resolveRefs(value, schemas, seen);
  return out;
}

function asPermission(value: Json | undefined): Permission | null {
  return typeof value === 'string' && PERMISSION_SET.has(value) ? (value as Permission) : null;
}

function params(
  operation: JsonObject,
  location: 'path' | 'query',
  schemas: JsonObject,
): OperationParam[] {
  const list = Array.isArray(operation['parameters']) ? operation['parameters'] : [];
  const out: OperationParam[] = [];
  for (const raw of list) {
    const param = resolveRefs(raw, schemas);
    if (!isObject(param) || param['in'] !== location || typeof param['name'] !== 'string') continue;
    const schema = isObject(param['schema']) ? param['schema'] : {};
    out.push({
      name: param['name'],
      required: location === 'path' || param['required'] === true,
      schema,
      description: typeof param['description'] === 'string' ? param['description'] : null,
    });
  }
  return out;
}

function successSchema(operation: JsonObject, schemas: JsonObject): JsonObject | null {
  const responses = isObject(operation['responses']) ? operation['responses'] : {};
  for (const [code, response] of Object.entries(responses)) {
    if (!code.startsWith('2') || !isObject(response) || !isObject(response['content'])) continue;
    const json = response['content']['application/json'];
    if (isObject(json) && isObject(json['schema'])) {
      const resolved = resolveRefs(json['schema'], schemas);
      return isObject(resolved) ? resolved : null;
    }
  }
  return null;
}

function buildOperation(
  method: string,
  path: string,
  operation: JsonObject,
  schemas: JsonObject,
): CatalogOperation {
  const upper = method.toUpperCase() as HttpMethod;
  const module =
    typeof operation['x-amable-module'] === 'string' ? operation['x-amable-module'] : 'crm';
  const summary = typeof operation['summary'] === 'string' ? operation['summary'] : '';
  const description = typeof operation['description'] === 'string' ? operation['description'] : '';
  const anyRaw = operation['x-amable-permission-any'];
  const permissionAny = Array.isArray(anyRaw)
    ? anyRaw.map((p) => asPermission(p)).filter((p): p is Permission => p !== null)
    : null;

  let bodySchema: JsonObject | null = null;
  let bodyContentType: string | null = null;
  let bodyRequired = false;
  const requestBody = operation['requestBody'];
  if (isObject(requestBody) && isObject(requestBody['content'])) {
    const [contentType, media] = Object.entries(requestBody['content'])[0] ?? [];
    if (contentType !== undefined) {
      bodyContentType = contentType;
      bodyRequired = requestBody['required'] === true;
      if (isObject(media) && isObject(media['schema'])) {
        const resolved = resolveRefs(media['schema'], schemas);
        bodySchema = isObject(resolved) ? resolved : null;
      }
    }
  }

  const transport: OperationTransport = /^WebSocket upgrade/i.test(summary)
    ? 'websocket'
    : bodyContentType !== null && bodyContentType !== 'application/json'
      ? 'raw_body'
      : 'json';
  const key = `${upper} ${path}`;
  const last =
    path
      .split('/')
      .filter((s) => s !== '')
      .pop() ?? '';
  const readOnly = upper === 'GET' || READ_ONLY_POSTS.has(key);
  const destructive = !readOnly && (upper === 'DELETE' || DESTRUCTIVE_ACTIONS.has(last));

  return {
    id: operationId(module, upper, path),
    module,
    method: upper,
    path,
    tags: Array.isArray(operation['tags'])
      ? operation['tags'].filter((t): t is string => typeof t === 'string')
      : [],
    summary,
    description,
    permission: asPermission(operation['x-amable-permission']),
    permissionAny: permissionAny !== null && permissionAny.length > 0 ? permissionAny : null,
    pathParams: params(operation, 'path', schemas),
    queryParams: params(operation, 'query', schemas),
    bodySchema,
    bodyRequired,
    bodyContentType,
    responseSchema: successSchema(operation, schemas),
    transport,
    readOnly,
    destructive,
    idempotent: readOnly || upper === 'PUT' || upper === 'DELETE',
  };
}

/** The whole public v2 surface as MCP-addressable operations. */
export function buildCatalog(document: unknown = mergedOpenApiDocument()): Catalog {
  const doc = isObject(document) ? document : {};
  const components = isObject(doc['components']) ? doc['components'] : {};
  const schemas = isObject(components['schemas']) ? components['schemas'] : {};
  const operations = listOperations(doc).map((o) =>
    buildOperation(o.method, o.path, o.operation, schemas),
  );
  const byId = new Map<string, CatalogOperation>();
  for (const op of operations) {
    if (byId.has(op.id)) throw new Error(`mcp catalog: duplicate operation id ${op.id}`);
    byId.set(op.id, op);
  }
  return {
    operations,
    byId,
    modules: OPENAPI_SOURCES.map((s) => ({ id: s.id, title: s.title })),
  };
}

let cached: Catalog | null = null;

/** Built once per isolate. */
export function catalog(): Catalog {
  cached ??= buildCatalog();
  return cached;
}

/** Permissions the operation needs that `granted` lacks (`any:` lists one alternative group). */
export function missingPermissions(
  op: CatalogOperation,
  granted: ReadonlySet<Permission>,
): Permission[] {
  const missing: Permission[] = [];
  if (op.permission !== null && !granted.has(op.permission)) missing.push(op.permission);
  if (op.permissionAny !== null && !op.permissionAny.some((p) => granted.has(p)))
    missing.push(...op.permissionAny);
  return missing;
}

export function isAvailable(op: CatalogOperation, granted: ReadonlySet<Permission>): boolean {
  return missingPermissions(op, granted).length === 0;
}

/** Intent words: they favour a method instead of having to appear in the text. */
const VERB_METHODS: Readonly<Record<string, readonly HttpMethod[]>> = {
  list: ['GET'],
  get: ['GET'],
  show: ['GET'],
  find: ['GET'],
  read: ['GET'],
  create: ['POST'],
  new: ['POST'],
  add: ['POST'],
  record: ['POST'],
  send: ['POST'],
  update: ['PATCH', 'PUT'],
  edit: ['PATCH', 'PUT'],
  change: ['PATCH', 'PUT', 'POST'],
  delete: ['DELETE'],
};
const VERB_ONLY: ReadonlySet<string> = new Set([
  'list',
  'get',
  'show',
  'find',
  'read',
  'create',
  'new',
  'add',
  'update',
  'edit',
  'delete',
]);

function haystack(op: CatalogOperation): string {
  return [op.id, op.method, op.path, op.summary, op.description, ...op.tags, op.permission ?? '']
    .join(' ')
    .toLowerCase();
}

/**
 * Ranked keyword search: every term must appear somewhere; hits in the id,
 * path, summary and tags weigh more than hits in the description.
 */
export function searchOperations(
  ops: readonly CatalogOperation[],
  query: string,
  module?: string,
): CatalogOperation[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,/._-]+/)
    .filter((t) => t.length > 0);
  const scoped = module === undefined ? ops : ops.filter((op) => op.module === module);
  if (terms.length === 0) return [...scoped];
  const intents = new Set(terms.flatMap((t) => VERB_METHODS[t] ?? []));
  const content = terms.filter((t) => VERB_METHODS[t] === undefined || !VERB_ONLY.has(t));
  const scored: Array<{ op: CatalogOperation; score: number }> = [];
  for (const op of scoped) {
    const all = haystack(op);
    const strong = [op.id, op.path, op.summary, ...op.tags].join(' ').toLowerCase();
    const summary = op.summary.toLowerCase();
    const path = op.path.toLowerCase();
    let score = intents.has(op.method) ? 2 : 0;
    let matched = 0;
    for (const term of content) {
      const stem = term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term;
      if (!all.includes(stem)) continue;
      matched += 1;
      score += strong.includes(stem) ? 3 : 1;
      score += Math.min(2, summary.split(stem).length - 1);
      if (path.includes(stem)) score += 2;
    }
    if (matched === content.length) scored.push({ op, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.op.path.length - b.op.path.length)
    .map((s) => s.op);
}
