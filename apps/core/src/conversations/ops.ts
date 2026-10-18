import type {
  Conversation,
  ConversationMessage,
  ConversationStatus,
  InboundMessageInput,
  ListConversationsQuery,
  MessageTemplateRef,
  OutboundMessageInput,
  ListMessagesQuery,
  MessageDirection,
  MessageStatus,
  Page,
  UpdateConversationInput,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { createContact, displayName } from '../crm/contacts';
import { CrmError, invalid, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { decodeCursor, encodeCursor, toIso } from '../crm/util';
import { findContactByEmail, findContactByPhone } from '../forms/mapping';

/**
 * Shared inbox inside the TenantDb. Delivery itself happens in the core
 * worker (it calls the channel app): these operations record the queued
 * message and then the outcome the worker or the app reports.
 */

export type AddressField = 'phone' | 'email' | 'external_id';

interface ConversationRow {
  id: string;
  channel: string;
  app_id: string;
  channel_key: string;
  address: string;
  contact_id: string | null;
  status: ConversationStatus;
  assigned_to: string | null;
  unread: number;
  last_message_at: number;
  last_message_preview: string | null;
  last_direction: MessageDirection | null;
  last_inbound_at: number | null;
  created_at: number;
  updated_at: number;
  contact_given_name?: string | null;
  contact_family_name?: string | null;
  contact_primary_email?: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  channel: string;
  direction: MessageDirection;
  text: string;
  status: MessageStatus;
  error: string | null;
  external_id: string | null;
  template: string | null;
  author_type: ConversationMessage['author']['type'];
  author_id: string | null;
  sent_at: number;
  created_at: number;
}

const PREVIEW_LENGTH = 140;
const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH);

export function channelId(appId: string, key: string): string {
  return `${appId}:${key}`;
}

/** Same address, same thread: phone numbers keep `+` and digits, emails are lowercased. */
export function normalizeAddress(field: AddressField, value: string): string {
  const trimmed = value.trim();
  if (field === 'phone') {
    const digits = trimmed.replace(/\D/g, '');
    return trimmed.startsWith('+') || trimmed.startsWith('00') ? `+${digits.replace(/^00/, '')}` : digits;
  }
  if (field === 'email') return trimmed.toLowerCase();
  return trimmed;
}

const SELECT_CONVERSATION = `SELECT v.*, c.given_name AS contact_given_name, c.family_name AS contact_family_name,
    c.primary_email AS contact_primary_email
  FROM conv_conversations v LEFT JOIN crm_contacts c ON c.id = v.contact_id AND c.deleted_at IS NULL`;

function toConversation(row: ConversationRow): Conversation {
  const hasContact = row.contact_id !== null && row.contact_given_name !== undefined && (row.contact_given_name !== null || row.contact_family_name !== null || row.contact_primary_email !== null);
  return {
    id: row.id,
    channel: row.channel,
    app_id: row.app_id,
    channel_key: row.channel_key,
    address: row.address,
    contact:
      row.contact_id === null
        ? null
        : {
            id: row.contact_id,
            name: hasContact
              ? displayName({ given_name: row.contact_given_name ?? null, family_name: row.contact_family_name ?? null, primary_email: row.contact_primary_email ?? null }) || row.address
              : row.address,
          },
    status: row.status,
    assigned_to: row.assigned_to,
    unread: row.unread,
    last_message_at: toIso(row.last_message_at),
    last_message_preview: row.last_message_preview,
    last_direction: row.last_direction,
    last_inbound_at: row.last_inbound_at === null ? null : toIso(row.last_inbound_at),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function parseTemplate(raw: string | null): MessageTemplateRef | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as MessageTemplateRef;
    return typeof value.id === 'string' ? { id: value.id, params: value.params ?? {} } : null;
  } catch {
    return null;
  }
}

function toMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    direction: row.direction,
    text: row.text,
    status: row.status,
    error: row.error,
    external_id: row.external_id,
    template: parseTemplate(row.template),
    author: { type: row.author_type, id: row.author_id },
    sent_at: toIso(row.sent_at),
    created_at: toIso(row.created_at),
  };
}

function getRow(ctx: CrmContext, id: string): ConversationRow {
  const row = ctx.db.all<ConversationRow>(`${SELECT_CONVERSATION} WHERE v.id = ?`, id)[0];
  if (row === undefined) throw notFound('conversation', id);
  return row;
}

function getMessageRow(ctx: CrmContext, id: string): MessageRow {
  const row = ctx.db.all<MessageRow>(`SELECT * FROM conv_messages WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('message', id);
  return row;
}

const refs = (row: ConversationRow) => ({ conversationId: row.id, contactId: row.contact_id, channel: row.channel });

// ------------------------------------------------------------------- reads

export function listConversations(ctx: CrmContext, input: ListConversationsQuery & { me: string | null }): Page<Conversation> {
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const assigned = input.assigned_to === 'me' ? input.me : input.assigned_to;
  const rows = ctx.db.all<ConversationRow>(
    `${SELECT_CONVERSATION}
     WHERE (? IS NULL OR v.status = ?)
       AND (? IS NULL OR (? = 'none' AND v.assigned_to IS NULL) OR v.assigned_to = ?)
       AND (? IS NULL OR v.channel = ?)
       AND (? IS NULL OR v.contact_id = ?)
       AND (? IS NULL OR v.last_message_at < ? OR (v.last_message_at = ? AND v.id < ?))
     ORDER BY v.last_message_at DESC, v.id DESC LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    assigned ?? null,
    assigned ?? null,
    assigned ?? null,
    input.channel ?? null,
    input.channel ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    after === null ? null : Number(after.v),
    after === null ? null : Number(after.v),
    after === null ? null : Number(after.v),
    after?.id ?? null,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toConversation),
    next_cursor: rows.length > input.limit && last !== undefined ? encodeCursor({ v: last.last_message_at, id: last.id }) : null,
  };
}

export function getConversation(ctx: CrmContext, input: { id: string }): Conversation {
  return toConversation(getRow(ctx, input.id));
}

/** Newest first; the next page holds older messages. */
export function listMessages(ctx: CrmContext, input: ListMessagesQuery & { id: string }): Page<ConversationMessage> {
  getRow(ctx, input.id);
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const rows = ctx.db.all<MessageRow>(
    `SELECT * FROM conv_messages WHERE conversation_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    input.id,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toMessage),
    next_cursor: rows.length > input.limit && last !== undefined ? encodeCursor({ v: null, id: last.id }) : null,
  };
}

export function conversationCounts(ctx: CrmContext, input: { me: string | null }): { open: number; unassigned: number; mine: number; unread: number } {
  const row = ctx.db.all<{ open: number; unassigned: number; mine: number; unread: number }>(
    `SELECT
       COALESCE(SUM(status = 'open'), 0) AS open,
       COALESCE(SUM(status = 'open' AND assigned_to IS NULL), 0) AS unassigned,
       COALESCE(SUM(status != 'closed' AND assigned_to IS NOT NULL AND assigned_to = ?), 0) AS mine,
       COALESCE(SUM(status != 'closed' AND unread > 0), 0) AS unread
     FROM conv_conversations`,
    input.me,
  )[0];
  return row ?? { open: 0, unassigned: 0, mine: 0, unread: 0 };
}

// ----------------------------------------------------------------- updates

export function updateConversation(ctx: CrmContext, input: { id: string; data: UpdateConversationInput }): Conversation {
  const current = getRow(ctx, input.id);
  const status = input.data.status ?? current.status;
  const assignedTo = input.data.assigned_to === undefined ? current.assigned_to : input.data.assigned_to;
  ctx.db.run(`UPDATE conv_conversations SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?`, status, assignedTo, ctx.now(), input.id);
  if (assignedTo !== current.assigned_to) emit(ctx, 'conversation.assigned', { ...refs(current), assignedTo });
  if (status !== current.status && status === 'closed') emit(ctx, 'conversation.closed', refs(current));
  if (status !== current.status && current.status === 'closed') emit(ctx, 'conversation.reopened', refs(current));
  return getConversation(ctx, input);
}

export function markRead(ctx: CrmContext, input: { id: string }): Conversation {
  getRow(ctx, input.id);
  ctx.db.run(`UPDATE conv_conversations SET unread = 0 WHERE id = ?`, input.id);
  return getConversation(ctx, input);
}

function insertMessage(
  ctx: CrmContext,
  conversation: ConversationRow,
  message: {
    direction: MessageDirection;
    text: string;
    status: MessageStatus;
    externalId: string | null;
    template?: MessageTemplateRef | null;
    authorType: MessageRow['author_type'];
    authorId: string | null;
    sentAt: number;
    /** Messages the app sent on its own (automations) leave the team's unread count alone. */
    keepUnread?: boolean;
  },
): MessageRow {
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO conv_messages (id, conversation_id, channel, direction, text, status, error, external_id, template, author_type, author_id, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    id,
    conversation.id,
    conversation.channel,
    message.direction,
    message.text,
    message.status,
    message.externalId,
    message.template == null ? null : JSON.stringify(message.template),
    message.authorType,
    message.authorId,
    message.sentAt,
    now,
  );
  if (message.direction !== 'note') {
    ctx.db.run(
      `UPDATE conv_conversations SET last_message_at = ?, last_message_preview = ?, last_direction = ?,
         unread = CASE WHEN ? = 'in' THEN unread + 1 WHEN ? = 1 THEN unread ELSE 0 END,
         last_inbound_at = CASE WHEN ? = 'in' THEN MAX(COALESCE(last_inbound_at, 0), ?) ELSE last_inbound_at END,
         updated_at = ? WHERE id = ?`,
      Math.max(message.sentAt, conversation.last_message_at),
      preview(message.text),
      message.direction,
      message.direction,
      message.keepUnread === true ? 1 : 0,
      message.direction,
      message.sentAt,
      now,
      conversation.id,
    );
  }
  return getMessageRow(ctx, id);
}

function windowOpen(ctx: CrmContext, conversation: ConversationRow, hours: number | null | undefined): boolean {
  if (hours === null || hours === undefined) return true;
  return conversation.last_inbound_at !== null && ctx.now() - conversation.last_inbound_at < hours * 3_600_000;
}

export interface QueuedMessage {
  conversation: Conversation;
  message: ConversationMessage;
  /** Where the worker sends it (null for notes). */
  delivery: { appId: string; channelKey: string; to: string; contactId: string | null } | null;
}

/** A reply from the team: queued for the worker to send, or an internal note. */
export function addMessage(
  ctx: CrmContext,
  input: {
    id: string;
    text?: string | undefined;
    note?: boolean | undefined;
    template?: MessageTemplateRef | undefined;
    /** The channel's reply window: free text after it closes is refused. */
    replyWindowHours?: number | null | undefined;
  },
): QueuedMessage {
  const conversation = getRow(ctx, input.id);
  const note = input.note === true;
  if (!note && input.template === undefined && !windowOpen(ctx, conversation, input.replyWindowHours)) {
    throw invalid('template', 'the reply window of this channel is closed: send a template to reopen the conversation');
  }
  const text = input.text ?? (input.template === undefined ? '' : `[${input.template.id}]`);
  if (text === '') throw invalid('text', 'text or template is required');
  const row = insertMessage(ctx, conversation, {
    direction: note ? 'note' : 'out',
    text,
    status: note ? 'note' : 'queued',
    externalId: null,
    template: note ? null : (input.template ?? null),
    authorType: ctx.actor.type,
    authorId: ctx.actor.id,
    sentAt: ctx.now(),
  });
  if (!note && conversation.status === 'closed') {
    ctx.db.run(`UPDATE conv_conversations SET status = 'open' WHERE id = ?`, conversation.id);
    emit(ctx, 'conversation.reopened', refs(conversation));
  }
  return {
    conversation: getConversation(ctx, input),
    message: toMessage(row),
    delivery: note ? null : { appId: conversation.app_id, channelKey: conversation.channel_key, to: conversation.address, contactId: conversation.contact_id },
  };
}

function contactAddress(ctx: CrmContext, contactId: string, field: AddressField): string | null {
  const row = ctx.db.all<{ primary_email: string | null; primary_phone: string | null }>(
    `SELECT primary_email, primary_phone FROM crm_contacts WHERE id = ? AND deleted_at IS NULL`,
    contactId,
  )[0];
  if (row === undefined) throw notFound('contact', contactId);
  if (field === 'phone') return row.primary_phone;
  if (field === 'email') return row.primary_email;
  return null;
}

function findOrCreateThread(
  ctx: CrmContext,
  input: { appId: string; channelKey: string; address: string; contactId: string | null },
): { row: ConversationRow; created: boolean } {
  const channel = channelId(input.appId, input.channelKey);
  const existing = ctx.db.all<{ id: string }>(`SELECT id FROM conv_conversations WHERE channel = ? AND address = ?`, channel, input.address)[0];
  if (existing !== undefined) return { row: getRow(ctx, existing.id), created: false };
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO conv_conversations (id, channel, app_id, channel_key, address, contact_id, status, assigned_to, unread,
       last_message_at, last_message_preview, last_direction, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, 0, ?, NULL, NULL, ?, ?)`,
    id,
    channel,
    input.appId,
    input.channelKey,
    input.address,
    input.contactId,
    now,
    now,
    now,
  );
  const row = getRow(ctx, id);
  emit(ctx, 'conversation.created', refs(row));
  return { row, created: true };
}

/** The team writes first to a contact on a channel. */
export function startConversation(
  ctx: CrmContext,
  input: {
    appId: string;
    channelKey: string;
    addressField: AddressField;
    contactId: string;
    text?: string | undefined;
    template?: MessageTemplateRef | undefined;
    replyWindowHours?: number | null | undefined;
  },
): QueuedMessage {
  const raw = contactAddress(ctx, input.contactId, input.addressField);
  if (raw === null || raw === '') {
    throw invalid('contact_id', input.addressField === 'email' ? 'the contact has no email address' : 'the contact has no phone number');
  }
  const { row } = findOrCreateThread(ctx, {
    appId: input.appId,
    channelKey: input.channelKey,
    address: normalizeAddress(input.addressField, raw),
    contactId: input.contactId,
  });
  if (row.contact_id === null) ctx.db.run(`UPDATE conv_conversations SET contact_id = ? WHERE id = ?`, input.contactId, row.id);
  return addMessage(ctx, { id: row.id, text: input.text, template: input.template, replyWindowHours: input.replyWindowHours });
}

/** Outcome of a send attempt (worker) or a delivery update (app). */
export function recordDelivery(
  ctx: CrmContext,
  input: { messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; externalId?: string | null; error?: string | null; text?: string | null },
): ConversationMessage {
  const message = getMessageRow(ctx, input.messageId);
  if (message.direction !== 'out') throw new CrmError('conflict', 'only outbound messages have a delivery status');
  const conversation = getRow(ctx, message.conversation_id);
  const externalId = input.externalId ?? message.external_id;
  const error = input.status === 'failed' ? (input.error ?? 'failed').slice(0, 500) : null;
  if (externalId !== message.external_id && externalId !== null) {
    const taken = ctx.db.all(`SELECT 1 FROM conv_messages WHERE channel = ? AND external_id = ? AND id != ?`, message.channel, externalId, message.id);
    if (taken.length > 0) throw new CrmError('conflict', 'external_id already used by another message');
  }
  ctx.db.run(`UPDATE conv_messages SET status = ?, error = ?, external_id = ? WHERE id = ?`, input.status, error, externalId, message.id);
  // The app may return the final text of a template message.
  if (typeof input.text === 'string' && input.text.trim() !== '' && message.template !== null) {
    const finalText = input.text.slice(0, 4096);
    ctx.db.run(`UPDATE conv_messages SET text = ? WHERE id = ?`, finalText, message.id);
    ctx.db.run(
      `UPDATE conv_conversations SET last_message_preview = ? WHERE id = ? AND last_direction = 'out' AND last_message_at <= ?`,
      preview(finalText),
      conversation.id,
      message.sent_at,
    );
  }
  const base = { ...refs(conversation), messageId: message.id };
  if (message.status === 'queued' && input.status !== 'failed') emit(ctx, 'message.sent', { ...base, preview: preview(message.text) });
  if (input.status !== 'sent' && input.status !== message.status) emit(ctx, 'message.status_changed', { ...base, status: input.status, error });
  return toMessage(getMessageRow(ctx, message.id));
}

/** Delivery update reported by the app, by provider id. Unknown ids are ignored (`null`). */
export function recordDeliveryByExternalId(
  ctx: CrmContext,
  input: { appId: string; channelKey: string; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; error?: string | undefined },
): ConversationMessage | null {
  const row = ctx.db.all<{ id: string; status: MessageStatus }>(
    `SELECT id, status FROM conv_messages WHERE channel = ? AND external_id = ? AND direction = 'out'`,
    channelId(input.appId, input.channelKey),
    input.externalId,
  )[0];
  if (row === undefined) return null;
  // Updates can arrive out of order: never step back (read → delivered).
  const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
  if (input.status !== 'failed' && (rank[row.status] ?? 0) >= rank[input.status]!) return toMessage(getMessageRow(ctx, row.id));
  return recordDelivery(ctx, { messageId: row.id, status: input.status, error: input.error ?? null });
}

function inboundContact(ctx: CrmContext, field: AddressField, address: string, input: InboundMessageInput): string | null {
  const byAddress = field === 'phone' ? findContactByPhone(ctx, address) : field === 'email' ? findContactByEmail(ctx, address) : null;
  if (byAddress !== null) return byAddress;
  const email = field === 'email' ? address : input.contact?.email;
  const byEmail = email === undefined || field === 'email' ? null : findContactByEmail(ctx, email);
  if (byEmail !== null) return byEmail;
  const given = input.contact?.given_name;
  const family = input.contact?.family_name;
  if (field === 'external_id' && email === undefined && given === undefined && family === undefined) return null;
  return createContact(ctx, {
    ...(given === undefined ? {} : { given_name: given }),
    ...(family === undefined ? {} : { family_name: family }),
    ...(email === undefined ? {} : { emails: [{ email }] }),
    ...(field === 'phone' ? { phones: [{ number: address }] } : {}),
    source_type: 'other',
  }).id;
}

/** A message an app received from a contact. The same `external_id` twice is stored once. */
export function receiveMessage(
  ctx: CrmContext,
  input: { appId: string; addressField: AddressField; message: InboundMessageInput },
): { conversation: Conversation; message: ConversationMessage; duplicate: boolean } {
  const channel = channelId(input.appId, input.message.channel);
  const duplicate = ctx.db.all<MessageRow>(`SELECT * FROM conv_messages WHERE channel = ? AND external_id = ?`, channel, input.message.external_id)[0];
  if (duplicate !== undefined) {
    return { conversation: getConversation(ctx, { id: duplicate.conversation_id }), message: toMessage(duplicate), duplicate: true };
  }
  const address = normalizeAddress(input.addressField, input.message.from);
  if (address === '' || (input.addressField === 'phone' && address.replace(/\D/g, '').length < 6)) {
    throw invalid('from', 'not a valid address for this channel');
  }
  const thread = findOrCreateThread(ctx, { appId: input.appId, channelKey: input.message.channel, address, contactId: null });
  let row = thread.row;
  if (row.contact_id === null) {
    const contactId = inboundContact(ctx, input.addressField, address, input.message);
    if (contactId !== null) {
      ctx.db.run(`UPDATE conv_conversations SET contact_id = ? WHERE id = ?`, contactId, row.id);
      row = getRow(ctx, row.id);
    }
  }
  if (row.status !== 'open') {
    // A pending conversation waits for the contact: their reply puts it back in the queue.
    ctx.db.run(`UPDATE conv_conversations SET status = 'open' WHERE id = ?`, row.id);
    if (row.status === 'closed') emit(ctx, 'conversation.reopened', refs(row));
  }
  const sentAt = input.message.sent_at === undefined ? ctx.now() : Math.min(Date.parse(input.message.sent_at), ctx.now());
  const message = insertMessage(ctx, row, {
    direction: 'in',
    text: input.message.text,
    status: 'received',
    externalId: input.message.external_id,
    authorType: 'contact',
    authorId: row.contact_id,
    sentAt,
  });
  emit(ctx, 'message.received', { ...refs(row), messageId: message.id, preview: preview(message.text) });
  return { conversation: getConversation(ctx, { id: row.id }), message: toMessage(message), duplicate: false };
}

/**
 * A message the app sent on its own (an automation step, the team's phone
 * app): it shows in the thread without being sent again. Same `external_id`
 * twice is stored once.
 */
export function recordOutbound(
  ctx: CrmContext,
  input: { appId: string; addressField: AddressField; message: OutboundMessageInput },
): { conversation: Conversation; message: ConversationMessage; duplicate: boolean } {
  const channel = channelId(input.appId, input.message.channel);
  const duplicate = ctx.db.all<MessageRow>(`SELECT * FROM conv_messages WHERE channel = ? AND external_id = ?`, channel, input.message.external_id)[0];
  if (duplicate !== undefined) {
    return { conversation: getConversation(ctx, { id: duplicate.conversation_id }), message: toMessage(duplicate), duplicate: true };
  }
  const address = normalizeAddress(input.addressField, input.message.to);
  if (address === '' || (input.addressField === 'phone' && address.replace(/\D/g, '').length < 6)) {
    throw invalid('to', 'not a valid address for this channel');
  }
  const thread = findOrCreateThread(ctx, { appId: input.appId, channelKey: input.message.channel, address, contactId: null });
  let row = thread.row;
  if (row.contact_id === null) {
    const contactId = input.addressField === 'phone' ? findContactByPhone(ctx, address) : input.addressField === 'email' ? findContactByEmail(ctx, address) : null;
    if (contactId !== null) {
      ctx.db.run(`UPDATE conv_conversations SET contact_id = ? WHERE id = ?`, contactId, row.id);
      row = getRow(ctx, row.id);
    }
  }
  const sentAt = input.message.sent_at === undefined ? ctx.now() : Math.min(Date.parse(input.message.sent_at), ctx.now());
  const message = insertMessage(ctx, row, {
    direction: 'out',
    text: input.message.text === '' ? `[${input.message.template?.id ?? 'message'}]` : input.message.text,
    status: input.message.status,
    externalId: input.message.external_id,
    template: input.message.template ?? null,
    authorType: 'app',
    authorId: input.appId,
    sentAt,
    keepUnread: true,
  });
  emit(ctx, 'message.sent', { ...refs(row), messageId: message.id, preview: preview(message.text) });
  return { conversation: getConversation(ctx, { id: row.id }), message: toMessage(message), duplicate: false };
}

// ------------------------------------------------------- contact lifecycle

/** Threads of merged contacts move to the survivor. */
export function mergeConversations(ctx: CrmContext, survivorId: string, sourceIds: readonly string[]): void {
  for (const sourceId of sourceIds) {
    ctx.db.run(`UPDATE conv_conversations SET contact_id = ? WHERE contact_id = ?`, survivorId, sourceId);
  }
}

/** Right to erasure: the contact's threads and messages go away. */
export function eraseConversationsOf(ctx: CrmContext, contactId: string): void {
  ctx.db.run(`DELETE FROM conv_messages WHERE conversation_id IN (SELECT id FROM conv_conversations WHERE contact_id = ?)`, contactId);
  ctx.db.run(`DELETE FROM conv_conversations WHERE contact_id = ?`, contactId);
}

export const conversationOps = {
  'conversations.list': listConversations,
  'conversations.get': getConversation,
  'conversations.messages': listMessages,
  'conversations.counts': conversationCounts,
  'conversations.update': updateConversation,
  'conversations.read': markRead,
  'conversations.addMessage': addMessage,
  'conversations.start': startConversation,
  'conversations.delivery': recordDelivery,
  'conversations.deliveryByExternalId': recordDeliveryByExternalId,
  'conversations.receive': receiveMessage,
  'conversations.recordOutbound': recordOutbound,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;
