import { z } from 'zod';

/** Zod schemas shared between the SPA, the core worker and the edge worker. */

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  /** Highest applied installation migration id — proves boot migrations ran. */
  schemaVersion: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** CRM REST v2 schemas (contacts, companies, tags, custom fields, search, …). */
export * from './crm/index';

/** Automation engine REST v2 schemas and the automation graph JSON. */
export * from './automation/index';

/** E-commerce REST v2 schemas (catalog, orders, payments, subscriptions, invoices). */
export * from './commerce/index';

/** Web analytics: ingest protocol, sites and query API. */
export * from './analytics/index';

/** Email marketing: templates, snippets, suppressions, messages, settings, broadcasts. */
export * from './email/index';

/** Edge ↔ core gateway wire contract (hosted forms, booking pages, landing SSR). */
export * from './edge-gateway';

/** Forms REST v2: forms, submissions, connections. */
export * from './forms/index';

/** Calendars & bookings REST v2: calendars, event types, availability, bookings. */
export * from './booking/index';

/** Landing pages REST v2: pages, versions, publish, saved sections, media. */
export * from './pages/index';

/** Folders of automations and landing pages. */
export * from './folders/index';

/** Settings > Billing & wallet (plan, email quota, wallet of the platform link). */
export * from './billing/index';

/** Settings > General: workspace identity, white label, regional defaults, company profile. */
export * from './workspace/index';

/** Conversations: shared inbox with channels provided by apps. */
export * from './conversations/index';

/** Electronic signatures: templates, signature requests, audit trail. */
export * from './esign/index';
