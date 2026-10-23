import type { Context, Hono } from 'hono';
import { requireAuth, requireTenant, type AppEnv } from '../middleware';
import { catalog } from './catalog';
import type { Fetcher } from './dispatch';
import { buildTools, UnauthorizedError, type McpTool, type ToolContext } from './tools';

/** Newest first; an unknown client version gets the newest one. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SERVER_INFO = { name: 'amabledata', title: 'amabledata', version: '1.0.0' } as const;

const INSTRUCTIONS = [
  'amabledata CRM workspace (contacts, companies, deals, tasks, commerce, checkouts, email, automations, forms, bookings, landing pages, e-sign, web analytics, reports, webhooks, domains).',
  'Start with whoami to see the workspace and the permissions of this API key; tools the key cannot use are not listed.',
  'The dedicated tools cover the everyday flows. For anything else: search_operations → describe_operation → call_operation, which reaches every operation of the REST API.',
  'Lists are cursor-paginated (limit, cursor). Money amounts are integer minor units (cents) with a currency.',
  'Ask the user before destructive actions (deleting, refunding, sending broadcasts, cancelling).',
].join(' ');

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const params = v['params'];
  return (
    v['jsonrpc'] === '2.0' &&
    typeof v['method'] === 'string' &&
    (params === undefined ||
      (typeof params === 'object' && params !== null && !Array.isArray(params)))
  );
}

function negotiate(requested: unknown): string {
  return typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

function unauthorized(c: Context<AppEnv>, code: string): Response {
  c.header('WWW-Authenticate', 'Bearer realm="amabledata", error="invalid_token"');
  return c.json({ error: code }, 401);
}

/** API key (or app token) + tenant, like every /t/:slug route; a Response when it fails. */
async function authenticate(c: Context<AppEnv>): Promise<Response | null> {
  if (!/^Bearer\s+\S+$/i.test(c.req.header('authorization') ?? ''))
    return unauthorized(c, 'api_key_required');
  const noop = () => Promise.resolve();
  const auth = await requireAuth({ apiKey: true })(c, noop);
  if (auth instanceof Response) {
    if (auth.status === 401)
      auth.headers.set('WWW-Authenticate', 'Bearer realm="amabledata", error="invalid_token"');
    return auth;
  }
  const tenant = await requireTenant()(c, noop);
  return tenant instanceof Response ? tenant : null;
}

/** tools/call of a tool that only dispatches skips the outer guards: the REST route runs them (one rate-limit hit, not two). */
function needsCaller(message: JsonRpcRequest, tools: readonly McpTool[]): boolean {
  if (message.method !== 'tools/call')
    return message.method !== 'notifications/initialized' && message.method !== 'ping';
  const name = message.params?.['name'];
  const tool = tools.find((t) => t.definition.name === name);
  return tool === undefined || tool.needsCaller;
}

function executionCtx(c: Context<AppEnv>): Parameters<Hono<AppEnv>['fetch']>[2] {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

async function handle(
  message: JsonRpcRequest,
  ctx: ToolContext,
  tools: readonly McpTool[],
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const params = message.params ?? {};
  if (message.id === undefined) return null;
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiate(params['protocolVersion']),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
      const granted = ctx.caller?.tenant.permissions;
      const visible = granted === undefined ? tools : tools.filter((t) => t.visibleTo(granted));
      return { jsonrpc: '2.0', id, result: { tools: visible.map((t) => t.definition) } };
    }
    case 'tools/call': {
      const name = params['name'];
      const tool = tools.find((t) => t.definition.name === name);
      if (tool === undefined) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      const rawArgs = params['arguments'] ?? {};
      if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
        return rpcError(id, INVALID_PARAMS, 'arguments must be an object');
      }
      if (ctx.caller !== null && !tool.visibleTo(ctx.caller.tenant.permissions)) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'forbidden',
                  hint: 'This API key lacks the permission this tool needs.',
                }),
              },
            ],
            isError: true,
          },
        };
      }
      const result = await tool.run(rawArgs as Record<string, unknown>, ctx);
      return { jsonrpc: '2.0', id, result };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

/**
 * Remote MCP server (Streamable HTTP, stateless, JSON responses) at
 * `/api/mcp/t/:slug`. Every tool runs as the API key in the Authorization
 * header: same scopes, rate limit and audit trail as the REST API it calls.
 */
export function mountMcpServer(app: Hono<AppEnv>, fetcher: (c: Context<AppEnv>) => Fetcher): void {
  app.post('/mcp/t/:slug', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(rpcError(null, PARSE_ERROR, 'Parse error'), 400);
    }
    const batch = Array.isArray(payload);
    const messages = batch ? (payload as unknown[]) : [payload];
    if (messages.length === 0 || !messages.every(isRequest)) {
      return c.json(rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC request'), 400);
    }

    const ops = catalog();
    const tools = buildTools(ops);
    if (messages.some((m) => needsCaller(m, tools))) {
      const failure = await authenticate(c);
      if (failure !== null) return failure;
    } else if (!/^Bearer\s+\S+$/i.test(c.req.header('authorization') ?? '')) {
      return unauthorized(c, 'api_key_required');
    }

    const auth = c.get('auth');
    const tenant = c.get('tenant');
    const ctx: ToolContext = {
      catalog: ops,
      target: {
        fetcher: fetcher(c),
        origin: new URL(c.req.url).origin,
        slug: c.req.param('slug'),
        authorization: c.req.header('authorization') ?? '',
        requestId: c.req.header('x-request-id') ?? null,
      },
      caller: auth !== undefined && tenant !== undefined ? { auth, tenant } : null,
    };

    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      try {
        const response = await handle(message, ctx, tools);
        if (response !== null) responses.push(response);
      } catch (error) {
        if (error instanceof UnauthorizedError) return unauthorized(c, error.code);
        console.error('[mcp] tool failed', error);
        responses.push(rpcError(message.id ?? null, INTERNAL_ERROR, 'Internal error'));
      }
    }
    if (responses.length === 0) return c.body(null, 202);
    return c.json(batch ? responses : responses[0]);
  });

  const notAllowed = (c: Context<AppEnv>) => {
    c.header('Allow', 'POST');
    return c.json(
      {
        error: 'method_not_allowed',
        hint: 'This MCP server is stateless: POST JSON-RPC messages.',
      },
      405,
    );
  };
  app.get('/mcp/t/:slug', notAllowed);
  app.delete('/mcp/t/:slug', notAllowed);
}

export function selfFetcher(app: Hono<AppEnv>): (c: Context<AppEnv>) => Fetcher {
  return (c) => (request) => Promise.resolve(app.fetch(request, c.env, executionCtx(c)));
}
