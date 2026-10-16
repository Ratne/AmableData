import type { TicketCategory } from '@amable/core/platform';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../middleware';
import { getSessionAuth, getTenant, jsonError, parseJson } from '../../middleware';
import { ControlPlaneError, type ControlPlaneClient } from '../client';
import { actingUser, controlPlaneFailure, isRecord, requirePlatform } from './shared';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const TICKET_CATEGORIES = ['question', 'bug', 'billing', 'feature', 'other'] as const satisfies readonly TicketCategory[];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ticketInput = z.strictObject({
  subject: z.string().trim().min(3).max(200),
  category: z.enum(TICKET_CATEGORIES),
  body: z.string().trim().min(1).max(10_000),
});
const messageInput = z.strictObject({ body: z.string().trim().min(1).max(10_000) });
const ideaInput = z.strictObject({
  title: z.string().trim().min(3).max(140),
  body: z.string().trim().max(5_000),
});

type Handler = (c: Context<AppEnv>, cp: ControlPlaneClient) => Promise<Response>;

/** Runs `handler` with the control plane client; maps open source and upstream failures. */
function platform(handler: Handler) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const cp = requirePlatform(c);
    if (cp instanceof Response) return cp;
    try {
      return await handler(c, cp);
    } catch (error) {
      if (error instanceof ControlPlaneError) return controlPlaneFailure(c, error);
      throw error;
    }
  };
}

function idParam(c: Context<AppEnv>, name: string): string | null {
  const value = c.req.param(name);
  return value !== undefined && ID_RE.test(value) ? value : null;
}

interface TicketDetail {
  ticket: Record<string, unknown>;
  messages: unknown[];
  attachments: unknown[];
}

/** Ticket detail, or null when it does not belong to the current tenant (same 404 as unknown). */
async function tenantTicket(c: Context<AppEnv>, cp: ControlPlaneClient, id: string): Promise<TicketDetail | null> {
  let detail: unknown;
  try {
    detail = await cp.get(`/support/tickets/${id}`);
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 404) return null;
    throw error;
  }
  if (!isRecord(detail) || !isRecord(detail.ticket)) return null;
  if (detail.ticket.tenantId !== getTenant(c).tenant.id) return null;
  return {
    ticket: detail.ticket,
    messages: Array.isArray(detail.messages) ? detail.messages : [],
    attachments: Array.isArray(detail.attachments) ? detail.attachments : [],
  };
}

function voterKey(c: Context<AppEnv>, cp: ControlPlaneClient): string {
  return `inst:${cp.installationId}:${getSessionAuth(c).user.id}`;
}

async function ideaVote(c: Context<AppEnv>, cp: ControlPlaneClient, method: 'POST' | 'DELETE'): Promise<Response> {
  const id = idParam(c, 'id');
  if (id === null) return jsonError(c, 404, 'not_found');
  const res = await cp.raw(`/ideas/${id}/vote`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: actingUser(c) }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ControlPlaneError(res.status, isRecord(body) && typeof body.error === 'string' ? body.error : 'error');
  }
  return c.json(body);
}

/** `/t/:slug/platform/{support,ideas,changelog}` — license-authenticated proxy to the control plane. */
export function proxyRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get(
    '/support/tickets',
    platform(async (c, cp) => {
      const tenantId = encodeURIComponent(getTenant(c).tenant.id);
      const body = await cp.get<{ tickets?: unknown }>(`/support/tickets?tenantId=${tenantId}`);
      return c.json({ tickets: Array.isArray(body.tickets) ? body.tickets : [] });
    }),
  );

  routes.post(
    '/support/tickets',
    platform(async (c, cp) => {
      const input = await parseJson(c, ticketInput);
      const body = await cp.post<{ ticket: unknown }>('/support/tickets', { actor: actingUser(c), ...input });
      return c.json({ ticket: body.ticket }, 201);
    }),
  );

  routes.get(
    '/support/tickets/:id',
    platform(async (c, cp) => {
      const id = idParam(c, 'id');
      const detail = id === null ? null : await tenantTicket(c, cp, id);
      if (detail === null) return jsonError(c, 404, 'not_found');
      return c.json(detail);
    }),
  );

  routes.post(
    '/support/tickets/:id/messages',
    platform(async (c, cp) => {
      const id = idParam(c, 'id');
      const input = await parseJson(c, messageInput);
      if (id === null || (await tenantTicket(c, cp, id)) === null) return jsonError(c, 404, 'not_found');
      const body = await cp.post<{ message: unknown }>(`/support/tickets/${id}/messages`, {
        actor: actingUser(c),
        body: input.body,
      });
      return c.json({ message: body.message }, 201);
    }),
  );

  routes.post(
    '/support/tickets/:id/attachments',
    platform(async (c, cp) => {
      const id = idParam(c, 'id');
      if (id === null) return jsonError(c, 404, 'not_found');
      const declared = Number(c.req.header('content-length') ?? '0');
      if (declared > ATTACHMENT_MAX_BYTES + 64 * 1024) return jsonError(c, 413, 'attachment_too_large');
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        return jsonError(c, 422, 'invalid_multipart');
      }
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0) return jsonError(c, 422, 'file_required');
      if (file.size > ATTACHMENT_MAX_BYTES) return jsonError(c, 413, 'attachment_too_large');
      if ((await tenantTicket(c, cp, id)) === null) return jsonError(c, 404, 'not_found');
      const upstream = new FormData();
      upstream.set('file', file, file.name.slice(0, 200));
      upstream.set('actor', JSON.stringify(actingUser(c)));
      const res = await cp.raw(`/support/tickets/${id}/attachments`, { method: 'POST', body: upstream });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new ControlPlaneError(res.status, isRecord(body) && typeof body.error === 'string' ? body.error : 'error');
      }
      return c.json({ attachment: isRecord(body) ? body.attachment : null }, 201);
    }),
  );

  routes.get(
    '/support/tickets/:id/attachments/:attachmentId',
    platform(async (c, cp) => {
      const id = idParam(c, 'id');
      const attachmentId = idParam(c, 'attachmentId');
      const detail = id === null || attachmentId === null ? null : await tenantTicket(c, cp, id);
      const meta = detail?.attachments.find((a) => isRecord(a) && a.id === attachmentId);
      if (!isRecord(meta) || attachmentId === null) return jsonError(c, 404, 'not_found');
      const res = await cp.raw(`/support/attachments/${attachmentId}`, { method: 'GET' });
      if (!res.ok) throw new ControlPlaneError(res.status, 'error');
      const filename = typeof meta.filename === 'string' ? meta.filename : 'attachment';
      return new Response(res.body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${filename.replace(/[^\w.\- ]/g, '_')}"`,
        },
      });
    }),
  );

  routes.get(
    '/ideas',
    platform(async (c, cp) => {
      const key = encodeURIComponent(voterKey(c, cp));
      const body = await cp.get<{ ideas?: unknown; changelog?: unknown }>(`/ideas?voterKey=${key}`);
      return c.json({
        ideas: Array.isArray(body.ideas) ? body.ideas : [],
        changelog: Array.isArray(body.changelog) ? body.changelog : [],
      });
    }),
  );

  routes.get(
    '/changelog',
    platform(async (c, cp) => {
      const body = await cp.get<{ changelog?: unknown }>(`/ideas?voterKey=${encodeURIComponent(voterKey(c, cp))}`);
      return c.json({ changelog: Array.isArray(body.changelog) ? body.changelog : [] });
    }),
  );

  routes.post(
    '/ideas',
    platform(async (c, cp) => {
      const input = await parseJson(c, ideaInput);
      const body = await cp.post<{ idea: unknown }>('/ideas', { actor: actingUser(c), ...input });
      return c.json({ idea: body.idea }, 201);
    }),
  );

  routes.post('/ideas/:id/vote', platform((c, cp) => ideaVote(c, cp, 'POST')));
  routes.delete('/ideas/:id/vote', platform((c, cp) => ideaVote(c, cp, 'DELETE')));

  return routes;
}
