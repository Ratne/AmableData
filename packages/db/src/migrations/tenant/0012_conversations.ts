import type { Migration } from '../types';

/**
 * Conversations (shared inbox):
 * - `conv_conversations`: one thread per address on a channel
 *   (`<app id>:<channel key>`), linked to the contact, with status,
 *   assignee and the last message for the inbox list;
 * - `conv_messages`: inbound, outbound and internal notes; `external_id` is
 *   the provider id (dedupes inbound messages, matches delivery updates).
 */
export const t0012Conversations: Migration = {
  id: 12,
  name: 'conversations',
  statements: [
    `CREATE TABLE conv_conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      app_id TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      address TEXT NOT NULL,
      contact_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_to TEXT,
      unread INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL,
      last_message_preview TEXT,
      last_direction TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX conv_conversations_thread ON conv_conversations (channel, address)`,
    `CREATE INDEX conv_conversations_inbox ON conv_conversations (status, last_message_at)`,
    `CREATE INDEX conv_conversations_contact ON conv_conversations (contact_id)`,
    `CREATE TABLE conv_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      external_id TEXT,
      author_type TEXT NOT NULL,
      author_id TEXT,
      sent_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX conv_messages_thread ON conv_messages (conversation_id, id)`,
    `CREATE UNIQUE INDEX conv_messages_external ON conv_messages (channel, external_id) WHERE external_id IS NOT NULL`,
  ],
};
