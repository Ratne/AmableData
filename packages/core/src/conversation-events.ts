/**
 * Domain events of the shared inbox (Conversations). Written to the tenant
 * outbox with the change; with a contact they also appear in its timeline.
 * `channel` is `<app id>:<channel key>`.
 */

interface ConversationRefs {
  conversationId: string;
  contactId: string | null;
  channel: string;
}

interface MessageRefs extends ConversationRefs {
  messageId: string;
}

export interface ConversationEventPayloads {
  'conversation.created': ConversationRefs;
  'conversation.assigned': ConversationRefs & { assignedTo: string | null };
  'conversation.closed': ConversationRefs;
  'conversation.reopened': ConversationRefs;
  /** `preview`: first characters of the text. */
  'message.received': MessageRefs & { preview: string };
  'message.sent': MessageRefs & { preview: string };
  /** Delivery update reported by the channel app. */
  'message.status_changed': MessageRefs & { status: 'sent' | 'delivered' | 'read' | 'failed'; error: string | null };
}

export type ConversationEventType = keyof ConversationEventPayloads;

export const CONVERSATION_EVENT_TYPES = [
  'conversation.created',
  'conversation.assigned',
  'conversation.closed',
  'conversation.reopened',
  'message.received',
  'message.sent',
  'message.status_changed',
] as const satisfies readonly ConversationEventType[];

type MissingConversationEvent = Exclude<ConversationEventType, (typeof CONVERSATION_EVENT_TYPES)[number]>;
const conversationEventListIsComplete: MissingConversationEvent extends never ? true : never = true;
void conversationEventListIsComplete;
