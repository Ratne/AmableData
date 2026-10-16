import { z } from 'zod';
import {
  dateSchema,
  dateTimeSchema,
  idSchema,
  optText,
  richTextSchema,
  timestampSchema,
} from './common';
import { customFieldValuesSchema } from './custom-fields';

// -------------------------------------------------------------------- tasks

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export const TASK_TYPES = ['todo', 'call', 'email', 'meeting', 'other'] as const;

const taskFields = {
  description: richTextSchema.nullable().optional(),
  contact_id: idSchema.nullable().optional(),
  company_id: idSchema.nullable().optional(),
  opportunity_id: idSchema.nullable().optional(),
  assigned_to: idSchema.nullable().optional(),
  due_at: dateTimeSchema.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  type: z.enum(TASK_TYPES).optional(),
};

export const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(255),
  ...taskFields,
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(255).optional(),
  ...taskFields,
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskSchema = z.object({
  id: idSchema,
  title: z.string(),
  description: richTextSchema.nullable(),
  contact_id: idSchema.nullable(),
  company_id: idSchema.nullable(),
  opportunity_id: idSchema.nullable(),
  assigned_to: idSchema.nullable(),
  due_at: timestampSchema.nullable(),
  priority: z.enum(TASK_PRIORITIES),
  type: z.enum(TASK_TYPES),
  status: z.enum(['open', 'completed']),
  completed_at: timestampSchema.nullable(),
  completed_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Task = z.infer<typeof taskSchema>;

export const listTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  status: z.enum(['open', 'completed']).optional(),
  assigned_to: idSchema.optional(),
  contact_id: idSchema.optional(),
  opportunity_id: idSchema.optional(),
  due_before: dateTimeSchema.optional(),
  due_after: dateTimeSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

// ------------------------------------------------------------- appointments

export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;

const appointmentFields = {
  description: optText(10_000),
  location: optText(500),
  all_day: z.boolean().optional(),
  time_zone: optText(64),
  contact_id: idSchema.nullable().optional(),
  company_id: idSchema.nullable().optional(),
  opportunity_id: idSchema.nullable().optional(),
  owner_id: idSchema.nullable().optional(),
  attendees: z
    .array(z.strictObject({ email: z.email(), name: optText(255) }))
    .max(50)
    .optional(),
  reminder_minutes: z.array(z.number().int().min(0).max(40_320)).max(5).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
};

export const createAppointmentSchema = z.strictObject({
  title: z.string().trim().min(1).max(255),
  start_at: dateTimeSchema,
  end_at: dateTimeSchema,
  ...appointmentFields,
});
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const updateAppointmentSchema = z.strictObject({
  title: z.string().trim().min(1).max(255).optional(),
  start_at: dateTimeSchema.optional(),
  end_at: dateTimeSchema.optional(),
  ...appointmentFields,
});
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>;

export const appointmentSchema = z.object({
  id: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  start_at: timestampSchema,
  end_at: timestampSchema,
  all_day: z.boolean(),
  time_zone: z.string().nullable(),
  contact_id: idSchema.nullable(),
  company_id: idSchema.nullable(),
  opportunity_id: idSchema.nullable(),
  owner_id: idSchema.nullable(),
  attendees: z.array(z.object({ email: z.string(), name: z.string().nullable().optional() })),
  reminder_minutes: z.array(z.number().int()),
  status: z.enum(APPOINTMENT_STATUSES),
  source: z.enum(['manual', 'api', 'booking']),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Appointment = z.infer<typeof appointmentSchema>;

export const listAppointmentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  from: dateTimeSchema.optional(),
  to: dateTimeSchema.optional(),
  owner_id: idSchema.optional(),
  contact_id: idSchema.optional(),
});
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;

export const calendarQuerySchema = z.object({
  from: dateTimeSchema,
  to: dateTimeSchema,
  owner_id: idSchema.optional(),
});
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const calendarResponseSchema = z.object({
  appointments: z.array(appointmentSchema),
  tasks: z.array(taskSchema),
});
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

// ---------------------------------------------------------------- pipelines

export const STAGE_KINDS = ['open', 'won', 'lost'] as const;

export const createStageSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  probability: z.number().int().min(0).max(100).optional(),
  kind: z.enum(STAGE_KINDS).optional(),
  position: z.number().int().min(0).optional(),
});
export const updateStageSchema = createStageSchema.partial();
export type CreateStageInput = z.infer<typeof createStageSchema>;
export type UpdateStageInput = z.infer<typeof updateStageSchema>;

export const createPipelineSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  is_default: z.boolean().optional(),
  /** Defaults to New / Qualified / Proposal / Won / Lost when omitted. */
  stages: z.array(createStageSchema).min(1).max(30).optional(),
});
export const updatePipelineSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  is_default: z.boolean().optional(),
});
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;

export const stageSchema = z.object({
  id: idSchema,
  pipeline_id: idSchema,
  name: z.string(),
  probability: z.number().int(),
  kind: z.enum(STAGE_KINDS),
  position: z.number().int(),
});
export type Stage = z.infer<typeof stageSchema>;

export const pipelineSchema = z.object({
  id: idSchema,
  name: z.string(),
  is_default: z.boolean(),
  stages: z.array(stageSchema),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Pipeline = z.infer<typeof pipelineSchema>;

export const stageIdParamSchema = z.object({ id: idSchema, stageId: idSchema });

// ------------------------------------------------------------ opportunities

const opportunityFields = {
  contact_id: idSchema.nullable().optional(),
  company_id: idSchema.nullable().optional(),
  owner_id: idSchema.nullable().optional(),
  /** Amount in minor units (cents). */
  value_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  expected_close_date: dateSchema.nullable().optional(),
  lost_reason: optText(500),
  next_action: optText(500),
  next_action_at: dateTimeSchema.nullable().optional(),
  custom_fields: customFieldValuesSchema.optional(),
};

export const createOpportunitySchema = z.strictObject({
  title: z.string().trim().min(1).max(255),
  /** Defaults to the default pipeline. */
  pipeline_id: idSchema.optional(),
  /** Defaults to the first stage of the pipeline. */
  stage_id: idSchema.optional(),
  ...opportunityFields,
});
export type CreateOpportunityInput = z.infer<typeof createOpportunitySchema>;

export const updateOpportunitySchema = z.strictObject({
  title: z.string().trim().min(1).max(255).optional(),
  /** Moving to another stage emits `opportunity.stage_changed` (+ won/lost). */
  stage_id: idSchema.optional(),
  ...opportunityFields,
});
export type UpdateOpportunityInput = z.infer<typeof updateOpportunitySchema>;

export const opportunitySchema = z.object({
  id: idSchema,
  title: z.string(),
  pipeline_id: idSchema,
  stage_id: idSchema,
  status: z.enum(STAGE_KINDS),
  contact_id: idSchema.nullable(),
  company_id: idSchema.nullable(),
  owner_id: idSchema.nullable(),
  value_minor: z.number().int(),
  currency: z.string(),
  expected_close_date: z.string().nullable(),
  lost_reason: z.string().nullable(),
  next_action: z.string().nullable(),
  next_action_at: timestampSchema.nullable(),
  stage_changed_at: timestampSchema,
  closed_at: timestampSchema.nullable(),
  custom_fields: customFieldValuesSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Opportunity = z.infer<typeof opportunitySchema>;

export const listOpportunitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
  pipeline_id: idSchema.optional(),
  stage_id: idSchema.optional(),
  owner_id: idSchema.optional(),
  contact_id: idSchema.optional(),
  status: z.enum(STAGE_KINDS).optional(),
});
export type ListOpportunitiesQuery = z.infer<typeof listOpportunitiesQuerySchema>;
