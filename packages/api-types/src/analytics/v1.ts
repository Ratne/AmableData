import { z } from 'zod';

/**
 * Workspace server API (`/api/v1`, workspace API keys with `tracking:ingest`):
 * leads, sales and events sent by the client's backend. Contact data stays in
 * the workspace; sites receive only hashes and links.
 */

const visitorIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);
const occurredAtSchema = z.union([z.number().int().positive(), z.iso.datetime({ offset: true })]);
const clientIdSchema = z.string().regex(/^[\w.:-]{1,128}$/);
const paramsSchema = z
  .record(z.string().max(64), z.union([z.string().max(255), z.number().finite(), z.boolean()]))
  .refine((r) => Object.keys(r).length <= 10, 'at most 10 params');

const contactFields = {
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().min(3).max(32).optional(),
  first_name: z.string().trim().min(1).max(255).optional(),
  last_name: z.string().trim().min(1).max(255).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  street: z.string().trim().min(1).max(255).optional(),
  city: z.string().trim().min(1).max(255).optional(),
  region: z.string().trim().min(1).max(255).optional(),
  postal_code: z.string().trim().min(1).max(32).optional(),
  country: z.string().trim().min(1).max(64).optional(),
};

const placement = {
  /** Visitor id from the tracker (`amable('id')` / `_amb_vid`), the strongest link. */
  visitor_id: visitorIdSchema.optional(),
  /** Forces the site; otherwise the visitor's site, then the contact's last-seen site. */
  site_id: z.string().min(1).max(64).optional(),
};

/** `POST /api/v1/leads`: creates or enriches a contact and records a `lead` goal on its visitor. */
export const v1LeadSchema = z
  .strictObject({
    event_id: clientIdSchema.optional(),
    occurred_at: occurredAtSchema.optional(),
    ...contactFields,
    ...placement,
    /** Lead source label (form name, landing…), stored as a goal param. */
    source: z.string().trim().min(1).max(64).optional(),
    params: paramsSchema.optional(),
  })
  .refine((l) => l.email !== undefined || l.phone !== undefined, {
    message: 'email or phone is required',
    path: ['email'],
  });
export type V1Lead = z.infer<typeof v1LeadSchema>;

export const v1LeadResultSchema = z.object({
  contact_id: z.string().nullable(),
  created: z.boolean(),
  site_id: z.string().nullable(),
  visitor_id: z.string().nullable(),
});
export type V1LeadResult = z.infer<typeof v1LeadResultSchema>;

/** `existing`: a site already had the payment (the browser sent it first): it stays there. */
export const SALE_ATTRIBUTIONS = [
  'existing',
  'forced',
  'visitor',
  'last_touch',
  'unattributed',
] as const;
export type SaleAttribution = (typeof SALE_ATTRIBUTIONS)[number];

/**
 * `POST /api/v1/sales`: one sale per `transaction_id` (retries are no-ops).
 * The site is decided once and stored; the same transaction id seen by the
 * browser purchase event is the same payment.
 */
export const v1SaleSchema = z
  .strictObject({
    transaction_id: z.string().min(1).max(255),
    amount: z.number().finite().nonnegative(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, 'ISO 4217 code')
      .transform((s) => s.toUpperCase()),
    order_id: z.string().min(1).max(255).optional(),
    renewal: z.boolean().optional(),
    occurred_at: occurredAtSchema.optional(),
    ...contactFields,
    ...placement,
  })
  .refine((s) => s.email !== undefined || s.phone !== undefined || s.visitor_id !== undefined, {
    message: 'email, phone or visitor_id is required',
    path: ['email'],
  });
export type V1Sale = z.infer<typeof v1SaleSchema>;

export const v1SaleResultSchema = z.object({
  transaction_id: z.string(),
  contact_id: z.string().nullable(),
  site_id: z.string().nullable(),
  visitor_id: z.string().nullable(),
  attribution: z.enum(SALE_ATTRIBUTIONS),
  duplicate: z.boolean(),
});
export type V1SaleResult = z.infer<typeof v1SaleResultSchema>;

/** `POST /api/v1/sales/{transaction_id}/refunds`: once per `refund_id`; no amount = the rest. */
export const v1RefundSchema = z.strictObject({
  refund_id: clientIdSchema,
  amount: z.number().finite().positive().optional(),
  occurred_at: occurredAtSchema.optional(),
});
export type V1Refund = z.infer<typeof v1RefundSchema>;

export const v1RefundResultSchema = z.object({
  refund_id: z.string(),
  transaction_id: z.string(),
  amount: z.number(),
  refunded_total: z.number(),
  duplicate: z.boolean(),
});
export type V1RefundResult = z.infer<typeof v1RefundResultSchema>;
