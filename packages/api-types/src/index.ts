import { z } from 'zod';

/**
 * Zod schemas shared between the SPA and the API.
 * Foundations phase ships only a minimal set (health, me, tenant); the REST v2
 * surface is generated OpenAPI-first from schemas like these in later phases.
 */

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  /** Highest applied installation migration id — proves boot migrations ran. */
  schemaVersion: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const localeSchema = z.enum(['en', 'it']);
export type Locale = z.infer<typeof localeSchema>;

export const themeSchema = z.enum(['light', 'dark', 'system']);
export type Theme = z.infer<typeof themeSchema>;

export const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  locale: localeSchema,
  theme: themeSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const tenantSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type Tenant = z.infer<typeof tenantSchema>;

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
