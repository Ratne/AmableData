/**
 * Web analytics events published for other modules (automation engine,
 * reports). Emitted by the core's analytics sync (apps/core/src/analytics/sync.ts)
 * for visitors linked to a CRM contact, through `Engine.ingest(tenantId, events)`
 * (contract `AutomationInboundEvent` of ./automation).
 *
 * - `analytics.goal` — a web goal (tracker `amable('goal')`, `data-amable-goal`,
 *   scroll goals, server goals; not the reserved `payment` / `free_trial` /
 *   subscription lifecycle goals, which reach the engine as CRM outbox events).
 *   Delivered today: it is part of `AutomationEventPayloads`.
 * - `analytics.page_visited` — the first view of a page in a session.
 *   Delivered as soon as the engine lists it in `AUTOMATION_EVENT_TYPES`
 *   (add `'analytics.page_visited': AnalyticsPageVisitedPayload` to
 *   `AutomationEventPayloads`); until then the sync drops it.
 *
 * Event ids are stable (`an_<sha256(site|kind|visitor|ts|name)[0..32]>`), so the
 * engine's dedupe makes redeliveries harmless. Latency: the next sync pass
 * (cron every minute, or right after a mutating REST request).
 */

export const ANALYTICS_AUTOMATION_EVENTS = {
  goal: 'analytics.goal',
  pageVisited: 'analytics.page_visited',
} as const;

export interface AnalyticsGoalPayload {
  contactId: string;
  siteId: string;
  goalName: string;
}

export interface AnalyticsPageVisitedPayload {
  contactId: string;
  siteId: string;
  visitorId: string;
  hostname: string | null;
  /** Path without query string (hash kept for hash-routed sites). */
  path: string;
  url: string | null;
}

export interface AnalyticsAutomationEventPayloads {
  'analytics.goal': AnalyticsGoalPayload;
  'analytics.page_visited': AnalyticsPageVisitedPayload;
}

export type AnalyticsAutomationEventType = keyof AnalyticsAutomationEventPayloads;
