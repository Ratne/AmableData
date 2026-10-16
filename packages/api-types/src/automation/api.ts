import { z } from 'zod';
import { idSchema, timestampSchema } from '../crm/common';
import { folderFilterQuery } from '../folders/index';
import {
  apiCallNameSchema,
  automationGraphSchema,
  automationSettingsSchema,
  nodeIdSchema,
  timeZoneRefSchema,
} from './graph';

/** REST v2 schemas of the automation engine (`/api/v2/t/{slug}/automations…`). */

export const AUTOMATION_STATUSES = ['draft', 'active', 'inactive'] as const;
export const automationStatusSchema = z.enum(AUTOMATION_STATUSES);
export type AutomationStatus = z.infer<typeof automationStatusSchema>;

export const createAutomationSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  settings: automationSettingsSchema.optional(),
  graph: automationGraphSchema.optional(),
  folder_id: idSchema.nullable().optional(),
});
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z.strictObject({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  settings: automationSettingsSchema.optional(),
});
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

/** Saves the draft graph; `revision` must match the current draft revision (optimistic lock). */
export const saveDraftSchema = z.strictObject({
  graph: automationGraphSchema,
  revision: z.number().int().min(1),
});
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;

export const automationSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  status: automationStatusSchema,
  /** Folder of the automation (null = unfiled). */
  folder_id: idSchema.nullable(),
  settings: automationSettingsSchema,
  draft_revision: z.number().int(),
  /** True when the draft differs from the published version. */
  has_unpublished_changes: z.boolean(),
  published_version: z
    .object({ id: idSchema, number: z.number().int(), published_at: timestampSchema })
    .nullable(),
  active_enrollments: z.number().int(),
  created_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Automation = z.infer<typeof automationSchema>;

export const automationDetailSchema = automationSchema.extend({
  draft_graph: automationGraphSchema,
});
export type AutomationDetail = z.infer<typeof automationDetailSchema>;

export const listAutomationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  status: automationStatusSchema.optional(),
  /** Keeps automations whose name contains it (case-insensitive). */
  q: z.string().trim().max(200).optional(),
  ...folderFilterQuery,
});
export type ListAutomationsQuery = z.infer<typeof listAutomationsQuerySchema>;

export const automationVersionSchema = z.object({
  id: idSchema,
  automation_id: idSchema,
  number: z.number().int(),
  settings: automationSettingsSchema,
  graph: automationGraphSchema,
  published_by: z.string().nullable(),
  published_at: timestampSchema,
});
export type AutomationVersion = z.infer<typeof automationVersionSchema>;
export const automationVersionSummarySchema = automationVersionSchema.omit({ graph: true });
export type AutomationVersionSummary = z.infer<typeof automationVersionSummarySchema>;

export const validationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  path: z.string(),
  node_id: z.string().nullable(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export const validationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(validationIssueSchema),
});
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const publishResultSchema = z.object({
  automation: automationSchema,
  version: automationVersionSummarySchema,
  issues: z.array(validationIssueSchema),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

// ------------------------------------------------------------ enrollments

export const ENROLLMENT_STATUSES = ['active', 'completed', 'removed', 'failed'] as const;
export const POSITION_STATUSES = [
  'scheduled',
  'running',
  'paused',
  'waiting',
  'suspended',
  'done',
  'cancelled',
  'failed',
] as const;

export const enrollmentPositionSchema = z.object({
  id: idSchema,
  node_id: z.string(),
  step_id: z.string().nullable(),
  step_index: z.number().int(),
  status: z.enum(POSITION_STATUSES),
  due_at: timestampSchema.nullable(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
});
export type EnrollmentPosition = z.infer<typeof enrollmentPositionSchema>;

export const enrollmentSchema = z.object({
  id: idSchema,
  automation_id: idSchema,
  version_id: idSchema,
  contact_id: idSchema,
  status: z.enum(ENROLLMENT_STATUSES),
  source: z.enum(['goal', 'manual', 'sequence']),
  entry_node_id: z.string().nullable(),
  started_at: timestampSchema,
  ended_at: timestampSchema.nullable(),
  positions: z.array(enrollmentPositionSchema),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;

export const LOG_KINDS = [
  'enrolled',
  'goal_achieved',
  'node_entered',
  'step_done',
  'step_skipped',
  'step_waiting',
  'step_retry',
  'step_failed',
  'decision',
  'paused',
  'cancelled',
  'completed',
  'removed',
  'suspended',
  'resumed',
] as const;
export const executionLogEntrySchema = z.object({
  id: idSchema,
  kind: z.enum(LOG_KINDS),
  node_id: z.string().nullable(),
  step_id: z.string().nullable(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  at: timestampSchema,
});
export type ExecutionLogEntry = z.infer<typeof executionLogEntrySchema>;

export const enrollmentDetailSchema = enrollmentSchema.extend({
  log: z.array(executionLogEntrySchema),
});
export type EnrollmentDetail = z.infer<typeof enrollmentDetailSchema>;

export const listEnrollmentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  contact_id: idSchema.optional(),
  node_id: nodeIdSchema.optional(),
  /** With `node_id`: `current` (default) = positioned there now; `visited` = reached it at any time. */
  scope: z.enum(['current', 'visited']).optional(),
});
export type ListEnrollmentsQuery = z.infer<typeof listEnrollmentsQuerySchema>;

/** Manual enrollment: at a goal (as if achieved) or straight into a sequence; first entry goal by default. */
export const enrollContactSchema = z.strictObject({
  contact_id: idSchema,
  node_id: nodeIdSchema.optional(),
});
export type EnrollContactInput = z.infer<typeof enrollContactSchema>;

export const removeContactResultSchema = z.object({
  contact_id: idSchema,
  removed: z.boolean(),
});

// ------------------------------------------------------------------ stats

export const nodeStatsSchema = z.object({
  node_id: z.string(),
  /** Null for the node itself, the step id for per-step counters of a sequence. */
  step_id: z.string().nullable(),
  entered: z.number().int(),
  /** Contacts currently there (goals: contacts waiting for the goal). */
  active: z.number().int(),
  completed: z.number().int(),
  errors: z.number().int(),
});
export type NodeStats = z.infer<typeof nodeStatsSchema>;
export const automationStatsSchema = z.object({
  automation_id: idSchema,
  enrollments: z.object({
    active: z.number().int(),
    completed: z.number().int(),
    removed: z.number().int(),
    failed: z.number().int(),
  }),
  nodes: z.array(nodeStatsSchema),
});
export type AutomationStats = z.infer<typeof automationStatsSchema>;

// -------------------------------------------------------------- API goals

export const triggerApiGoalSchema = z.strictObject({
  contact_id: idSchema,
  /** Optional caller-supplied dedupe key: the same key fires at most once. */
  event_id: z.string().min(1).max(128).optional(),
});
export type TriggerApiGoalInput = z.infer<typeof triggerApiGoalSchema>;
export const callNameParamSchema = z.object({ callName: apiCallNameSchema });
export const triggerApiGoalResultSchema = z.object({
  call_name: z.string(),
  contact_id: idSchema,
  /** Goals achieved by this call (automation + node). */
  matched: z.array(z.object({ automation_id: idSchema, node_id: z.string() })),
  duplicate: z.boolean(),
});
export type TriggerApiGoalResult = z.infer<typeof triggerApiGoalResultSchema>;

// --------------------------------------------------------------- settings

export const engineSettingsSchema = z.object({
  /** Tenant time zone: fallback for contacts without a time zone. */
  time_zone: z.string(),
});
export type EngineSettings = z.infer<typeof engineSettingsSchema>;
export const updateEngineSettingsSchema = z.strictObject({ time_zone: timeZoneRefSchema });

export const signingSecretSchema = z.object({
  automation_id: idSchema,
  /** HMAC-SHA256 key of `Amable-Signature` on HTTP steps. */
  secret: z.string(),
});

export const automationIdParamSchema = z.object({ id: idSchema });
export const automationVersionParamSchema = z.object({ id: idSchema, versionId: idSchema });
export const automationEnrollmentParamSchema = z.object({ id: idSchema, enrollmentId: idSchema });
export const automationContactParamSchema = z.object({ id: idSchema, contactId: idSchema });
