import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';
import { ENROLLMENT_STATUSES, POSITION_STATUSES } from './api';

/**
 * `GET /contacts/{id}/automations`: the contact's enrollments across every
 * automation. `scope=current` = active enrollments, `history` = ended ones
 * (completed, removed, failed); both newest first, cursor-paginated.
 */
export const listContactEnrollmentsQuerySchema = z.object({
  scope: z.enum(['current', 'history']).default('current'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});
export type ListContactEnrollmentsQuery = z.infer<typeof listContactEnrollmentsQuerySchema>;

/** Where an active enrollment stands: node and step of the published version it runs on. */
export const contactEnrollmentPositionSchema = z.object({
  id: idSchema,
  node_id: z.string(),
  node_type: z.enum(['goal', 'sequence', 'decision', 'note']).nullable(),
  node_label: z.string().nullable(),
  step_id: z.string().nullable(),
  step_type: z.string().nullable(),
  step_index: z.number().int(),
  status: z.enum(POSITION_STATUSES),
  /** Next action (timer expiry, retry or scheduled run); null when waiting for a goal. */
  due_at: timestampSchema.nullable(),
  last_error: z.string().nullable(),
});
export type ContactEnrollmentPosition = z.infer<typeof contactEnrollmentPositionSchema>;

export const contactEnrollmentSchema = z.object({
  id: idSchema,
  automation_id: idSchema,
  automation_name: z.string(),
  automation_status: z.enum(['draft', 'active', 'inactive', 'deleted']),
  version_number: z.number().int().nullable(),
  status: z.enum(ENROLLMENT_STATUSES),
  source: z.enum(['goal', 'manual', 'sequence']),
  started_at: timestampSchema,
  ended_at: timestampSchema.nullable(),
  /** Why it ended (last `completed`/`removed`/`step_failed` log line, kept 90 days). */
  outcome: z.string().nullable(),
  goals_reached: z.array(
    z.object({ node_id: z.string(), node_label: z.string().nullable(), at: timestampSchema }),
  ),
  positions: z.array(contactEnrollmentPositionSchema),
});
export type ContactEnrollment = z.infer<typeof contactEnrollmentSchema>;
