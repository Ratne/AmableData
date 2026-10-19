/**
 * Automation engine contracts shared across modules.
 *
 * - `EmailSendRequest`: the message the Engine DO (and later broadcasts) put on
 *   the `email-send` queue; the email pipeline consumes it.
 * - `QuotaGuard`: hook consulted before every automation email (wallet / quota).
 *   The installation ships an always-allow guard; the control plane provides
 *   the real one.
 * - `AutomationInboundEvent`: events that modules living outside the TenantDb
 *   (forms, email tracking, booking, analytics) push to the Engine DO so goals
 *   can match them. CRM and e-commerce events reach the engine through the
 *   TenantDb outbox.
 */

/** Queue name (wrangler `queues.producers[].queue`) carrying `EmailSendRequest`. */
export const EMAIL_SEND_QUEUE = 'email-send';

/** Where an email send originates; echoed back by tracking events (opens, clicks). */
export type EmailSendSource =
  | {
      readonly type: 'automation';
      readonly automationId: string;
      readonly versionId: string;
      readonly nodeId: string;
      readonly stepId: string;
      readonly enrollmentId: string;
    }
  | { readonly type: 'broadcast'; readonly broadcastId: string }
  | { readonly type: 'single'; readonly userId: string }
  | {
      readonly type: 'transactional';
      readonly purpose: TransactionalEmailPurpose;
      /** Id of the record the email is about (e.g. the booking). */
      readonly referenceId: string;
      /** Staff user on whose behalf it goes out (e.g. the booking host), if any. */
      readonly userId: string | null;
    };

/**
 * Transactional emails (booking confirmations, changes, reminders) are sent
 * even to contacts who unsubscribed from marketing and skip the QuotaGuard and
 * the warm-up cap. They still need a verified sending domain, respect the
 * per-minute rate limit and tenant suspension, and are never sent to addresses
 * that hard-bounced or complained (or were suppressed manually).
 */
export const TRANSACTIONAL_EMAIL_PURPOSES = ['booking'] as const;
export type TransactionalEmailPurpose = (typeof TRANSACTIONAL_EMAIL_PURPOSES)[number];

/** Content of a send: a stored template or an inline Tiptap document (rendered by the pipeline). */
export interface EmailSendContent {
  readonly templateId: string | null;
  readonly subject: string | null;
  readonly preheader: string | null;
  /** Tiptap JSON document; Liquid is resolved per recipient by the pipeline. */
  readonly body: Readonly<Record<string, unknown>> | null;
  readonly fromName: string | null;
  readonly replyTo: string | null;
}

/**
 * Message contract of the `email-send` queue, version 1.
 *
 * `id` is an idempotency key: the producer may enqueue the same request more
 * than once (at-least-once), consumers must drop duplicates by `id`.
 * The consumer resolves the recipient address, suppressions, marketable status
 * and the tenant sending domain; the producer only names the contact.
 */
export interface EmailSendRequest {
  readonly kind: 'email.send';
  readonly version: 1;
  readonly id: string;
  readonly tenantId: string;
  readonly contactId: string;
  readonly content: EmailSendContent;
  readonly source: EmailSendSource;
  /** ISO 8601. */
  readonly requestedAt: string;
  /** ISO 8601; the consumer drops the message when it is processed later than this. */
  readonly notAfter: string | null;
}

// ----------------------------------------------------------------- quota

export interface QuotaCheck {
  readonly tenantId: string;
  readonly channel: 'email';
  /** Number of messages about to be sent. */
  readonly count: number;
  readonly source: EmailSendSource;
}

/**
 * - `allow`: send now;
 * - `deny`: never send this message (the step is skipped, the flow continues);
 * - `pause`: hold the step (e.g. zero balance) and retry later; held steps
 *   resume when the guard allows again.
 */
export type QuotaDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'pause'; readonly reason: string; readonly retryAfterMs?: number };

export interface QuotaUsage {
  readonly tenantId: string;
  readonly channel: 'email';
  readonly count: number;
  readonly source: EmailSendSource;
}

export interface QuotaGuard {
  check(input: QuotaCheck): Promise<QuotaDecision>;
  /** Called once per message actually handed to the provider (metering). Optional. */
  recordUsage?(usage: QuotaUsage): Promise<void>;
}

/** Default guard of an installation without a control plane: always allows. */
export const allowAllQuotaGuard: QuotaGuard = {
  check: () => Promise.resolve({ action: 'allow' }),
};

// -------------------------------------------------------- inbound events

/** Payloads of the events other modules push to the Engine DO. */
export interface AutomationEventPayloads {
  'form.submitted': { contactId: string; formId: string; submissionId: string };
  'email.opened': { contactId: string; emailId: string; source: EmailSendSource | null };
  'email.link_clicked': {
    contactId: string;
    emailId: string;
    url: string;
    source: EmailSendSource | null;
  };
  /** A web analytics goal completed by an identified visitor. */
  'analytics.goal': { contactId: string; siteId: string; goalName: string };
  /** Trigger fired by an installed app (`POST /api/v2/t/{slug}/apps/events`); `name` is `app.<appId>.<key>`. */
  'app.event': {
    contactId: string;
    appId: string;
    key: string;
    name: string;
    data: Readonly<Record<string, unknown>>;
  };
}

export type AutomationEventType = keyof AutomationEventPayloads;

export const AUTOMATION_EVENT_TYPES = [
  'form.submitted',
  'email.opened',
  'email.link_clicked',
  'analytics.goal',
  'app.event',
] as const satisfies readonly AutomationEventType[];

/** Event pushed to `Engine.ingest()`; `id` must be unique and stable (dedupe key). */
export type AutomationInboundEvent = {
  [K in AutomationEventType]: {
    readonly id: string;
    readonly type: K;
    /** ISO 8601. */
    readonly occurredAt: string;
    readonly payload: AutomationEventPayloads[K];
  };
}[AutomationEventType];
