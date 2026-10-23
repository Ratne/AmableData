import type { Permission } from '@amable/core';
import type { AuthContext, TenantContext } from '../middleware';
import {
  isAvailable,
  missingPermissions,
  searchOperations,
  type Catalog,
  type CatalogOperation,
  type JsonObject,
} from './catalog';
import { dispatch, DispatchError, type DispatchInput, type DispatchTarget } from './dispatch';

export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly annotations: ToolAnnotations;
}

export interface ToolResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly isError: boolean;
}

/** Resolved by the MCP endpoint itself (API key, tenant) — only for tools that need scopes. */
export interface Caller {
  readonly auth: AuthContext;
  readonly tenant: TenantContext;
}

export interface ToolContext {
  readonly catalog: Catalog;
  readonly target: DispatchTarget;
  readonly caller: Caller | null;
}

export interface McpTool {
  readonly definition: ToolDefinition;
  /** Needs the caller's effective scopes before running (otherwise the REST route enforces them). */
  readonly needsCaller: boolean;
  /** The REST operation a curated tool runs. */
  readonly operation: CatalogOperation | null;
  visibleTo(granted: ReadonlySet<Permission>): boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Tool output cap (characters): agents page with `limit` / `cursor` instead. */
export const MAX_RESULT_CHARS = 100_000;

export class UnauthorizedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function text(value: unknown, isError = false): ToolResult {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (serialized.length <= MAX_RESULT_CHARS)
    return { content: [{ type: 'text', text: serialized }], isError };
  const preview = JSON.stringify({
    truncated: true,
    total_chars: serialized.length,
    note: 'Result too large: ask for fewer items (limit), select fields, or page with the cursor.',
    preview: serialized.slice(0, MAX_RESULT_CHARS - 400),
  });
  return { content: [{ type: 'text', text: preview }], isError };
}

function errorHint(
  status: number,
  code: string | null,
  missing: readonly string[] | null,
): string | null {
  if (status === 403 && code === 'forbidden') {
    return `The API key lacks the permission${missing !== null && missing.length > 1 ? 's' : ''} ${missing?.join(', ') ?? ''}. A workspace admin can create a key with these scopes (Settings → API keys); the key can never exceed its creator's role.`;
  }
  if (status === 403 && (code === 'session_required' || code === 'step_up_required')) {
    return 'This action is reserved to a signed-in user in the web app (it cannot be done with an API key).';
  }
  if (status === 404)
    return 'Not found: check the id (deleted records may need include_deleted or a restore operation).';
  if (status === 409)
    return 'Conflict with the current state (revision, status or a duplicate): re-read the record and retry.';
  if (status === 422)
    return 'Validation failed: see details, then fix the arguments (describe_operation shows the schema).';
  if (status === 429)
    return 'Rate limit reached (600 requests per minute per key): wait retry_after seconds.';
  return null;
}

async function runOperation(
  op: CatalogOperation,
  input: DispatchInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  let result;
  try {
    result = await dispatch(ctx.target, op, input);
  } catch (error) {
    if (error instanceof DispatchError)
      return text({ error: error.code, message: error.message }, true);
    throw error;
  }
  if (result.status === 401) {
    const code =
      typeof (result.data as JsonObject | null)?.['error'] === 'string'
        ? String((result.data as JsonObject)['error'])
        : 'unauthenticated';
    throw new UnauthorizedError(code);
  }
  if (result.ok) return text(result.data ?? { ok: true, status: result.status });
  const body = (
    typeof result.data === 'object' && result.data !== null ? result.data : { message: result.data }
  ) as JsonObject;
  const code = typeof body['error'] === 'string' ? body['error'] : null;
  const missing = Array.isArray(body['missing']) ? body['missing'].map(String) : null;
  return text(
    {
      status: result.status,
      ...body,
      ...(result.retryAfter === null ? {} : { retry_after: result.retryAfter }),
      ...(errorHint(result.status, code, missing) === null
        ? {}
        : { hint: errorHint(result.status, code, missing) }),
    },
    true,
  );
}

// --- schemas -------------------------------------------------------------------------------

function paramSchema(schema: JsonObject, description: string | null): JsonObject {
  return description === null || schema['description'] !== undefined
    ? schema
    : { ...schema, description };
}

const IDEMPOTENCY_PROPERTY: JsonObject = {
  type: 'string',
  maxLength: 255,
  description:
    'Optional Idempotency-Key: retrying with the same key within 24 h never repeats the action.',
};

interface ArgumentLayout {
  readonly schema: JsonObject;
  readonly path: ReadonlySet<string>;
  readonly query: ReadonlySet<string>;
  /** Body properties exposed at the top level; `null` when the body travels as `body`. */
  readonly flatBody: ReadonlySet<string> | null;
}

/** One flat argument object per operation: path + query params, then the JSON body properties. */
export function argumentLayout(
  op: CatalogOperation,
  queryPick?: readonly string[],
): ArgumentLayout {
  const properties: JsonObject = {};
  const required: string[] = [];
  const path = new Set<string>();
  const query = new Set<string>();
  for (const p of op.pathParams) {
    properties[p.name] = paramSchema(p.schema, p.description);
    required.push(p.name);
    path.add(p.name);
  }
  for (const p of op.queryParams) {
    if (queryPick !== undefined && !queryPick.includes(p.name)) continue;
    properties[p.name] = paramSchema(p.schema, p.description);
    if (p.required) required.push(p.name);
    query.add(p.name);
  }
  let flatBody: Set<string> | null = null;
  const body = op.bodySchema;
  if (body !== null && op.transport === 'json') {
    const bodyProps = body['properties'];
    const flat =
      body['type'] === 'object' &&
      typeof bodyProps === 'object' &&
      bodyProps !== null &&
      !Array.isArray(bodyProps) &&
      Object.keys(bodyProps).every(
        (k) => properties[k] === undefined && k !== 'idempotency_key' && k !== 'body',
      );
    if (flat) {
      flatBody = new Set(Object.keys(bodyProps));
      Object.assign(properties, bodyProps);
      if (Array.isArray(body['required'])) required.push(...body['required'].map(String));
    } else {
      properties['body'] = body;
      if (op.bodyRequired) required.push('body');
    }
  } else if (op.transport === 'raw_body') {
    properties['body_base64'] = {
      type: 'string',
      description: `File content (${op.bodyContentType ?? 'binary'}), base64.`,
    };
    required.push('body_base64');
  }
  if (!op.readOnly && op.method === 'POST') properties['idempotency_key'] = IDEMPOTENCY_PROPERTY;
  return {
    schema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    path,
    query,
    flatBody,
  };
}

function inputFromArgs(layout: ArgumentLayout, args: Record<string, unknown>): DispatchInput {
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  let body: Record<string, unknown> | undefined;
  let nestedBody: unknown;
  for (const [key, value] of Object.entries(args)) {
    if (layout.path.has(key)) pathParams[key] = value;
    else if (layout.query.has(key)) query[key] = value;
    else if (key === 'body') nestedBody = value;
    else if (layout.flatBody?.has(key) === true) (body ??= {})[key] = value;
  }
  return {
    pathParams,
    query,
    body: nestedBody ?? body,
    bodyBase64: typeof args['body_base64'] === 'string' ? args['body_base64'] : undefined,
    idempotencyKey:
      typeof args['idempotency_key'] === 'string' ? args['idempotency_key'] : undefined,
  };
}

// --- curated tools -------------------------------------------------------------------------

interface CuratedSpec {
  readonly name: string;
  readonly operation: string;
  readonly title: string;
  readonly hint?: string;
  readonly query?: readonly string[];
}

/** The everyday flows, one tool each; everything else goes through call_operation. */
export const CURATED_TOOLS: readonly CuratedSpec[] = [
  {
    name: 'search_contacts',
    operation: 'GET /contacts',
    title: 'Search contacts',
    hint: 'Use q for full-text search (name, email, phone) or email for an exact match.',
  },
  { name: 'get_contact', operation: 'GET /contacts/{id}', title: 'Get a contact' },
  { name: 'create_contact', operation: 'POST /contacts', title: 'Create a contact' },
  {
    name: 'update_contact',
    operation: 'PATCH /contacts/{id}',
    title: 'Update a contact',
    hint: 'Only the given fields change.',
  },
  {
    name: 'get_contact_timeline',
    operation: 'GET /contacts/{id}/timeline',
    title: 'Contact activity timeline',
  },
  { name: 'tag_contact', operation: 'POST /contacts/{id}/tags', title: 'Apply tags to a contact' },
  {
    name: 'untag_contact',
    operation: 'DELETE /contacts/{id}/tags/{tagId}',
    title: 'Remove a tag from a contact',
  },
  { name: 'list_tags', operation: 'GET /tags', title: 'List tags' },
  { name: 'search_companies', operation: 'GET /companies', title: 'Search companies' },
  {
    name: 'global_search',
    operation: 'GET /search',
    title: 'Search contacts, companies and notes',
  },
  { name: 'add_note', operation: 'POST /notes', title: 'Add a note' },
  { name: 'list_tasks', operation: 'GET /tasks', title: 'List tasks' },
  { name: 'create_task', operation: 'POST /tasks', title: 'Create a task' },
  { name: 'complete_task', operation: 'POST /tasks/{id}/complete', title: 'Complete a task' },
  { name: 'list_pipelines', operation: 'GET /pipelines', title: 'List pipelines and stages' },
  {
    name: 'list_opportunities',
    operation: 'GET /opportunities',
    title: 'List opportunities (deals)',
  },
  {
    name: 'create_opportunity',
    operation: 'POST /opportunities',
    title: 'Create an opportunity (deal)',
  },
  {
    name: 'update_opportunity',
    operation: 'PATCH /opportunities/{id}',
    title: 'Update an opportunity (move stage, value, status)',
  },
  { name: 'list_orders', operation: 'GET /orders', title: 'List orders' },
  { name: 'get_order', operation: 'GET /orders/{id}', title: 'Get an order' },
  { name: 'create_order', operation: 'POST /orders', title: 'Create an order' },
  {
    name: 'record_payment',
    operation: 'POST /orders/{id}/payments',
    title: 'Record a payment on an order',
  },
  {
    name: 'refund_order',
    operation: 'POST /orders/{id}/refunds',
    title: 'Refund an order (full or partial)',
    hint: 'stripe: true also refunds the card through Stripe. Moves real money: confirm with the user first.',
  },
  { name: 'list_products', operation: 'GET /products', title: 'List products and plans' },
  { name: 'list_subscriptions', operation: 'GET /subscriptions', title: 'List subscriptions' },
  {
    name: 'cancel_subscription',
    operation: 'POST /subscriptions/{id}/cancel',
    title: 'Cancel a subscription',
  },
  {
    name: 'get_checkout',
    operation: 'GET /checkouts/{id}',
    title: 'Get a checkout with its sales stats',
  },
  {
    name: 'send_email',
    operation: 'POST /contacts/{id}/emails',
    title: 'Send one email to a contact',
  },
  { name: 'list_broadcasts', operation: 'GET /broadcasts', title: 'List email broadcasts' },
  {
    name: 'get_broadcast_stats',
    operation: 'GET /broadcasts/{id}/stats',
    title: 'Broadcast delivery and engagement stats',
  },
  { name: 'list_automations', operation: 'GET /automations', title: 'List automations' },
  {
    name: 'trigger_automation_goal',
    operation: 'POST /automationGoals/{callName}/trigger',
    title: 'Fire an API goal of the automations for a contact',
  },
  {
    name: 'enroll_in_automation',
    operation: 'POST /automations/{id}/enrollments',
    title: 'Enroll a contact in an automation',
  },
  { name: 'list_forms', operation: 'GET /forms', title: 'List forms' },
  {
    name: 'list_form_submissions',
    operation: 'GET /forms/{formId}/submissions',
    title: 'List form submissions',
  },
  { name: 'list_bookings', operation: 'GET /bookings', title: 'List bookings' },
  {
    name: 'check_availability',
    operation: 'GET /bookingEventTypes/{eventTypeId}/availability',
    title: 'Bookable slots of an event type',
  },
  { name: 'create_booking', operation: 'POST /bookings', title: 'Book on behalf of a contact' },
  {
    name: 'list_conversations',
    operation: 'GET /conversations',
    title: 'List inbox conversations',
  },
  {
    name: 'reply_conversation',
    operation: 'POST /conversations/{id}/messages',
    title: 'Reply in a conversation (or add an internal note)',
  },
  {
    name: 'send_esign_request',
    operation: 'POST /esignRequests',
    title: 'Send a document for e-signature',
  },
  {
    name: 'list_esign_requests',
    operation: 'GET /esignRequests',
    title: 'List e-signature requests',
  },
  {
    name: 'list_analytics_sites',
    operation: 'GET /analytics/sites',
    title: 'List tracked websites',
  },
  {
    name: 'analytics_overview',
    operation: 'GET /analytics/overview',
    title: 'Website KPIs over a range',
  },
  {
    name: 'analytics_timeseries',
    operation: 'GET /analytics/timeseries',
    title: 'Website metrics per interval',
  },
  {
    name: 'analytics_breakdown',
    operation: 'GET /analytics/breakdown/{dimension}',
    title: 'Top pages, sources, campaigns, countries…',
  },
  { name: 'list_reports', operation: 'GET /reports', title: 'List reports' },
  { name: 'run_report', operation: 'POST /reports/{reportId}/run', title: 'Run a report' },
];

function operationByKey(catalog: Catalog, key: string): CatalogOperation {
  const [method, path] = key.split(' ');
  const op = catalog.operations.find((o) => o.method === method && o.path === path);
  if (op === undefined) throw new Error(`mcp: curated tool points to a missing operation ${key}`);
  return op;
}

function permissionLine(op: CatalogOperation): string {
  const parts: string[] = [];
  if (op.permission !== null) parts.push(op.permission);
  if (op.permissionAny !== null) parts.push(`one of ${op.permissionAny.join(', ')}`);
  return parts.length === 0 ? '' : ` Requires: ${parts.join(' + ')}.`;
}

function curatedTool(spec: CuratedSpec, catalog: Catalog): McpTool {
  const op = operationByKey(catalog, spec.operation);
  const layout = argumentLayout(op, spec.query);
  const description = [op.summary, op.description, spec.hint ?? '']
    .filter((s) => s !== '')
    .join(' ')
    .concat(permissionLine(op), ` (REST: ${op.method} ${op.path})`);
  return {
    definition: {
      name: spec.name,
      title: spec.title,
      description,
      inputSchema: layout.schema,
      annotations: {
        title: spec.title,
        readOnlyHint: op.readOnly,
        destructiveHint: op.destructive,
        idempotentHint: op.idempotent,
        openWorldHint: false,
      },
    },
    needsCaller: false,
    operation: op,
    visibleTo: (granted) => isAvailable(op, granted),
    run: (args, ctx) => runOperation(op, inputFromArgs(layout, args), ctx),
  };
}

// --- meta tools ----------------------------------------------------------------------------

function summaryOf(op: CatalogOperation, granted: ReadonlySet<Permission>) {
  const missing = missingPermissions(op, granted);
  return {
    id: op.id,
    method: op.method,
    path: op.path,
    summary: op.summary,
    permission: op.permission,
    ...(op.permissionAny === null ? {} : { permission_any: op.permissionAny }),
    available: missing.length === 0,
    ...(missing.length === 0 ? {} : { missing }),
    read_only: op.readOnly,
    destructive: op.destructive,
    ...(op.transport === 'json' ? {} : { transport: op.transport }),
  };
}

function requireCaller(ctx: ToolContext): Caller {
  if (ctx.caller === null) throw new Error('mcp: tool needs the caller but none was resolved');
  return ctx.caller;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function objectArg(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const searchTool: McpTool = {
  definition: {
    name: 'search_operations',
    title: 'Search the amabledata API',
    description:
      'Finds REST operations of the whole amabledata API (CRM, commerce, checkouts, email, automations, forms, bookings, landing pages, e-sign, analytics, reports, webhooks, domains). Without query and module it lists the modules. Results only include what this API key may call unless include_unavailable is true. Then use describe_operation for the arguments and call_operation to run it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 200,
          description: 'Keywords, e.g. "refund order", "broadcast schedule", "funnel heatmap".',
        },
        module: {
          type: 'string',
          description:
            'Restrict to a module: crm, email, analytics, publishing, reports, webhooks, domains.',
        },
        include_unavailable: {
          type: 'boolean',
          description:
            'Also list operations the key lacks permissions for (marked available: false).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Search the amabledata API',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  needsCaller: true,
  operation: null,
  visibleTo: () => true,
  run: (args, ctx) => {
    const { tenant } = requireCaller(ctx);
    const granted = tenant.permissions;
    const query = stringArg(args, 'query') ?? '';
    const module = stringArg(args, 'module');
    const includeUnavailable = args['include_unavailable'] === true;
    const limit =
      typeof args['limit'] === 'number'
        ? Math.min(100, Math.max(1, Math.floor(args['limit'])))
        : 25;
    if (query === '' && module === undefined) {
      return Promise.resolve(
        text({
          modules: ctx.catalog.modules.map((m) => {
            const ops = ctx.catalog.operations.filter((o) => o.module === m.id);
            return {
              id: m.id,
              title: m.title,
              operations: ops.length,
              available: ops.filter((o) => isAvailable(o, granted)).length,
              tags: [...new Set(ops.flatMap((o) => o.tags))].sort(),
            };
          }),
          next: 'Call search_operations with a query (and optionally a module).',
        }),
      );
    }
    const found = searchOperations(ctx.catalog.operations, query, module);
    const visible = includeUnavailable ? found : found.filter((o) => isAvailable(o, granted));
    const hidden = found.length - visible.length;
    return Promise.resolve(
      text({
        total: visible.length,
        operations: visible.slice(0, limit).map((o) => summaryOf(o, granted)),
        ...(hidden > 0 ? { hidden_without_permission: hidden } : {}),
      }),
    );
  },
};

const describeTool: McpTool = {
  definition: {
    name: 'describe_operation',
    title: 'Describe an API operation',
    description:
      'Full contract of one operation from search_operations: permission, path and query parameters, JSON body schema, response schema, and the arguments call_operation expects.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Operation id, e.g. crm.post_orders_id_refunds.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Describe an API operation',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  needsCaller: true,
  operation: null,
  visibleTo: () => true,
  run: (args, ctx) => {
    const { tenant } = requireCaller(ctx);
    const id = stringArg(args, 'id') ?? '';
    const op = ctx.catalog.byId.get(id);
    if (op === undefined) {
      const near = searchOperations(ctx.catalog.operations, id.replace(/^[a-z]+\./, ''))
        .slice(0, 5)
        .map((o) => o.id);
      return Promise.resolve(text({ error: 'unknown_operation', id, did_you_mean: near }, true));
    }
    const layout = argumentLayout(op);
    return Promise.resolve(
      text({
        ...summaryOf(op, tenant.permissions),
        module: op.module,
        tags: op.tags,
        description: op.description,
        idempotent: op.idempotent,
        path_params: op.pathParams,
        query_params: op.queryParams,
        body:
          op.bodySchema === null
            ? null
            : {
                content_type: op.bodyContentType,
                required: op.bodyRequired,
                schema: op.bodySchema,
              },
        response: op.responseSchema,
        call_operation: {
          id: op.id,
          ...(op.pathParams.length > 0
            ? { path_params: Object.fromEntries(op.pathParams.map((p) => [p.name, `<${p.name}>`])) }
            : {}),
          ...(op.queryParams.length > 0 ? { query: '{ …query params }' } : {}),
          ...(op.transport === 'json' && op.bodySchema !== null ? { body: '{ …body }' } : {}),
          ...(op.transport === 'raw_body' ? { body_base64: '<base64 file>' } : {}),
        },
        ...(op.transport === 'websocket'
          ? { note: 'WebSocket upgrade: not callable over MCP.' }
          : {}),
        flat_tool_schema: layout.schema,
      }),
    );
  },
};

const callTool: McpTool = {
  definition: {
    name: 'call_operation',
    title: 'Call an API operation',
    description:
      'Runs any operation of the amabledata REST API by id (from search_operations), with the same permissions and rate limit as the API key. Pass path_params, query and body exactly as describe_operation shows. Raw uploads (CSV, images, PDF) take body_base64. Use idempotency_key on creations you might retry.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Operation id, e.g. crm.get_contacts.' },
        path_params: {
          type: 'object',
          additionalProperties: true,
          description: 'Values for the {placeholders} of the path.',
        },
        query: {
          type: 'object',
          additionalProperties: true,
          description: 'Query string parameters (arrays repeat the key).',
        },
        body: { description: 'JSON request body.' },
        body_base64: {
          type: 'string',
          description: 'Raw request body (base64) for upload operations.',
        },
        content_type: {
          type: 'string',
          description:
            'Content type of body_base64 when the operation accepts several (e.g. image/png).',
        },
        idempotency_key: IDEMPOTENCY_PROPERTY,
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Call an API operation',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  needsCaller: false,
  operation: null,
  visibleTo: () => true,
  run: (args, ctx) => {
    const id = stringArg(args, 'id') ?? '';
    const op = ctx.catalog.byId.get(id);
    if (op === undefined) {
      return Promise.resolve(
        text({ error: 'unknown_operation', id, hint: 'Find the id with search_operations.' }, true),
      );
    }
    return runOperation(
      op,
      {
        pathParams: objectArg(args, 'path_params'),
        query: objectArg(args, 'query'),
        body: args['body'],
        bodyBase64: stringArg(args, 'body_base64'),
        contentType: stringArg(args, 'content_type'),
        idempotencyKey: stringArg(args, 'idempotency_key'),
      },
      ctx,
    );
  },
};

const whoamiTool: McpTool = {
  definition: {
    name: 'whoami',
    title: 'Workspace and permissions of this key',
    description:
      'The workspace this MCP server is bound to, who created the API key, its role and the effective permissions (key scopes intersected with the creator role). Call it first to know what you can do.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Workspace and permissions of this key',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  needsCaller: true,
  operation: null,
  visibleTo: () => true,
  run: (_args, ctx) => {
    const { auth, tenant } = requireCaller(ctx);
    const granted = tenant.permissions;
    const available = ctx.catalog.operations.filter((o) => isAvailable(o, granted));
    return Promise.resolve(
      text({
        workspace: tenant.tenant,
        credential: auth.kind,
        ...(auth.kind === 'api_key' ? { api_key_id: auth.apiKey.id } : {}),
        user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
        role: tenant.role,
        permissions: [...granted].sort(),
        operations: { available: available.length, total: ctx.catalog.operations.length },
        tools: buildTools(ctx.catalog)
          .filter((t) => t.visibleTo(granted))
          .map((t) => t.definition.name),
      }),
    );
  },
};

let cachedTools: { catalog: Catalog; tools: McpTool[] } | null = null;

/** Meta tools first, then the curated ones (built once per catalog). */
export function buildTools(catalog: Catalog): McpTool[] {
  if (cachedTools?.catalog === catalog) return cachedTools.tools;
  const tools = [
    whoamiTool,
    searchTool,
    describeTool,
    callTool,
    ...CURATED_TOOLS.map((spec) => curatedTool(spec, catalog)),
  ];
  cachedTools = { catalog, tools };
  return tools;
}
