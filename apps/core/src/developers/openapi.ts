import { analyticsOpenApiDocument } from '../analytics/routes';
import { crmOpenApiDocument } from '../crm/api/router';
import { domainsOpenApiDocument } from '../domains/api';
import { emailOpenApiDocument } from '../email/mount';
import { publishingOpenApiDocument } from '../public/mount';
import { reportsOpenApiDocument } from '../reports/routes';
import { webhooksOpenApiDocument } from '../webhooks/api';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** A module document: its own paths are relative to `prefix` under `/api/v2/t/{slug}`. */
export interface OpenApiSource {
  readonly id: string;
  readonly title: string;
  readonly prefix: string;
  readonly document: () => unknown;
}

export const OPENAPI_SOURCES: readonly OpenApiSource[] = [
  { id: 'crm', title: 'CRM, automations & commerce', prefix: '', document: crmOpenApiDocument },
  { id: 'email', title: 'Email marketing', prefix: '', document: emailOpenApiDocument },
  { id: 'analytics', title: 'Web analytics', prefix: '/analytics', document: analyticsOpenApiDocument },
  {
    id: 'publishing',
    title: 'Forms, bookings & landing pages',
    prefix: '',
    document: publishingOpenApiDocument,
  },
  { id: 'reports', title: 'Reports & dashboards', prefix: '', document: reportsOpenApiDocument },
  { id: 'webhooks', title: 'Outgoing webhooks', prefix: '', document: webhooksOpenApiDocument },
  { id: 'domains', title: 'Domains', prefix: '', document: domainsOpenApiDocument },
];

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const COMPONENT_REF = '#/components/schemas/';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asJson(value: unknown): JsonObject {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isObject(parsed) ? parsed : {};
}

function rewriteRefs(node: Json, renames: ReadonlyMap<string, string>): Json {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, renames));
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT_REF)) {
      const name = value.slice(COMPONENT_REF.length);
      out[key] = COMPONENT_REF + (renames.get(name) ?? name);
    } else {
      out[key] = rewriteRefs(value, renames);
    }
  }
  return out;
}

function capitalized(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Every v2 operation of one merged document, with its method and path. */
export function listOperations(
  document: unknown,
): Array<{ method: string; path: string; operation: JsonObject }> {
  const paths = isObject(document) && isObject(document['paths']) ? document['paths'] : {};
  const out: Array<{ method: string; path: string; operation: JsonObject }> = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (isObject(operation)) out.push({ method, path, operation });
    }
  }
  return out;
}

/**
 * One OpenAPI 3.1 document with the whole public v2 surface. Schemas that two
 * modules define differently under the same name are renamed `<Module><Name>`
 * (with every `$ref` of that module rewritten); operations get the module tag
 * when they have none, and `x-tagGroups` groups tags by module.
 */
export function mergedOpenApiDocument(sources: readonly OpenApiSource[] = OPENAPI_SOURCES): JsonObject {
  const paths: JsonObject = {};
  const schemas: JsonObject = {};
  const securitySchemes: JsonObject = {};
  const tagGroups: Array<{ name: string; tags: string[] }> = [];
  const tagNames = new Set<string>();

  for (const source of sources) {
    const doc = asJson(source.document());
    const components = isObject(doc['components']) ? doc['components'] : {};
    const docSchemas = isObject(components['schemas']) ? components['schemas'] : {};
    const renames = new Map<string, string>();
    for (const [name, schema] of Object.entries(docSchemas)) {
      const existing = schemas[name];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(schema)) {
        renames.set(name, `${capitalized(source.id)}${name}`);
      }
    }
    for (const [name, schema] of Object.entries(docSchemas)) {
      schemas[renames.get(name) ?? name] = rewriteRefs(schema, renames);
    }
    if (isObject(components['securitySchemes'])) {
      Object.assign(securitySchemes, components['securitySchemes']);
    }

    const groupTags = new Set<string>();
    const docPaths = isObject(doc['paths']) ? doc['paths'] : {};
    for (const [path, item] of Object.entries(docPaths)) {
      if (!isObject(item)) continue;
      const rewritten = rewriteRefs(item, renames);
      if (!isObject(rewritten)) continue;
      for (const method of HTTP_METHODS) {
        const operation = rewritten[method];
        if (!isObject(operation)) continue;
        const tags = Array.isArray(operation['tags'])
          ? operation['tags'].filter((tag): tag is string => typeof tag === 'string')
          : [];
        if (tags.length === 0) {
          tags.push(source.title);
          operation['tags'] = tags;
        }
        for (const tag of tags) groupTags.add(tag);
        operation['x-amable-module'] = source.id;
      }
      paths[`${source.prefix}${path}`] = rewritten;
    }
    const tags = [...groupTags].sort();
    for (const tag of tags) tagNames.add(tag);
    tagGroups.push({ name: source.title, tags });
  }

  if (securitySchemes['apiKey'] === undefined) {
    securitySchemes['apiKey'] = {
      type: 'http',
      scheme: 'bearer',
      description: 'Tenant API key (`amb_…`), scoped to a subset of permissions.',
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'amabledata REST API',
      version: '2.0.0',
      description:
        'Tenant-scoped REST API of an amabledata installation. Authenticate with an API key (`Authorization: Bearer amb_live_…`, created in Settings → API keys) or a browser session. Every operation lists the permission it requires in `x-amable-permission`; an API key works with the intersection of its scopes and the current role of the member who created it. Lists use cursor pagination (`limit`, `cursor` → `next_cursor`); POST requests accept an `Idempotency-Key` header (24 h replay). Errors are JSON: `{ "error": "<code>", "message"?, "details"? }`.',
    },
    servers: [{ url: '/api/v2/t/{slug}', variables: { slug: { default: 'demo' } } }],
    security: [{ apiKey: [] }],
    tags: [...tagNames].sort().map((name) => ({ name })),
    'x-tagGroups': tagGroups,
    paths,
    components: { schemas, securitySchemes },
  };
}
