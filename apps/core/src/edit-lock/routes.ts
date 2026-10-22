import { z, type OpenAPIHono } from '@hono/zod-openapi';
import { editLockStateSchema, errorResponseSchema, idSchema } from '@amable/api-types';
import type { Permission } from '@amable/core';
import type { Context } from 'hono';
import { crmRoute, json } from '../crm/api/core';
import { getAuth, getTenant, HttpError, type AppEnv } from '../middleware';
import { EDIT_SESSION_HEADERS, type EditLockKind } from './lock';
import type { EditSession } from './session';

type Ctx = Context<AppEnv>;

const errorJson = (description: string) => json(errorResponseSchema, description);

/** OpenAPI entry of the 423 every lock-guarded write can return. */
export const LOCKED_RESPONSE = {
  423: errorJson('Another user holds the edit lock (`locked`)'),
} as const;

const LOCKED_MESSAGES: Record<EditLockKind, string> = {
  pages: 'another user is editing this page',
  automations: 'another user is editing this automation',
  broadcasts: 'another user is editing this broadcast',
  templates: 'another user is editing this template',
  forms: 'another user is editing this form',
};

/** Pages keep their original instance names so locks held across a deploy survive. */
function lockName(tenantId: string, kind: EditLockKind, id: string): string {
  return kind === 'pages' ? `${tenantId}:${id}` : `${tenantId}:${kind}:${id}`;
}

export function lockStub(c: Ctx, kind: EditLockKind, id: string): DurableObjectStub<EditSession> | null {
  const ns = c.env.EDIT_SESSION;
  if (ns === undefined) return null;
  return ns.get(ns.idFromName(lockName(getTenant(c).tenant.id, kind, id)));
}

/**
 * Rejects a write with 423 `locked` while another user holds the edit lock.
 * Without a holder (nobody in the editor, API keys) writes go through; without
 * the binding the lock is not enforced at all.
 */
export async function assertEditable(c: Ctx, kind: EditLockKind, id: string): Promise<void> {
  const stub = lockStub(c, kind, id);
  if (stub !== null && !(await stub.canSave(getAuth(c).user.id))) {
    throw new HttpError(423, 'locked', { message: LOCKED_MESSAGES[kind] });
  }
}

export interface EditLockRoutes {
  kind: EditLockKind;
  /** Collection path, e.g. `/automations`. */
  basePath: string;
  /** Name of the id path parameter (`id`, or `formId` for forms). */
  param?: string;
  tag: string;
  /** Joining the lock (editors only). */
  write: Permission;
  /** Reading the lock state. */
  read: Permission;
  /** Forcing the holder out. */
  takeover: Permission;
  /** Throws (404) when the resource does not exist. */
  exists: (c: Ctx, id: string) => Promise<unknown>;
}

/**
 * `GET {basePath}/{id}/lock` (WebSocket to the resource's `EditSession`) and
 * `GET {basePath}/{id}/lock/status`.
 */
export function registerEditLockRoutes(router: OpenAPIHono<AppEnv>, options: EditLockRoutes): void {
  const param = options.param ?? 'id';
  const params = z.object({ [param]: idSchema });
  const tags = [options.tag];
  const idOf = (c: Ctx) => c.req.param(param) ?? '';

  router.openapi(
    crmRoute(options.write, {
      method: 'get',
      path: `${options.basePath}/{${param}}/lock`,
      tags,
      summary: `WebSocket upgrade to the edit lock. Server → client \`{type:"state",holder,role,waiting}\`; client → server \`{type:"heartbeat"}\` every 10 s, \`{type:"release"}\`, \`{type:"takeover"}\` (${options.takeover})`,
      request: { params },
      responses: {
        101: { description: 'Switching protocols' },
        426: errorJson('Not a WebSocket upgrade'),
        503: errorJson('Lock service unavailable'),
      },
    }),
    async (c) => {
      const id = idOf(c);
      if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
        return c.json({ error: 'websocket_required', message: 'expected a WebSocket upgrade' }, 426);
      }
      const origin = c.req.header('origin');
      if (origin !== undefined && !sameApp(c, origin)) {
        return c.json({ error: 'origin_not_allowed', message: 'cross-site WebSocket refused' }, 403);
      }
      const stub = lockStub(c, options.kind, id);
      if (stub === null) return lockUnavailable(c);
      await options.exists(c, id);
      const user = getAuth(c).user;
      const tenant = getTenant(c);
      const headers = new Headers(c.req.raw.headers);
      const h = EDIT_SESSION_HEADERS;
      headers.set(h.userId, user.id);
      headers.set(h.userName, user.name ?? user.email);
      headers.set(h.canTakeover, tenant.can(options.takeover) ? '1' : '0');
      headers.set(h.tenantId, tenant.tenant.id);
      headers.set(h.kind, options.kind);
      headers.set(h.resourceId, id);
      headers.set(h.takeoverPermission, options.takeover);
      const res = await stub.fetch(new Request('https://edit-session.internal/connect', { headers }));
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: new Headers(res.headers),
        webSocket: res.webSocket,
      }) as never;
    },
  );
  router.openapi(
    crmRoute(options.read, {
      method: 'get',
      path: `${options.basePath}/{${param}}/lock/status`,
      tags,
      summary: 'Who is editing (same state as the WebSocket, for the caller)',
      request: { params },
      responses: { 200: json(editLockStateSchema, 'Lock state'), 503: errorJson('Lock service unavailable') },
    }),
    async (c) => {
      const stub = lockStub(c, options.kind, idOf(c));
      if (stub === null) return lockUnavailable(c);
      return c.json(await stub.status(getAuth(c).user.id), 200);
    },
  );
}

const lockUnavailable = (c: Ctx) =>
  c.json({ error: 'lock_unavailable', message: 'EDIT_SESSION binding missing' }, 503);

function sameApp(c: Ctx, origin: string): boolean {
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = new URL(c.req.url).host;
  const app = c.env.APP_ORIGIN === undefined ? null : new URL(c.env.APP_ORIGIN).host;
  const extra = (c.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
    .map((o) => {
      try {
        return new URL(o).host;
      } catch {
        return '';
      }
    });
  return host === own || host === app || extra.includes(host);
}
