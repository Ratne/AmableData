import { z } from 'zod';

/**
 * Web tracking suppressions (opt-out, erasure): a visitor id, a CRM contact
 * (its linked visitors and hashed emails/phones) or a plain email/phone,
 * hashed on receipt. `purge` also erases the tracked data (site rows and the
 * R2 archive, rewritten by a background job).
 */
export const suppressionRequestSchema = z
  .strictObject({
    visitor_id: z
      .string()
      .regex(/^[A-Za-z0-9-]{8,64}$/)
      .optional(),
    contact_id: z.string().min(1).max(64).optional(),
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().min(3).max(32).optional(),
    purge: z.boolean().default(true),
    reason: z.string().trim().min(1).max(255).optional(),
  })
  .refine(
    (s) =>
      s.visitor_id !== undefined ||
      s.contact_id !== undefined ||
      s.email !== undefined ||
      s.phone !== undefined,
    { message: 'visitor_id, contact_id, email or phone is required', path: ['visitor_id'] },
  );
export type SuppressionRequest = z.infer<typeof suppressionRequestSchema>;

export const suppressionOutcomeSchema = z.object({
  sites: z.number().int(),
  visitors: z.number().int(),
  purge_jobs: z.number().int(),
});

export const SUPPRESSION_KINDS = ['visitor', 'email', 'phone'] as const;

export const webSuppressionSchema = z.object({
  kind: z.enum(SUPPRESSION_KINDS),
  /** Visitor id or SHA-256 hex of the normalized email / phone. */
  value: z.string(),
  purge: z.boolean(),
  reason: z.string().nullable(),
  created_at: z.string(),
});
export type WebSuppression = z.infer<typeof webSuppressionSchema>;

export const purgeJobSchema = z.object({
  id: z.string(),
  site_id: z.string(),
  status: z.enum(['running', 'done']),
  visitors: z.number().int(),
  scanned: z.number().int(),
  rewritten: z.number().int(),
  /** Unreadable objects skipped (to inspect by hand). */
  failed: z.number().int(),
  /** First pass done: the recent days are rescanned daily until `tail_until`. */
  tail: z.boolean(),
  tail_until: z.string().nullable(),
  created_at: z.string(),
  done_at: z.string().nullable(),
});
export type PurgeJob = z.infer<typeof purgeJobSchema>;
