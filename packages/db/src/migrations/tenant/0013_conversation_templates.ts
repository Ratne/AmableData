import type { Migration } from '../types';

/**
 * Reply windows and template messages:
 * - `conv_conversations.last_inbound_at`: last message from the contact, which
 *   opens the channel's reply window (WhatsApp: 24 h);
 * - `conv_messages.template`: JSON `{ id, params }` of a template message.
 */
export const t0013ConversationTemplates: Migration = {
  id: 13,
  name: 'conversation_templates',
  statements: [
    `ALTER TABLE conv_conversations ADD COLUMN last_inbound_at INTEGER`,
    `UPDATE conv_conversations SET last_inbound_at =
       (SELECT MAX(sent_at) FROM conv_messages m WHERE m.conversation_id = conv_conversations.id AND m.direction = 'in')`,
    `ALTER TABLE conv_messages ADD COLUMN template TEXT`,
  ],
};
