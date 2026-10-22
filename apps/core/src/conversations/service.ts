import { channelTemplateSchema, type ChannelTemplate, type ConversationChannel, type ConversationMessage } from '@amable/api-types';
import { callApp } from '../apps/call';
import { tenantInstalls, type AppInstall } from '../apps/store';
import { tenantOp } from '../apps/tenant';
import type { CrmActor } from '../crm/context';
import type { Env } from '../env';
import type { AddressField, QueuedMessage } from './ops';

/** Channels come from installed apps: `extensions.channels` of their manifest. */

export const CHANNEL_SEND_TIMEOUT_MS = 10_000;

type ChannelDef = NonNullable<AppInstall['manifest']['extensions']['channels']>[number];

export interface FoundChannel {
  readonly install: AppInstall;
  readonly def: ChannelDef;
}

const usable = (install: AppInstall) => install.status === 'active' || install.status === 'paused';

export async function tenantChannels(env: Env, tenantId: string): Promise<ConversationChannel[]> {
  const installs = await tenantInstalls(env.DB, tenantId);
  return installs.filter(usable).flatMap((install) =>
    (install.manifest.extensions.channels ?? []).map((def: ChannelDef) => ({
      id: `${install.appId}:${def.key}`,
      app_id: install.appId,
      key: def.key,
      app_name: install.manifest.name,
      name: def.name,
      kind: def.kind,
      address_field: def.address_field as AddressField,
      icon_url: install.manifest.icon_url,
      paused: install.status === 'paused',
      reply_window_hours: def.reply_window_hours ?? null,
      templates: def.templates_endpoint !== undefined,
    })),
  );
}

export async function findChannel(env: Env, tenantId: string, appId: string, key: string): Promise<FoundChannel | null> {
  const installs = await tenantInstalls(env.DB, tenantId);
  const install = installs.find((i) => i.appId === appId && usable(i));
  const def = install?.manifest.extensions.channels?.find((c) => c.key === key);
  return install === undefined || def === undefined ? null : { install, def };
}

export const CHANNEL_TEMPLATES_TIMEOUT_MS = 8_000;
const MAX_TEMPLATES = 500;

/**
 * Templates the team can send on a channel, asked to the app each time (they
 * change when Meta approves or rejects one). Malformed entries are dropped;
 * `notice` is the app's reason for an empty list; `null` when the app does not answer.
 */
export async function channelTemplates(
  env: Env,
  found: FoundChannel,
): Promise<{ templates: ChannelTemplate[]; notice: string | null } | null> {
  if (found.def.templates_endpoint === undefined) return { templates: [], notice: null };
  const result = await callApp(env, found.install, found.def.templates_endpoint, { channel: found.def.key }, {
    kind: 'channel',
    timeoutMs: CHANNEL_TEMPLATES_TIMEOUT_MS,
    maxBytes: 1024 * 1024,
  });
  if (!result.ok) return null;
  const body = result.body as { templates?: unknown; notice?: unknown } | null;
  const list = body?.templates;
  if (!Array.isArray(list)) return null;
  const templates = list.slice(0, MAX_TEMPLATES).flatMap((item) => {
    const parsed = channelTemplateSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  const notice = typeof body?.notice === 'string' && body.notice.trim() !== '' ? body.notice.trim().slice(0, 300) : null;
  return { templates, notice };
}

/**
 * Sends a queued message through its channel app and records the outcome.
 * The app answers `{ external_id, status? }`; anything else is a failure the
 * agent sees on the message (they can write again).
 */
export async function deliverMessage(
  env: Env,
  tenantId: string,
  queued: QueuedMessage,
  actor: CrmActor,
): Promise<ConversationMessage> {
  const delivery = queued.delivery;
  if (delivery === null) return queued.message;
  const fail = (error: string) =>
    tenantOp<ConversationMessage>(env, tenantId, 'conversations.delivery', { messageId: queued.message.id, status: 'failed', error }, actor);
  const found = await findChannel(env, tenantId, delivery.appId, delivery.channelKey);
  if (found === null) return fail('the channel app is not installed');
  if (found.install.status !== 'active') return fail('the channel app is paused');
  const contact =
    delivery.contactId === null || !found.install.scopes.includes('contacts:read')
      ? null
      : { id: delivery.contactId, name: queued.conversation.contact?.name ?? null };
  const result = await callApp(
    env,
    found.install,
    found.def.send_endpoint,
    {
      channel: found.def.key,
      conversation_id: queued.conversation.id,
      to: delivery.to,
      contact,
      message: {
        id: queued.message.id,
        text: queued.message.text,
        ...(queued.message.template === null ? {} : { template: queued.message.template }),
      },
    },
    { kind: 'channel', timeoutMs: CHANNEL_SEND_TIMEOUT_MS, idempotencyKey: queued.message.id },
  );
  const body = (typeof result.body === 'object' && result.body !== null ? result.body : {}) as Record<string, unknown>;
  if (!result.ok) {
    const detail = typeof body['error'] === 'string' ? body['error'] : (result.error ?? `HTTP ${String(result.status)}`);
    return fail(detail.slice(0, 500));
  }
  const externalId = typeof body['external_id'] === 'string' && body['external_id'] !== '' ? body['external_id'].slice(0, 200) : null;
  const status = body['status'] === 'delivered' || body['status'] === 'read' ? body['status'] : 'sent';
  const text = typeof body['text'] === 'string' ? body['text'] : null;
  return tenantOp<ConversationMessage>(env, tenantId, 'conversations.delivery', { messageId: queued.message.id, status, externalId, text }, actor);
}
