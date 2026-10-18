import { APP_ENTITY_KINDS, appTriggerEventType, eventReadPermission, type AppEntityKind } from '@amable/core/apps';
import {
  inboundMessageSchema,
  messageStatusUpdateSchema,
  outboundMessageSchema,
  type Conversation,
  type ConversationMessage,
} from '@amable/api-types';
import type { Permission } from '@amable/core';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { getAuthServices } from '../auth/services';
import { CrmError } from '../crm/errors';
import type { AppEnv } from '../middleware';
import type { AuthApp } from '../middleware/context';
import { getAuth, getTenant, requirePermission, requireStepUpForSession } from '../middleware/access';
import { audit } from '../middleware/audit';
import { AppError } from './errors';
import { replayAppEvents } from './events';
import { installById } from './store';
import { collectAppData, eraseContactEverywhere } from './privacy';
import { appActor, tenantOp } from './tenant';
import type { AppDataEntry, AppEntityValue } from './tenant-ops';

/**
 * REST surface for apps (`/api/v2/t/:slug/apps/*`, app access tokens): the
 * app's own key/value storage, its values on records, timeline entries and
 * the replay log of its events. Plus the workspace-side views of app values
 * and the GDPR routes on contacts that fan out to apps.
 */

export const appApiRoutes = new Hono<AppEnv>();

function appErrorResponse(error: Error, c: Context<AppEnv>) {
  if (error instanceof AppError) {
    return c.json({ error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, error.status);
  }
  if (error instanceof CrmError) {
    return c.json({ error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, error.status as 400);
  }
  throw error;
}

appApiRoutes.onError(appErrorResponse);

function appOf(c: Context<AppEnv>): AuthApp {
  const auth = getAuth(c);
  if (auth.kind !== 'app') throw new AppError(403, 'app_token_required', 'this endpoint is for app access tokens');
  return auth.app;
}

const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const secretAd = (tenantId: string, appId: string, key: string) => `appdata:${tenantId}:${appId}:${key}`;

async function revealEntry(c: Context<AppEnv>, app: AuthApp, entry: AppDataEntry) {
  let value: unknown = null;
  try {
    const raw = entry.secret
      ? await (await getAuthServices(c.env)).secretBox.decrypt(entry.value, secretAd(app.tenantId, app.appId, entry.key))
      : entry.value;
    value = JSON.parse(raw) as unknown;
  } catch {
    value = null;
  }
  return { key: entry.key, value, secret: entry.secret, updated_at: entry.updated_at };
}

// ------------------------------------------------------- own key/value data

appApiRoutes.get('/data', async (c) => {
  const app = appOf(c);
  const prefix = c.req.query('prefix') ?? '';
  const entries = await tenantOp<AppDataEntry[]>(c.env, app.tenantId, 'apps.data.list', { appId: app.appId, prefix });
  return c.json({ data: await Promise.all(entries.map((e) => revealEntry(c, app, e))) });
});

appApiRoutes.get('/data/:key', async (c) => {
  const app = appOf(c);
  const key = c.req.param('key');
  if (!KEY_RE.test(key)) throw new AppError(422, 'validation_failed', 'invalid key');
  const entry = await tenantOp<AppDataEntry>(c.env, app.tenantId, 'apps.data.get', { appId: app.appId, key });
  return c.json(await revealEntry(c, app, entry));
});

const putSchema = z.strictObject({ value: z.unknown(), secret: z.boolean().optional() });

appApiRoutes.put('/data/:key', async (c) => {
  const app = appOf(c);
  if (app.cleanup) throw new AppError(403, 'app_uninstalling', 'only deletions are allowed after an uninstall');
  const key = c.req.param('key');
  if (!KEY_RE.test(key)) throw new AppError(422, 'validation_failed', 'invalid key');
  const body = putSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success || body.data.value === undefined) throw new AppError(422, 'validation_failed', 'value is required');
  const secret = body.data.secret === true;
  const raw = JSON.stringify(body.data.value);
  const stored = secret
    ? await (await getAuthServices(c.env)).secretBox.encrypt(raw, secretAd(app.tenantId, app.appId, key))
    : raw;
  const entry = await tenantOp<AppDataEntry>(c.env, app.tenantId, 'apps.data.set', {
    appId: app.appId,
    key,
    value: stored,
    secret,
  });
  return c.json(await revealEntry(c, app, entry));
});

appApiRoutes.delete('/data/:key', async (c) => {
  const app = appOf(c);
  const key = c.req.param('key');
  if (!KEY_RE.test(key)) throw new AppError(422, 'validation_failed', 'invalid key');
  return c.json(await tenantOp(c.env, app.tenantId, 'apps.data.delete', { appId: app.appId, key }));
});

// ----------------------------------------------------------- record values

const ENTITY_PERMISSIONS: Record<AppEntityKind, { read: Permission; write: Permission }> = {
  contact: { read: 'contacts:read', write: 'contacts:write' },
  company: { read: 'contacts:read', write: 'contacts:write' },
  opportunity: { read: 'opportunities:read', write: 'opportunities:write' },
  order: { read: 'orders:read', write: 'orders:write' },
};

function entityParam(c: Context<AppEnv>): AppEntityKind {
  const entity = c.req.param('entity') as AppEntityKind;
  if (!APP_ENTITY_KINDS.includes(entity)) throw new AppError(404, 'not_found', 'unknown entity');
  return entity;
}

function assertCan(c: Context<AppEnv>, permission: Permission): void {
  if (!getTenant(c).can(permission)) throw new AppError(403, 'forbidden', `missing ${permission}`);
}

/**
 * Values on a record. Apps read and write their own; members (UI, API keys)
 * read every app's values on the record.
 */
appApiRoutes.get('/entities/:entity/:id', async (c) => {
  const entity = entityParam(c);
  assertCan(c, ENTITY_PERMISSIONS[entity].read);
  const auth = getAuth(c);
  const values = await tenantOp<AppEntityValue[]>(c.env, getTenant(c).tenant.id, 'apps.entity.get', {
    ...(auth.kind === 'app' ? { appId: auth.app.appId } : {}),
    entity,
    entityId: c.req.param('id'),
  });
  return c.json({ data: values });
});

const patchValuesSchema = z.strictObject({
  values: z.record(z.string().regex(KEY_RE), z.unknown()).refine((v) => Object.keys(v).length <= 50, 'at most 50 keys'),
});

appApiRoutes.patch('/entities/:entity/:id', async (c) => {
  const app = appOf(c);
  if (app.cleanup) throw new AppError(403, 'app_uninstalling', 'only deletions are allowed after an uninstall');
  const entity = entityParam(c);
  assertCan(c, ENTITY_PERMISSIONS[entity].write);
  const body = patchValuesSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError(422, 'validation_failed', body.error.issues[0]?.message ?? 'invalid body');
  const values = await tenantOp<AppEntityValue[]>(
    c.env,
    app.tenantId,
    'apps.entity.set',
    { appId: app.appId, entity, entityId: c.req.param('id'), values: body.data.values },
    appActor(app.appId),
  );
  return c.json({ data: values });
});

// ----------------------------------------------------------------- timeline

const timelineSchema = z.strictObject({
  contact_id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  icon: z.enum(['message', 'mail', 'phone', 'check', 'warning', 'info', 'app']).optional(),
  url: z.string().url().max(2000).startsWith('https://').optional(),
  occurred_at: z.string().datetime().optional(),
});

appApiRoutes.post('/timeline', async (c) => {
  const app = appOf(c);
  assertCan(c, 'contacts:write');
  const body = timelineSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new AppError(422, 'validation_failed', body.error.issues[0]?.message ?? 'invalid body');
  const { occurred_at, ...rest } = body.data;
  const created = await tenantOp(
    c.env,
    app.tenantId,
    'apps.timeline.add',
    {
      appId: app.appId,
      appName: app.appName,
      contactId: rest.contact_id,
      title: rest.title,
      body: rest.body,
      icon: rest.icon,
      url: rest.url,
      ...(occurred_at === undefined ? {} : { occurred_at: Date.parse(occurred_at) }),
    },
    appActor(app.appId),
  );
  return c.json(created, 201);
});

// ------------------------------------------------------------------- replay

/** Events sent to this install after `since` (its `sequence`), oldest first, 30 days. */
appApiRoutes.get('/events', async (c) => {
  const app = appOf(c);
  const since = Math.max(Number(c.req.query('since')) || 0, 0);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);
  const page = await replayAppEvents(c.env, app.installId, { since, limit });
  // Scopes can shrink after an update: events the app may no longer read are withheld.
  const tenant = getTenant(c);
  return c.json({
    ...page,
    data: page.data.filter((e) => {
      const permission = eventReadPermission(e.type);
      return permission === null || tenant.can(permission);
    }),
  });
});

const triggerSchema = z.strictObject({
  key: z.string().min(1).max(40),
  contact_id: z.string().min(1).max(64),
  /** Same id fires once (dedupe across retries of the app). */
  event_id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/).optional(),
  data: z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
});

/** Fires one of the app's `automation_triggers` for a contact (goal `app_event`). */
appApiRoutes.post('/events', requirePermission('automations:trigger'), async (c) => {
  const app = appOf(c);
  const parsed = triggerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'validation_failed', parsed.error.issues[0]?.message ?? 'invalid body');
  const install = await installById(c.env.DB, app.installId);
  const trigger = install?.manifest.extensions.automation_triggers?.find((t) => t.key === parsed.data.key);
  if (install === null || trigger === undefined) {
    throw new AppError(422, 'unknown_trigger', `the manifest declares no trigger ${parsed.data.key}`);
  }
  const tenantId = getTenant(c).tenant.id;
  await tenantOp(c.env, tenantId, 'contacts.get', { id: parsed.data.contact_id }, appActor(app.appId));
  const id = `app:${app.appId}:${parsed.data.event_id ?? crypto.randomUUID()}`;
  const name = appTriggerEventType(app.appId, trigger.key);
  const result = await c.env.ENGINE.get(c.env.ENGINE.idFromName(tenantId)).ingest(tenantId, [
    {
      id,
      type: 'app.event',
      occurredAt: new Date().toISOString(),
      payload: { contactId: parsed.data.contact_id, appId: app.appId, key: trigger.key, name, data: parsed.data.data ?? {} },
    },
  ]);
  return c.json({ event_id: id, event: name, matched: result.matched }, 202);
});

// ---------------------------------------------------- conversation channels

async function channelOf(c: Context<AppEnv>, app: AuthApp, key: string) {
  const install = await installById(c.env.DB, app.installId);
  const channel = install?.manifest.extensions.channels?.find((ch) => ch.key === key);
  if (channel === undefined) throw new AppError(422, 'unknown_channel', `the manifest declares no channel ${key}`);
  return channel;
}

/** A message the app received from a contact: it lands in the shared inbox. */
appApiRoutes.post('/messages/inbound', async (c) => {
  const app = appOf(c);
  assertCan(c, 'conversations:write');
  const parsed = inboundMessageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'validation_failed', parsed.error.issues[0]?.message ?? 'invalid body');
  const channel = await channelOf(c, app, parsed.data.channel);
  const result = await tenantOp<{ conversation: Conversation; message: ConversationMessage; duplicate: boolean }>(
    c.env,
    app.tenantId,
    'conversations.receive',
    { appId: app.appId, addressField: channel.address_field, message: parsed.data },
    appActor(app.appId),
  );
  return c.json(
    { conversation_id: result.conversation.id, message_id: result.message.id, contact_id: result.conversation.contact?.id ?? null, duplicate: result.duplicate },
    result.duplicate ? 200 : 201,
  );
});

/**
 * A message the app sent on its own (an automation step, the team's phone app
 * in coexistence): it lands in the thread as sent, without being sent again.
 */
appApiRoutes.post('/messages/outbound', async (c) => {
  const app = appOf(c);
  assertCan(c, 'conversations:write');
  const parsed = outboundMessageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'validation_failed', parsed.error.issues[0]?.message ?? 'invalid body');
  const channel = await channelOf(c, app, parsed.data.channel);
  const result = await tenantOp<{ conversation: Conversation; message: ConversationMessage; duplicate: boolean }>(
    c.env,
    app.tenantId,
    'conversations.recordOutbound',
    { appId: app.appId, addressField: channel.address_field, message: parsed.data },
    appActor(app.appId),
  );
  return c.json(
    { conversation_id: result.conversation.id, message_id: result.message.id, contact_id: result.conversation.contact?.id ?? null, duplicate: result.duplicate },
    result.duplicate ? 200 : 201,
  );
});

/** Delivery update of a message the CRM sent through the app (by the app's `external_id`). */
appApiRoutes.post('/messages/status', async (c) => {
  const app = appOf(c);
  assertCan(c, 'conversations:write');
  const parsed = messageStatusUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'validation_failed', parsed.error.issues[0]?.message ?? 'invalid body');
  await channelOf(c, app, parsed.data.channel);
  const message = await tenantOp<ConversationMessage | null>(
    c.env,
    app.tenantId,
    'conversations.deliveryByExternalId',
    { appId: app.appId, channelKey: parsed.data.channel, externalId: parsed.data.external_id, status: parsed.data.status, error: parsed.data.error },
    appActor(app.appId),
  );
  if (message === null) throw new AppError(404, 'not_found', 'no message with this external_id');
  return c.json({ message_id: message.id, status: message.status });
});

// ------------------------------------------------------- GDPR on contacts

export const contactPrivacyRoutes = new Hono<AppEnv>();

contactPrivacyRoutes.onError(appErrorResponse);

/**
 * Right to erasure: irreversible, so a member with write + export rights and a
 * fresh second factor (API keys allowed, apps never).
 */
contactPrivacyRoutes.post(
  '/contacts/:id/erase',
  requirePermission('contacts:write', 'contacts:export'),
  requireStepUpForSession(),
  async (c) => {
    if (getAuth(c).kind === 'app') throw new AppError(403, 'forbidden', 'apps cannot erase contacts');
    const result = await eraseContactEverywhere(c.env, getTenant(c).tenant.id, c.req.param('id'), c.get('services').now());
    await audit(c, 'contact.erased', { target: c.req.param('id'), details: { apps: result.apps.length } });
    return c.json({ ok: true, request_id: result.request_id, apps_notified: result.apps });
  },
);

/** Right of access: the contact as stored by the CRM plus what each app holds. */
contactPrivacyRoutes.post('/contacts/:id/data-request', requirePermission('contacts:export'), async (c) => {
  if (getAuth(c).kind === 'app') throw new AppError(403, 'forbidden', 'apps cannot run data requests');
  const tenantId = getTenant(c).tenant.id;
  const id = c.req.param('id');
  const contact = await tenantOp(c.env, tenantId, 'contacts.get', { id });
  const apps = await collectAppData(c.env, tenantId, id, c.get('services').now());
  await audit(c, 'contact.data_requested', { target: id, details: { apps: apps.apps.length } });
  return c.json({ contact, app_values: apps.stored, apps: apps.apps, request_id: apps.request_id });
});
