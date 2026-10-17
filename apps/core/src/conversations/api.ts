import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  conversationChannelSchema,
  conversationEnvelopeSchema,
  conversationMessageEnvelopeSchema,
  conversationMessageSchema,
  conversationSchema,
  idParamSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  pageOf,
  sendMessageSchema,
  startConversationSchema,
  updateConversationSchema,
} from '@amable/api-types';
import { getAuth, getTenant, type AppEnv } from '../middleware';
import { actorOf, callCrm, crmRoute, CrmHttpError, json, jsonBody } from '../crm/api/core';
import type { AddressField } from './ops';
import { deliverMessage, findChannel, tenantChannels } from './service';

const tags = ['Conversations'];
const countsSchema = z.object({ open: z.number().int(), unassigned: z.number().int(), mine: z.number().int(), unread: z.number().int() });

const invalid = (path: string, message: string) =>
  new CrmHttpError({ code: 'validation_failed', status: 422, message, details: [{ path, message }] });

export function registerConversationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('conversations:read', {
      method: 'get',
      path: '/conversations',
      tags,
      summary: 'List conversations of the shared inbox',
      description: 'Newest activity first. `assigned_to=me` lists the caller\'s conversations, `assigned_to=none` the unassigned ones.',
      request: { query: listConversationsQuerySchema },
      responses: { 200: json(pageOf(conversationSchema), 'A page of conversations') },
    }),
    async (c) => c.json(await callCrm(c, 'conversations.list', { ...c.req.valid('query'), me: getAuth(c).user.id }), 200),
  );

  app.openapi(
    crmRoute('conversations:read', {
      method: 'get',
      path: '/conversations/counts',
      tags,
      summary: 'Inbox counters',
      responses: { 200: json(countsSchema, 'Open, unassigned, assigned to the caller, with unread messages') },
    }),
    async (c) => c.json(await callCrm(c, 'conversations.counts', { me: getAuth(c).user.id }), 200),
  );

  app.openapi(
    crmRoute('conversations:read', {
      method: 'get',
      path: '/conversations/channels',
      tags,
      summary: 'Channels provided by the installed apps',
      responses: { 200: json(z.object({ data: z.array(conversationChannelSchema) }), 'Channels') },
    }),
    async (c) => c.json({ data: await tenantChannels(c.env, getTenant(c).tenant.id) }, 200),
  );

  app.openapi(
    crmRoute('conversations:write', {
      method: 'post',
      path: '/conversations',
      tags,
      summary: 'Write first to a contact on a channel',
      description: 'Finds or opens the thread with the contact\'s address on the channel (phone or email, as the channel declares) and sends the message.',
      request: { body: jsonBody(startConversationSchema) },
      responses: { 201: json(z.object({ data: conversationSchema, message: conversationMessageSchema }), 'The conversation and the message') },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const tenantId = getTenant(c).tenant.id;
      const [appId = '', key = ''] = input.channel.split(':');
      const channel = await findChannel(c.env, tenantId, appId, key);
      if (channel === null) throw invalid('channel', 'this channel is not installed');
      const queued = await callCrm(c, 'conversations.start', {
        appId,
        channelKey: key,
        addressField: channel.def.address_field as AddressField,
        contactId: input.contact_id,
        text: input.text,
      });
      const message = await deliverMessage(c.env, tenantId, queued, actorOf(c));
      const conversation = await callCrm(c, 'conversations.get', { id: queued.conversation.id });
      return c.json({ data: conversation, message }, 201);
    },
  );

  app.openapi(
    crmRoute('conversations:read', {
      method: 'get',
      path: '/conversations/{id}',
      tags,
      summary: 'Get a conversation',
      request: { params: idParamSchema },
      responses: { 200: json(conversationEnvelopeSchema, 'The conversation') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'conversations.get', c.req.valid('param')) }, 200),
  );

  app.openapi(
    crmRoute('conversations:read', {
      method: 'get',
      path: '/conversations/{id}/messages',
      tags,
      summary: 'Messages of a conversation',
      description: 'Newest first; `next_cursor` loads older messages. Internal notes are included (`direction: note`).',
      request: { params: idParamSchema, query: listMessagesQuerySchema },
      responses: { 200: json(pageOf(conversationMessageSchema), 'A page of messages') },
    }),
    async (c) => c.json(await callCrm(c, 'conversations.messages', { ...c.req.valid('query'), ...c.req.valid('param') }), 200),
  );

  app.openapi(
    crmRoute('conversations:write', {
      method: 'patch',
      path: '/conversations/{id}',
      tags,
      summary: 'Assign, close or reopen a conversation',
      request: { params: idParamSchema, body: jsonBody(updateConversationSchema) },
      responses: { 200: json(conversationEnvelopeSchema, 'The updated conversation') },
    }),
    async (c) => {
      const data = c.req.valid('json');
      if (data.assigned_to !== undefined && data.assigned_to !== null) {
        const member = await c.env.DB.prepare(`SELECT 1 AS ok FROM memberships WHERE user_id = ? AND tenant_id = ?`)
          .bind(data.assigned_to, getTenant(c).tenant.id)
          .first<{ ok: number }>();
        if (member === null) throw invalid('assigned_to', 'not a member of this workspace');
      }
      return c.json({ data: await callCrm(c, 'conversations.update', { id: c.req.valid('param').id, data }) }, 200);
    },
  );

  app.openapi(
    crmRoute('conversations:read', {
      method: 'post',
      path: '/conversations/{id}/read',
      tags,
      summary: 'Mark a conversation as read',
      request: { params: idParamSchema },
      responses: { 200: json(conversationEnvelopeSchema, 'The conversation') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'conversations.read', c.req.valid('param')) }, 200),
  );

  app.openapi(
    crmRoute('conversations:write', {
      method: 'post',
      path: '/conversations/{id}/messages',
      tags,
      summary: 'Reply, or add an internal note',
      description: 'Replies are sent through the channel app right away; the message comes back as `sent` or `failed` (with `error`). Later delivery updates arrive from the app.',
      request: { params: idParamSchema, body: jsonBody(sendMessageSchema) },
      responses: { 201: json(conversationMessageEnvelopeSchema, 'The message') },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const queued = await callCrm(c, 'conversations.addMessage', { id: c.req.valid('param').id, text: input.text, note: input.note });
      return c.json({ data: await deliverMessage(c.env, getTenant(c).tenant.id, queued, actorOf(c)) }, 201);
    },
  );
}
