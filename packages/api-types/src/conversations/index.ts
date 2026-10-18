import { z } from 'zod';
import { idSchema, pageQuerySchema, timestampSchema } from '../crm/common';

/**
 * Conversations: the shared inbox. One conversation per contact address on a
 * channel (a WhatsApp number, an SMS number…); channels are provided by
 * installed apps (`extensions.channels` of their manifest), so the channel id
 * is `<app id>:<channel key>`.
 */

export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const MESSAGE_DIRECTIONS = ['in', 'out', 'note'] as const;
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

/** `received` (in), `queued` → `sent` → `delivered` → `read` or `failed` (out), `note`. */
export const MESSAGE_STATUSES = ['received', 'queued', 'sent', 'delivered', 'read', 'failed', 'note'] as const;
export const messageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

/** Statuses an app may report for an outbound message. */
export const MESSAGE_DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;

export const MESSAGE_MAX_LENGTH = 4096;

export const channelIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,39}:[a-z][a-z0-9_]{1,39}$/, 'expected <app id>:<channel key>');

export const conversationContactSchema = z.object({
  id: idSchema,
  name: z.string(),
});

export const conversationSchema = z.object({
  id: idSchema,
  channel: z.string(),
  app_id: z.string(),
  channel_key: z.string(),
  /** Address of the contact on the channel (phone number, email, provider id). */
  address: z.string(),
  contact: conversationContactSchema.nullable(),
  status: conversationStatusSchema,
  assigned_to: idSchema.nullable(),
  unread: z.number().int().nonnegative(),
  last_message_at: timestampSchema,
  last_message_preview: z.string().nullable(),
  last_direction: messageDirectionSchema.nullable(),
  /** Last message from the contact: starts the channel's reply window. */
  last_inbound_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;

/** A template message: the id the app gave it and the values of its parameters. */
export const messageTemplateRefSchema = z.strictObject({
  id: z.string().min(1).max(200),
  params: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), z.string().max(1000)).default({}),
});
export type MessageTemplateRef = z.infer<typeof messageTemplateRefSchema>;

/** A template the team can send on a channel (from the app's `templates_endpoint`). */
export const channelTemplateSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  language: z.string().max(20).nullable(),
  category: z.string().max(40).nullable(),
  /** Body with `{{param}}` placeholders, for the preview. */
  text: z.string().max(4096),
  params: z.array(z.object({ key: z.string().regex(/^[A-Za-z0-9_]{1,64}$/), example: z.string().max(200).nullable() })).max(20),
});
export type ChannelTemplate = z.infer<typeof channelTemplateSchema>;

/** Fills `{{key}}` placeholders; missing values stay visible as `{{key}}`. */
export function renderTemplateText(text: string, params: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]{1,64})\s*\}\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined || value === '' ? match : value;
  });
}

/** True while the contact's last message is recent enough for a free-form reply. */
export function replyWindowOpen(lastInboundAt: string | null, windowHours: number | null | undefined, nowMs: number = Date.now()): boolean {
  if (windowHours === null || windowHours === undefined) return true;
  if (lastInboundAt === null) return false;
  return nowMs - Date.parse(lastInboundAt) < windowHours * 3_600_000;
}

export const conversationMessageSchema = z.object({
  id: idSchema,
  conversation_id: idSchema,
  direction: messageDirectionSchema,
  text: z.string(),
  status: messageStatusSchema,
  error: z.string().nullable(),
  external_id: z.string().nullable(),
  template: messageTemplateRefSchema.nullable(),
  author: z.object({ type: z.enum(['user', 'api_key', 'app', 'system', 'contact']), id: z.string().nullable() }),
  sent_at: timestampSchema,
  created_at: timestampSchema,
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const listConversationsQuerySchema = pageQuerySchema.extend({
  status: conversationStatusSchema.optional(),
  /** `me` resolves to the caller; `none` lists unassigned conversations. */
  assigned_to: z.string().max(64).optional(),
  channel: channelIdSchema.optional(),
  contact_id: idSchema.optional(),
});
export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = pageQuerySchema;
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const updateConversationSchema = z
  .strictObject({
    status: conversationStatusSchema.optional(),
    assigned_to: idSchema.nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assigned_to !== undefined, 'nothing to update');
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const sendMessageSchema = z
  .strictObject({
    /** With a template: the rendered preview (the app may return the final text). */
    text: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH).optional(),
    /** Internal note: visible to the team only, never sent. */
    note: z.boolean().optional(),
    /** Send an approved template instead of free text (required once the reply window is closed). */
    template: messageTemplateRefSchema.optional(),
  })
  .refine((v) => v.text !== undefined || v.template !== undefined, { message: 'text or template is required', path: ['text'] })
  .refine((v) => !(v.note === true && v.template !== undefined), { message: 'notes cannot be templates', path: ['template'] });
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const startConversationSchema = z
  .strictObject({
    channel: channelIdSchema,
    contact_id: idSchema,
    text: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH).optional(),
    template: messageTemplateRefSchema.optional(),
  })
  .refine((v) => v.text !== undefined || v.template !== undefined, { message: 'text or template is required', path: ['text'] });
export type StartConversationInput = z.infer<typeof startConversationSchema>;

export const conversationChannelSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  key: z.string(),
  app_name: z.string(),
  name: z.object({ en: z.string(), it: z.string().optional() }),
  kind: z.string(),
  address_field: z.enum(['phone', 'email', 'external_id']),
  icon_url: z.string().nullable(),
  paused: z.boolean(),
  /** Hours after the contact's last message during which free text is allowed; null = always. */
  reply_window_hours: z.number().int().nullable(),
  /** The app serves templates (`GET /conversations/channels/{channel}/templates`). */
  templates: z.boolean(),
});
export type ConversationChannel = z.infer<typeof conversationChannelSchema>;

/** Body of `POST /apps/messages/outbound`: a message the app sent outside the inbox (automation, phone app). */
export const outboundMessageSchema = z.strictObject({
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  external_id: z.string().min(1).max(200),
  /** Address of the recipient. */
  to: z.string().trim().min(1).max(200),
  text: z.string().max(MESSAGE_MAX_LENGTH),
  template: messageTemplateRefSchema.optional(),
  status: z.enum(MESSAGE_DELIVERY_STATUSES).default('sent'),
  sent_at: z.iso.datetime({ offset: true }).optional(),
});
export type OutboundMessageInput = z.infer<typeof outboundMessageSchema>;

/** Body of `POST /apps/messages/inbound` (an app posting a message it received). */
export const inboundMessageSchema = z.strictObject({
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  /** Provider message id: the same id twice is stored once. */
  external_id: z.string().min(1).max(200),
  /** Address of the sender (phone number in E.164, email, provider id). */
  from: z.string().trim().min(1).max(200),
  text: z.string().max(MESSAGE_MAX_LENGTH),
  /** Details to create the contact with when the address is unknown. */
  contact: z
    .strictObject({
      given_name: z.string().max(100).optional(),
      family_name: z.string().max(100).optional(),
      email: z.string().email().max(254).optional(),
    })
    .optional(),
  sent_at: z.iso.datetime({ offset: true }).optional(),
});
export type InboundMessageInput = z.infer<typeof inboundMessageSchema>;

/** Body of `POST /apps/messages/status` (delivery updates of outbound messages). */
export const messageStatusUpdateSchema = z.strictObject({
  channel: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  external_id: z.string().min(1).max(200),
  status: z.enum(MESSAGE_DELIVERY_STATUSES),
  error: z.string().max(500).optional(),
});
export type MessageStatusUpdateInput = z.infer<typeof messageStatusUpdateSchema>;

export const conversationEnvelopeSchema = z.object({ data: conversationSchema });
export const conversationMessageEnvelopeSchema = z.object({ data: conversationMessageSchema });
