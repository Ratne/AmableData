import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@amable/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  listOperations,
  mergedOpenApiDocument,
  OPENAPI_SOURCES,
} from '../../src/developers/openapi';
import { buildCatalog, catalog, operationId, searchOperations } from '../../src/mcp/catalog';
import { dispatch, DispatchError, type DispatchTarget } from '../../src/mcp/dispatch';
import { buildTools, CURATED_TOOLS, MAX_RESULT_CHARS, type ToolContext } from '../../src/mcp/tools';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { fakeTenantDbNamespace } from '../crm/helpers';

const MCP = '/api/mcp/t/acme';

interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

function recordingTarget(respond: (r: Recorded) => Response = () => Response.json({ ok: true })): {
  target: DispatchTarget;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    target: {
      origin: 'http://localhost',
      slug: 'acme',
      authorization: 'Bearer amb_live_test',
      requestId: null,
      fetcher: async (request) => {
        const recorded = {
          method: request.method,
          url: new URL(request.url),
          headers: request.headers,
          body: await request.text(),
        };
        calls.push(recorded);
        return respond(recorded);
      },
    },
  };
}

function toolContext(target: DispatchTarget): ToolContext {
  return { catalog: catalog(), target, caller: null };
}

function toolText(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

describe('MCP catalog', () => {
  const ops = catalog().operations;

  it('covers every operation of the merged OpenAPI document', () => {
    expect(ops.length).toBe(listOperations(mergedOpenApiDocument()).length);
    expect(ops.length).toBeGreaterThan(400);
    for (const source of OPENAPI_SOURCES)
      expect(ops.some((op) => op.module === source.id)).toBe(true);
  });

  it('gives deterministic, unique ids', () => {
    expect(new Set(ops.map((op) => op.id)).size).toBe(ops.length);
    expect(buildCatalog().operations.map((op) => op.id)).toEqual(ops.map((op) => op.id));
    expect(operationId('crm', 'GET', '/contacts/{id}')).toBe('crm.get_contacts_id');
    expect(operationId('crm', 'DELETE', '/contacts/{id}/tags/{tagId}')).toBe(
      'crm.delete_contacts_id_tags_tag_id',
    );
    expect(operationId('reports', 'GET', '/reports/{reportId}/export.csv')).toBe(
      'reports.get_reports_report_id_export_csv',
    );
    expect(catalog().byId.get('crm.post_orders_id_refunds')?.path).toBe('/orders/{id}/refunds');
    expect(catalog().byId.get('analytics.get_analytics_funnels_v2_id_heatmap')?.module).toBe(
      'analytics',
    );
    for (const op of ops) expect(op.id).toMatch(/^[a-z]+\.[a-z]+_[a-z0-9_]+$/);
  });

  it('knows the permission of every operation', () => {
    for (const op of ops)
      expect(op.permission !== null || op.permissionAny !== null, op.id).toBe(true);
  });

  it('inlines schema references', () => {
    for (const op of ops) {
      expect(JSON.stringify(op.bodySchema ?? {}), op.id).not.toContain('$ref');
      expect(JSON.stringify(op.queryParams), op.id).not.toContain('$ref');
    }
    expect(catalog().byId.get('webhooks.post_webhooks')?.bodySchema).not.toBeNull();
  });

  it('flags read-only, destructive and special transports', () => {
    const get = (id: string) => catalog().byId.get(id);
    expect(get('crm.get_contacts')).toMatchObject({
      readOnly: true,
      destructive: false,
      idempotent: true,
    });
    expect(get('crm.post_search')).toMatchObject({ readOnly: true });
    expect(get('crm.delete_contacts_id')).toMatchObject({ readOnly: false, destructive: true });
    expect(get('crm.post_orders_id_refunds')).toMatchObject({ destructive: true });
    expect(get('crm.post_contacts')).toMatchObject({
      readOnly: false,
      destructive: false,
      idempotent: false,
    });
    expect(get('crm.put_imports_id_csv')).toMatchObject({
      transport: 'raw_body',
      bodyContentType: 'text/csv',
    });
    expect(get('crm.get_automations_id_lock')).toMatchObject({ transport: 'websocket' });
  });

  it('searches by keywords with plural tolerance and module scope', () => {
    const refund = searchOperations(ops, 'refund order');
    expect(refund.slice(0, 5).map((op) => op.id)).toContain('crm.post_orders_id_refunds');
    expect(searchOperations(ops, 'record refund')[0]?.id).toBe('crm.post_orders_id_refunds');
    expect(searchOperations(ops, 'create contact')[0]?.id).toBe('crm.post_contacts');
    expect(searchOperations(ops, 'list contacts')[0]?.id).toBe('crm.get_contacts');
    expect(
      searchOperations(ops, 'heatmap', 'analytics').every((op) => op.module === 'analytics'),
    ).toBe(true);
    expect(searchOperations(ops, 'broadcasts schedule').map((op) => op.id)).toContain(
      'email.post_broadcasts_id_schedule',
    );
  });
});

describe('MCP dispatch (coverage gate: every operation is callable)', () => {
  it('builds the REST request of every non-WebSocket operation', async () => {
    const { target, calls } = recordingTarget();
    let websocket = 0;
    for (const op of catalog().operations) {
      const pathParams = Object.fromEntries(op.pathParams.map((p) => [p.name, `v-${p.name}`]));
      if (op.transport === 'websocket') {
        await expect(dispatch(target, op, { pathParams })).rejects.toBeInstanceOf(DispatchError);
        websocket += 1;
        continue;
      }
      const result = await dispatch(target, op, {
        pathParams,
        query: { limit: 5 },
        ...(op.transport === 'raw_body'
          ? { bodyBase64: btoa('hello') }
          : op.bodySchema === null
            ? {}
            : { body: { probe: true } }),
      });
      expect(result.status, op.id).toBe(200);
      const call = calls[calls.length - 1];
      expect(call?.method).toBe(op.method);
      const expected = `/api/v2/t/acme${op.path.replace(/\{([^}]+)\}/g, (_, n: string) => `v-${n}`)}`;
      expect(call?.url.pathname, op.id).toBe(expected);
      expect(call?.url.searchParams.get('limit')).toBe('5');
      expect(call?.headers.get('authorization')).toBe('Bearer amb_live_test');
      if (op.transport === 'raw_body') {
        expect(call?.body).toBe('hello');
        expect(call?.headers.get('content-type')).toBe(op.bodyContentType);
      }
    }
    expect(websocket).toBeGreaterThan(0);
    expect(calls.length + websocket).toBe(catalog().operations.length);
  });

  it('refuses missing path parameters and encodes values', async () => {
    const { target, calls } = recordingTarget();
    const op = catalog().byId.get('crm.get_contacts_id');
    if (op === undefined) throw new Error('missing op');
    await expect(dispatch(target, op, {})).rejects.toMatchObject({ code: 'missing_path_param' });
    await dispatch(target, op, {
      pathParams: { id: 'a/b c' },
      query: { tag_id: ['x', 'y'], filter: { a: 1 } },
    });
    expect(calls[0]?.url.pathname).toBe('/api/v2/t/acme/contacts/a%2Fb%20c');
    expect(calls[0]?.url.searchParams.getAll('tag_id')).toEqual(['x', 'y']);
    expect(calls[0]?.url.searchParams.get('filter')).toBe('{"a":1}');
  });

  it('returns text and small binary responses', async () => {
    const csv = recordingTarget(
      () => new Response('a;b\n1;2\n', { headers: { 'content-type': 'text/csv' } }),
    );
    const exportOp = catalog().byId.get('reports.get_reports_report_id_export_csv');
    if (exportOp === undefined) throw new Error('missing op');
    expect((await dispatch(csv.target, exportOp, { pathParams: { reportId: 'r' } })).data).toBe(
      'a;b\n1;2\n',
    );
    const png = recordingTarget(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    );
    const logo = catalog().byId.get('crm.get_workspace_logo');
    if (logo === undefined) throw new Error('missing op');
    expect((await dispatch(png.target, logo, {})).data).toEqual({
      content_type: 'image/png',
      size: 3,
      base64: 'AQID',
    });
  });
});

describe('MCP tools', () => {
  const tools = buildTools(catalog());

  it('has valid, unique names and JSON schemas', () => {
    const names = tools.map((t) => t.definition.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(tool.definition.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.definition.inputSchema['type']).toBe('object');
      expect(tool.definition.description.length).toBeGreaterThan(10);
    }
    expect(names.slice(0, 4)).toEqual([
      'whoami',
      'search_operations',
      'describe_operation',
      'call_operation',
    ]);
    expect(tools.length).toBe(4 + CURATED_TOOLS.length);
  });

  it('runs each curated tool against its own endpoint', async () => {
    for (const spec of CURATED_TOOLS) {
      const tool = tools.find((t) => t.definition.name === spec.name);
      const op = tool?.operation;
      if (tool === undefined || op === undefined || op === null)
        throw new Error(`missing ${spec.name}`);
      expect(`${op.method} ${op.path}`).toBe(spec.operation);
      const { target, calls } = recordingTarget();
      const args = Object.fromEntries(op.pathParams.map((p) => [p.name, `v-${p.name}`]));
      const result = await tool.run(args, toolContext(target));
      expect(result.isError, spec.name).toBe(false);
      expect(calls[0]?.method).toBe(op.method);
      expect(calls[0]?.url.pathname).toBe(
        `/api/v2/t/acme${op.path.replace(/\{([^}]+)\}/g, (_, n: string) => `v-${n}`)}`,
      );
    }
  });

  it('splits flat arguments into path, query and body', async () => {
    const tool = tools.find((t) => t.definition.name === 'refund_order');
    const { target, calls } = recordingTarget();
    await tool?.run(
      { id: 'ord_1', amount_minor: 500, stripe: true, idempotency_key: 'k1' },
      toolContext(target),
    );
    expect(calls[0]?.url.pathname).toBe('/api/v2/t/acme/orders/ord_1/refunds');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ amount_minor: 500, stripe: true });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('k1');
    const search = tools.find((t) => t.definition.name === 'search_contacts');
    await search?.run({ q: 'ada', limit: 3 }, toolContext(target));
    expect(calls[1]?.url.search).toBe('?q=ada&limit=3');
    expect(calls[1]?.body).toBe('');
  });

  it('maps REST errors to tool errors with hints', async () => {
    const call = tools.find((t) => t.definition.name === 'call_operation');
    if (call === undefined) throw new Error('missing call_operation');
    const limited = recordingTarget(() =>
      Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '7' } }),
    );
    const r429 = await call.run({ id: 'crm.get_contacts' }, toolContext(limited.target));
    expect(r429.isError).toBe(true);
    expect(toolText(r429)).toMatchObject({ status: 429, error: 'rate_limited', retry_after: 7 });
    const forbidden = recordingTarget(() =>
      Response.json({ error: 'forbidden', missing: ['orders:refund'] }, { status: 403 }),
    );
    const r403 = await call.run(
      { id: 'crm.post_orders_id_refunds', path_params: { id: 'o' } },
      toolContext(forbidden.target),
    );
    expect(toolText(r403)).toMatchObject({ status: 403, missing: ['orders:refund'] });
    expect(String((toolText(r403) as Record<string, unknown>)['hint'])).toContain('orders:refund');
    const unknown = await call.run({ id: 'crm.nope' }, toolContext(forbidden.target));
    expect(unknown.isError).toBe(true);
    const ws = await call.run(
      { id: 'crm.get_automations_id_lock', path_params: { id: 'a' } },
      toolContext(forbidden.target),
    );
    expect(toolText(ws)).toMatchObject({ error: 'websocket_only' });
  });

  it('caps large results', async () => {
    const big = recordingTarget(() => Response.json({ data: 'x'.repeat(MAX_RESULT_CHARS * 2) }));
    const call = tools.find((t) => t.definition.name === 'call_operation');
    const result = await call?.run({ id: 'crm.get_contacts' }, toolContext(big.target));
    const text = result?.content[0]?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(JSON.parse(text)).toMatchObject({ truncated: true });
  });
});

describe('MCP endpoint', () => {
  let h: Harness;
  let owner: TestClient;
  let fullKey: string;
  let readKey: string;
  let rpcId = 0;

  async function rpc(key: string | null, method: string, params?: Record<string, unknown>) {
    rpcId += 1;
    return h
      .client()
      .post(
        MCP,
        { jsonrpc: '2.0', id: rpcId, method, ...(params === undefined ? {} : { params }) },
        key === null ? {} : { authorization: `Bearer ${key}` },
      );
  }

  async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
    const res = await rpc(key, 'tools/call', { name, arguments: args });
    const result = res.body['result'] as { content: Array<{ text: string }>; isError: boolean };
    return {
      status: res.status,
      isError: result.isError,
      data: JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    h = await createHarness();
    h.env.TENANT_DB = fakeTenantDbNamespace();
    const acme = await seedTenant(h, 'acme');
    const o = await seedUser(h, { email: 'owner@example.com' });
    await addMember(h, o.id, acme.id, 'owner');
    owner = await login(h, 'owner@example.com');
    await stepUp(h, owner);
    const full = await owner.post('/api/t/acme/api-keys', {
      name: 'mcp full',
      scopes: [...ROLE_PERMISSIONS.owner],
    });
    const read = await owner.post('/api/t/acme/api-keys', {
      name: 'mcp read',
      scopes: ['contacts:read', 'tasks:read'],
    });
    expect(full.status).toBe(201);
    expect(read.status).toBe(201);
    fullKey = String(full.body['key']);
    readKey = String(read.body['key']);
  });

  it('initializes with a negotiated protocol version', async () => {
    const res = await rpc(fullKey, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.body['result']).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'amabledata' },
    });
    const future = await rpc(fullKey, 'initialize', { protocolVersion: '2099-01-01' });
    expect((future.body['result'] as Record<string, unknown>)['protocolVersion']).toBe(
      '2025-06-18',
    );
  });

  it('requires a valid Bearer API key', async () => {
    const none = await rpc(null, 'initialize', {});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    const bad = await rpc('amb_live_' + 'x'.repeat(43), 'tools/list');
    expect(bad.status).toBe(401);
    expect(bad.body['error']).toBe('invalid_api_key');
    const badCall = await rpc('amb_live_' + 'x'.repeat(43), 'tools/call', {
      name: 'search_contacts',
      arguments: {},
    });
    expect(badCall.status).toBe(401);
    const cookieOnly = await owner.post(MCP, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(cookieOnly.status).toBe(401);
  });

  it('hides the workspace from keys of another tenant', async () => {
    const res = await h
      .client()
      .post(
        '/api/mcp/t/other',
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { authorization: `Bearer ${fullKey}` },
      );
    expect(res.status).toBe(404);
  });

  it('lists only the tools the key can use', async () => {
    const full = (await rpc(fullKey, 'tools/list')).body['result'] as {
      tools: Array<{ name: string; annotations: Record<string, unknown> }>;
    };
    const read = (await rpc(readKey, 'tools/list')).body['result'] as {
      tools: Array<{ name: string }>;
    };
    const fullNames = full.tools.map((t) => t.name);
    const readNames = read.tools.map((t) => t.name);
    expect(fullNames).toContain('create_contact');
    expect(fullNames).toContain('refund_order');
    expect(readNames).toEqual(
      expect.arrayContaining([
        'whoami',
        'search_operations',
        'call_operation',
        'search_contacts',
        'list_tasks',
      ]),
    );
    expect(readNames).not.toContain('create_contact');
    expect(readNames).not.toContain('list_orders');
    expect(full.tools.find((t) => t.name === 'refund_order')?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(full.tools.find((t) => t.name === 'search_contacts')?.annotations).toMatchObject({
      readOnlyHint: true,
    });
  });

  it('whoami reports the effective permissions', async () => {
    const me = await callTool(readKey, 'whoami');
    expect(me.data).toMatchObject({
      workspace: { slug: 'acme' },
      credential: 'api_key',
      role: 'owner',
      permissions: ['contacts:read', 'tasks:read'],
    });
    expect((me.data['tools'] as string[]).includes('create_contact')).toBe(false);
  });

  it('search_operations filters by scope and explains what is hidden', async () => {
    const modules = await callTool(readKey, 'search_operations');
    expect((modules.data['modules'] as unknown[]).length).toBe(OPENAPI_SOURCES.length);
    const create = await callTool(readKey, 'search_operations', { query: 'create contact' });
    expect((create.data['operations'] as Array<{ id: string }>).map((o) => o.id)).not.toContain(
      'crm.post_contacts',
    );
    expect(create.data['hidden_without_permission']).toBeGreaterThan(0);
    const all = await callTool(readKey, 'search_operations', {
      query: 'create contact',
      include_unavailable: true,
    });
    expect(all.data['operations']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'crm.post_contacts',
          available: false,
          missing: ['contacts:write'],
        }),
      ]),
    );
    const described = await callTool(readKey, 'describe_operation', { id: 'crm.post_contacts' });
    expect(described.data).toMatchObject({
      id: 'crm.post_contacts',
      available: false,
      method: 'POST',
      path: '/contacts',
    });
  });

  it('runs curated tools and call_operation through the REST API', async () => {
    const created = await callTool(fullKey, 'create_contact', {
      given_name: 'Ada',
      emails: [{ email: 'ada@example.com' }],
      idempotency_key: 'mcp-ada',
    });
    expect(created.isError).toBe(false);
    const id = String(created.data['id']);
    const again = await callTool(fullKey, 'create_contact', {
      given_name: 'Ada',
      emails: [{ email: 'ada@example.com' }],
      idempotency_key: 'mcp-ada',
    });
    expect(again.data['id']).toBe(id);
    const fetched = await callTool(readKey, 'call_operation', {
      id: 'crm.get_contacts_id',
      path_params: { id },
    });
    expect(fetched.data).toMatchObject({ id, given_name: 'Ada' });
    const listed = await callTool(readKey, 'search_contacts', { email: 'ada@example.com' });
    expect((listed.data['data'] as Array<{ id: string }>).map((c) => c.id)).toEqual([id]);
  });

  it('lets the REST API enforce scopes on direct calls', async () => {
    const denied = await callTool(readKey, 'call_operation', {
      id: 'crm.post_contacts',
      body: { given_name: 'Nope' },
    });
    expect(denied.isError).toBe(true);
    expect(denied.data).toMatchObject({
      status: 403,
      error: 'forbidden',
      missing: ['contacts:write'],
    });
    const hiddenTool = await callTool(readKey, 'create_contact', { given_name: 'Nope' });
    expect(hiddenTool.isError).toBe(true);
    const invalid = await callTool(fullKey, 'create_contact', { emails: 'not-a-list' });
    expect(invalid.isError).toBe(true);
    expect(invalid.data['status']).toBe(422);
  });

  it('speaks JSON-RPC: notifications, ping, batches, errors', async () => {
    const note = await h
      .client()
      .post(
        MCP,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { authorization: `Bearer ${fullKey}` },
      );
    expect(note.status).toBe(202);
    expect((await rpc(fullKey, 'ping')).body['result']).toEqual({});
    expect((await rpc(fullKey, 'nope/nope')).body['error']).toMatchObject({ code: -32601 });
    expect(
      (await rpc(fullKey, 'tools/call', { name: 'missing_tool' })).body['error'],
    ).toMatchObject({ code: -32602 });
    const invalid = await h
      .client()
      .post(MCP, { hello: 'world' }, { authorization: `Bearer ${fullKey}` });
    expect(invalid.status).toBe(400);
    const batch = await h.client().request(
      'POST',
      MCP,
      [
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
      ],
      { authorization: `Bearer ${fullKey}` },
    );
    expect(Array.isArray(batch.body)).toBe(true);
    expect((batch.body as unknown as unknown[]).length).toBe(2);
    expect(batch.status).toBe(200);
    expect((await h.client().get(MCP, { authorization: `Bearer ${fullKey}` })).status).toBe(405);
  });

  it('every owner permission is a known permission', () => {
    const known = new Set<Permission>(PERMISSIONS);
    for (const op of catalog().operations)
      if (op.permission !== null) expect(known.has(op.permission)).toBe(true);
  });
});
