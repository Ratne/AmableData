/**
 * Domain event contract.
 *
 * Every CRM mutation writes one or more typed events into the tenant outbox
 * (TenantDb `crm_outbox` table) in the same transaction as the change; the
 * automation-engine phase consumes them (goal matching, Engine DO scheduling).
 * Payloads carry ids and the minimal facts a goal needs — consumers re-read the
 * entity when they need more.
 */

import { CONVERSATION_EVENT_TYPES, type ConversationEventPayloads } from './conversation-events';
import { ESIGN_OUTBOX_EVENT_TYPES, type EsignEventPayloads } from './esign-events';
import { PUBLISHING_EVENT_TYPES, type PublishingEventPayloads } from './publishing-events';

/** Typed payload of every CRM event. Keys are the event type strings. */
export interface CrmEventPayloads {
  'contact.created': { contactId: string };
  'contact.updated': { contactId: string; changedFields: string[] };
  'contact.deleted': { contactId: string };
  'contact.restored': { contactId: string };
  'contact.merged': { contactId: string; mergedContactIds: string[] };
  'contact.tag_applied': { contactId: string; tagId: string };
  'contact.tag_removed': { contactId: string; tagId: string };
  'contact.score_changed': { contactId: string; from: number; to: number };
  'contact.owner_assigned': { contactId: string; ownerId: string | null };
  'company.created': { companyId: string };
  'company.updated': { companyId: string; changedFields: string[] };
  'company.deleted': { companyId: string };
  'note.added': NoteRefs;
  'note.updated': NoteRefs;
  'note.deleted': NoteRefs;
  'task.created': TaskRefs;
  'task.updated': TaskRefs;
  'task.completed': TaskRefs;
  'task.reopened': TaskRefs;
  'task.deleted': TaskRefs;
  'appointment.created': AppointmentRefs & { source: string };
  'appointment.updated': AppointmentRefs;
  'appointment.cancelled': AppointmentRefs;
  'appointment.deleted': AppointmentRefs;
  'opportunity.created': OpportunityRefs;
  'opportunity.updated': OpportunityRefs & { changedFields: string[] };
  'opportunity.stage_changed': OpportunityRefs & {
    fromStageId: string | null;
    toStageId: string;
  };
  'opportunity.won': OpportunityRefs;
  'opportunity.lost': OpportunityRefs;
  'opportunity.deleted': OpportunityRefs;
  'import.completed': {
    importId: string;
    created: number;
    updated: number;
    failed: number;
  };
}

interface NoteRefs {
  noteId: string;
  contactId: string | null;
  companyId: string | null;
  opportunityId: string | null;
}

interface TaskRefs {
  taskId: string;
  contactId: string | null;
  assignedTo: string | null;
}

interface AppointmentRefs {
  appointmentId: string;
  contactId: string | null;
  ownerId: string | null;
}

interface OpportunityRefs {
  opportunityId: string;
  pipelineId: string;
  stageId: string;
  contactId: string | null;
}

export type CrmEventType = keyof CrmEventPayloads;

export const CRM_EVENT_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'contact.restored',
  'contact.merged',
  'contact.tag_applied',
  'contact.tag_removed',
  'contact.score_changed',
  'contact.owner_assigned',
  'company.created',
  'company.updated',
  'company.deleted',
  'note.added',
  'note.updated',
  'note.deleted',
  'task.created',
  'task.updated',
  'task.completed',
  'task.reopened',
  'task.deleted',
  'appointment.created',
  'appointment.updated',
  'appointment.cancelled',
  'appointment.deleted',
  'opportunity.created',
  'opportunity.updated',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  'opportunity.deleted',
  'import.completed',
] as const satisfies readonly CrmEventType[];

// Compile-time guard: CRM_EVENT_TYPES lists every key of CrmEventPayloads.
type MissingCrmEvent = Exclude<CrmEventType, (typeof CRM_EVENT_TYPES)[number]>;
const crmEventListIsComplete: MissingCrmEvent extends never ? true : never = true;
void crmEventListIsComplete;

// ------------------------------------------------------------------ e-commerce

/**
 * Money facts shared by every e-commerce event: they feed both the automation
 * engine (goals such as "product purchased") and analytics revenue attribution.
 * Amounts are integer minor units (cents) in `currency` (ISO 4217).
 * `visitorId` is the analytics visitor id captured on the order/subscription, if any.
 */
interface CommerceMoney {
  contactId: string;
  amountMinor: number;
  currency: string;
  visitorId: string | null;
}

interface OrderFacts extends CommerceMoney {
  orderId: string;
  orderNumber: string;
  /** Distinct product ids on the order lines. */
  productIds: string[];
  subscriptionId: string | null;
  source: 'manual' | 'api' | 'subscription';
}

interface SubscriptionFacts extends CommerceMoney {
  subscriptionId: string;
  productId: string;
  planId: string;
  /** `amountMinor` is the price of one billing period (unit price × quantity). */
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
}

/** Typed payload of every e-commerce event. */
export interface CommerceEventPayloads {
  /** `amountMinor` = order total. */
  'order.created': OrderFacts & { status: string };
  /** The order became fully paid (emitted once). `renewal`: generated by a subscription renewal. */
  'order.paid': OrderFacts & { renewal: boolean };
  'order.cancelled': OrderFacts;
  'payment.recorded': CommerceMoney & {
    paymentId: string;
    orderId: string;
    method: string;
    transactionId: string | null;
    subscriptionId: string | null;
    renewal: boolean;
  };
  /** A failed charge recorded via API (there is no gateway); moves subscriptions to past_due. */
  'payment.failed': CommerceMoney & {
    paymentId: string;
    orderId: string;
    method: string;
    transactionId: string | null;
    subscriptionId: string | null;
  };
  'refund.recorded': CommerceMoney & {
    refundId: string;
    orderId: string;
    paymentId: string | null;
    transactionId: string | null;
    /** True when the order's net paid amount reached zero. */
    full: boolean;
  };
  'subscription.started': SubscriptionFacts & { trial: boolean; orderId: string | null };
  'subscription.upgraded': SubscriptionFacts & { fromPlanId: string; fromAmountMinor: number };
  'subscription.downgraded': SubscriptionFacts & { fromPlanId: string; fromAmountMinor: number };
  'subscription.renewed': SubscriptionFacts & {
    orderId: string;
    periodStart: string;
    periodEnd: string;
  };
  'subscription.cancel_scheduled': SubscriptionFacts & { endsAt: string };
  'subscription.reactivated': SubscriptionFacts & { from: 'paused' | 'cancel_scheduled' };
  'subscription.paused': SubscriptionFacts;
  'subscription.past_due': SubscriptionFacts & { orderId: string };
  'subscription.ended': SubscriptionFacts & { reason: 'cancelled' | 'period_end' };
  'subscription.trial_started': SubscriptionFacts & { trialEndsAt: string };
  'subscription.trial_converted': SubscriptionFacts & { orderId: string };
}

export type CommerceEventType = keyof CommerceEventPayloads;

export const COMMERCE_EVENT_TYPES = [
  'order.created',
  'order.paid',
  'order.cancelled',
  'payment.recorded',
  'payment.failed',
  'refund.recorded',
  'subscription.started',
  'subscription.upgraded',
  'subscription.downgraded',
  'subscription.renewed',
  'subscription.cancel_scheduled',
  'subscription.reactivated',
  'subscription.paused',
  'subscription.past_due',
  'subscription.ended',
  'subscription.trial_started',
  'subscription.trial_converted',
] as const satisfies readonly CommerceEventType[];

type MissingCommerceEvent = Exclude<CommerceEventType, (typeof COMMERCE_EVENT_TYPES)[number]>;
const commerceEventListIsComplete: MissingCommerceEvent extends never ? true : never = true;
void commerceEventListIsComplete;

/** Every event the tenant outbox can hold (CRM + e-commerce + forms, bookings, pages + conversations + signatures). */
export type OutboxEventPayloads = CrmEventPayloads &
  CommerceEventPayloads &
  PublishingEventPayloads &
  ConversationEventPayloads &
  EsignEventPayloads;
export type OutboxEventType = keyof OutboxEventPayloads;

/** Events emitted by later modules (forms, email, booking). */
const OTHER_EVENT_TYPES = [
  'form.submitted',
  'email.sent',
  'email.delivered',
  'email.opened',
  'email.link_clicked',
  'email.bounced',
  'email.complained',
  'email.unsubscribed',
] as const;

export const EVENT_TYPES = [
  ...CRM_EVENT_TYPES,
  ...COMMERCE_EVENT_TYPES,
  ...OTHER_EVENT_TYPES,
  ...PUBLISHING_EVENT_TYPES,
  ...CONVERSATION_EVENT_TYPES,
  ...ESIGN_OUTBOX_EVENT_TYPES,
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Who caused an event: a user (session or API key) or the system itself. */
export interface EventActor {
  readonly type: 'user' | 'api_key' | 'app' | 'system';
  readonly id: string | null;
}

/** Envelope every domain event travels in (queues, Engine DO, audit). */
export interface DomainEvent<TPayload = Record<string, unknown>> {
  readonly type: EventType;
  readonly tenantId: string;
  /** ISO 8601 timestamp. */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** A CRM event as stored in the tenant outbox, with its payload typed by `type`. */
export type CrmOutboxEvent = {
  [K in CrmEventType]: {
    readonly id: string;
    readonly type: K;
    readonly occurredAt: string;
    readonly actor: EventActor;
    readonly payload: CrmEventPayloads[K];
  };
}[CrmEventType];

/** Any event as stored in the tenant outbox (CRM or e-commerce), payload typed by `type`. */
export type OutboxEvent = {
  [K in OutboxEventType]: {
    readonly id: string;
    readonly type: K;
    readonly occurredAt: string;
    readonly actor: EventActor;
    readonly payload: OutboxEventPayloads[K];
  };
}[OutboxEventType];
