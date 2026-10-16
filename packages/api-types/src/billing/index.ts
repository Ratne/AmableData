import { z } from 'zod';
import { timestampSchema } from '../crm/common';

/**
 * Settings > Billing & wallet: read-only view of the installation's plan, email
 * quota and wallet, built from the last quota snapshot of the control plane.
 */

export const BILLING_MODES = ['managed', 'open_source'] as const;
export const billingModeSchema = z.enum(BILLING_MODES);
export type BillingMode = z.infer<typeof billingModeSchema>;

export const SERVICE_STATES = ['trial', 'active', 'grace', 'suspended', 'self_hosted'] as const;
export const serviceStateSchema = z.enum(SERVICE_STATES);
export type ServiceState = z.infer<typeof serviceStateSchema>;

/** `fresh`: within its TTL; `stale`: control plane unreachable, last known data; `missing`: none received. */
export const BILLING_SNAPSHOT_STATUSES = ['fresh', 'stale', 'missing'] as const;
export const billingSnapshotStatusSchema = z.enum(BILLING_SNAPSHOT_STATUSES);
export type BillingSnapshotStatus = z.infer<typeof billingSnapshotStatusSchema>;

export const billingPlanSchema = z.object({
  code: z.literal('managed'),
  price_monthly: z.number(),
  currency: z.string(),
});
export type BillingPlan = z.infer<typeof billingPlanSchema>;

export const billingEmailQuotaSchema = z.object({
  included_monthly: z.number().int(),
  /** Includes sends not yet reported to the control plane. */
  used_this_period: z.number().int(),
  remaining: z.number().int(),
  period_start: timestampSchema,
  period_end: timestampSchema,
  /** Price of 1,000 emails beyond the included quota, paid from the wallet. */
  overage_per_1000: z.number(),
  currency: z.string(),
  caps: z.object({
    hourly: z.number().int().nullable(),
    daily: z.number().int().nullable(),
  }),
});
export type BillingEmailQuota = z.infer<typeof billingEmailQuotaSchema>;

export const billingWalletSchema = z.object({
  /** Decimal amount, net of the overage of sends not yet reported. */
  balance: z.number(),
  balance_micros: z.number().int(),
  currency: z.string(),
});
export type BillingWallet = z.infer<typeof billingWalletSchema>;

export const billingOverviewSchema = z.object({
  mode: billingModeSchema,
  /** A license key links this installation to a platform account. */
  linked: z.boolean(),
  service_state: serviceStateSchema.nullable(),
  plan: billingPlanSchema.nullable(),
  email: billingEmailQuotaSchema.nullable(),
  wallet: billingWalletSchema.nullable(),
  snapshot: z.object({
    status: billingSnapshotStatusSchema,
    stale: z.boolean(),
    issued_at: timestampSchema.nullable(),
  }),
  portal: z.object({
    url: z.string(),
    billing_url: z.string(),
    wallet_url: z.string(),
    /** Account creation, to link an open source installation and buy credits. */
    connect_url: z.string(),
  }),
});
export type BillingOverview = z.infer<typeof billingOverviewSchema>;
