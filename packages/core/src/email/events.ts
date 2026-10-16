import type { EmailSendSource } from '../automation';
import type { EventActor } from '../events';

/**
 * Events emitted by the email pipeline into the MailDb outbox (one MailDb DO
 * per tenant). The MailDb alarm bridges them (`events.pending` / `events.ack`,
 * at-least-once, ordered by id) into the TenantDb outbox and the contact
 * timeline, where the automation engine and the outgoing webhooks pick them
 * up with the same id. Test sends and repeat opens stay in the MailDb.
 */
interface EmailRefs {
  /** Mail message id (stable per send request). */
  messageId: string;
  contactId: string;
  /** Null for test sends. */
  source: EmailSendSource | null;
}

export interface EmailEventPayloads {
  'email.sent': EmailRefs & { providerMessageId: string | null };
  'email.delivered': EmailRefs;
  /** First and repeated opens; `unique` is true only for the first one. */
  'email.opened': EmailRefs & { unique: boolean };
  'email.link_clicked': EmailRefs & { url: string; linkIndex: number; unique: boolean };
  'email.bounced': EmailRefs & { bounceType: 'hard' | 'soft'; reason: string | null };
  'email.complained': EmailRefs;
  'email.unsubscribed': EmailRefs & { email: string; via: 'link' | 'one_click' | 'api' | 'provider' };
}

export type EmailEventType = keyof EmailEventPayloads;

export const EMAIL_EVENT_TYPES = [
  'email.sent',
  'email.delivered',
  'email.opened',
  'email.link_clicked',
  'email.bounced',
  'email.complained',
  'email.unsubscribed',
] as const satisfies readonly EmailEventType[];

type MissingEmailEvent = Exclude<EmailEventType, (typeof EMAIL_EVENT_TYPES)[number]>;
const emailEventListIsComplete: MissingEmailEvent extends never ? true : never = true;
void emailEventListIsComplete;

/** An email event as stored in the MailDb outbox, payload typed by `type`. */
export type EmailOutboxEvent = {
  [K in EmailEventType]: {
    readonly id: string;
    readonly type: K;
    readonly occurredAt: string;
    readonly actor: EventActor;
    readonly payload: EmailEventPayloads[K];
  };
}[EmailEventType];
