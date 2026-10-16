import { z } from 'zod';
import { dateSchema, idSchema, richTextSchema } from '../crm/common';
import { filterGroupSchema } from '../crm/search';
import { TASK_PRIORITIES, TASK_TYPES } from '../crm/sales';

/**
 * Automation graph JSON, schema version 1.
 *
 * A graph is a set of nodes and directed edges drawn on a canvas:
 * - `goal`: something a contact does (tag applied, form submitted, …). A goal
 *   without incoming edges is an entry point; reaching any goal pulls the
 *   contact out of every node upstream of it and moves it forward.
 * - `sequence`: ordered steps (timers and actions) run for each contact.
 * - `decision`: branches evaluated in order with the query-builder filter
 *   against the contact; the first match wins, otherwise the `default` handle.
 * - `note`: canvas annotation, never connected.
 *
 * Edges from a decision carry `source_handle` = branch id or `default`.
 * Edges from a sequence into a goal mean "after the sequence, wait for the goal".
 */

export const GRAPH_SCHEMA_VERSION = 1;

export const nodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, "_" and "-" (max 64)');

const positionSchema = z.strictObject({ x: z.number(), y: z.number() });
const labelSchema = z.string().trim().max(200).optional();

export const DURATION_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;
export const durationSchema = z.strictObject({
  amount: z.number().int().min(0).max(100_000),
  unit: z.enum(DURATION_UNITS),
});
export type Duration = z.infer<typeof durationSchema>;

export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm (24h)');

/**
 * IANA time zone, or `tenant` for the tenant time zone. When omitted, steps use
 * the contact time zone and fall back to the tenant time zone.
 */
export const timeZoneRefSchema = z.string().min(1).max(64);

/** Allowed send window, evaluated in the contact time zone (fallback: tenant). */
export const sendWindowSchema = z.strictObject({
  /** ISO weekdays 1 (Monday) … 7 (Sunday); all days when omitted. */
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  start: timeOfDaySchema,
  end: timeOfDaySchema,
});
export type SendWindow = z.infer<typeof sendWindowSchema>;

/** Contact date field: built-in date column or `custom.<key>` (DATE / DATE_TIME). */
export const contactDateFieldSchema = z
  .string()
  .regex(
    /^(birthday|anniversary|created_at|custom\.[a-z][a-z0-9_]{0,62})$/,
    'birthday, anniversary, created_at or custom.<key>',
  );

const idList = z.array(idSchema).max(100);
const userRefSchema = z.union([z.literal('contact_owner'), z.strictObject({ user_id: idSchema })]);
export type UserRef = z.infer<typeof userRefSchema>;

// ------------------------------------------------------------------ goals

/** Optional reference to the email that was opened / clicked. */
const emailRefSchema = z.strictObject({
  automation_id: idSchema.optional(),
  node_id: nodeIdSchema.optional(),
  step_id: nodeIdSchema.optional(),
  broadcast_id: idSchema.optional(),
});

export const GOAL_TRIGGER_TYPES = [
  'tag_applied',
  'tag_removed',
  'contact_created',
  'form_submitted',
  'product_purchased',
  'order_paid',
  'email_opened',
  'email_clicked',
  'lead_score',
  'api',
  'web_goal',
  'appointment_booked',
  'opportunity_stage_changed',
  'date_anniversary',
] as const;

export const apiCallNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'lowercase letters, digits, "_", "." and "-"');

export const goalTriggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('tag_applied'), tag_ids: idList.min(1) }),
  z.strictObject({ type: z.literal('tag_removed'), tag_ids: idList.min(1) }),
  z.strictObject({ type: z.literal('contact_created') }),
  /** Any form when `form_ids` is omitted. */
  z.strictObject({ type: z.literal('form_submitted'), form_ids: idList.optional() }),
  /** Paid order containing any of the products (any product when omitted). */
  z.strictObject({ type: z.literal('product_purchased'), product_ids: idList.optional() }),
  z.strictObject({
    type: z.literal('order_paid'),
    min_total_minor: z.number().int().min(0).optional(),
  }),
  z.strictObject({ type: z.literal('email_opened'), email: emailRefSchema.optional() }),
  z.strictObject({
    type: z.literal('email_clicked'),
    email: emailRefSchema.optional(),
    url_contains: z.string().min(1).max(500).optional(),
  }),
  /** Fires when the lead score crosses the threshold (`reaches` = upward, default). */
  z.strictObject({
    type: z.literal('lead_score'),
    threshold: z.number().int().min(-1_000_000).max(1_000_000),
    direction: z.enum(['reaches', 'drops_below']).optional(),
  }),
  /** Fired by `POST /automationGoals/{call_name}/trigger`. */
  z.strictObject({ type: z.literal('api'), call_name: apiCallNameSchema }),
  /** Web analytics goal of an identified visitor (analytics module). */
  z.strictObject({
    type: z.literal('web_goal'),
    goal_name: z.string().min(1).max(255),
    site_id: idSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('appointment_booked'),
    event_type_ids: idList.optional(),
    /** Also match appointments created in the CRM calendar. */
    include_crm_appointments: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('opportunity_stage_changed'),
    pipeline_id: idSchema.optional(),
    to_stage_ids: idList.optional(),
    from_stage_ids: idList.optional(),
  }),
  /**
   * Yearly date of a contact field: `offset_days` -3 fires three days before.
   * Evaluated once a day at `time` (default 09:00) in `time_zone` (default tenant).
   */
  z.strictObject({
    type: z.literal('date_anniversary'),
    field: contactDateFieldSchema,
    offset_days: z.number().int().min(-365).max(365).optional(),
    time: timeOfDaySchema.optional(),
    time_zone: timeZoneRefSchema.optional(),
  }),
]);
export type GoalTrigger = z.infer<typeof goalTriggerSchema>;
export type GoalTriggerType = GoalTrigger['type'];

export const goalNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('goal'),
  position: positionSchema,
  label: labelSchema,
  /** Achieved when any trigger matches. */
  triggers: z.array(goalTriggerSchema).min(1).max(10),
  /** `anyone` (default) can enter here; `enrolled_only` only contacts already in the automation. */
  accept: z.enum(['anyone', 'enrolled_only']).optional(),
});
export type GoalNode = z.infer<typeof goalNodeSchema>;

// ------------------------------------------------------------------ steps

const stepBase = {
  id: nodeIdSchema,
  label: labelSchema,
  /** After the retries are exhausted, continue with the next step instead of stopping. */
  continue_on_error: z.boolean().optional(),
};

const SETTABLE_CONTACT_FIELDS = [
  'given_name',
  'middle_name',
  'family_name',
  'preferred_name',
  'prefix',
  'suffix',
  'job_title',
  'website',
  'spouse_name',
  'time_zone',
  'preferred_locale',
  'company_id',
  'lead_source_id',
  'birthday',
  'anniversary',
  'score_value',
] as const;
export const settableContactFieldSchema = z.union([
  z.enum(SETTABLE_CONTACT_FIELDS),
  z.string().regex(/^custom\.[a-z][a-z0-9_]{0,62}$/, 'custom.<key>'),
]);
export { SETTABLE_CONTACT_FIELDS };

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const STEP_TYPES = [
  'delay',
  'wait_until',
  'field_timer',
  'send_email',
  'apply_tag',
  'remove_tag',
  'add_note',
  'create_task',
  'create_appointment',
  'set_field',
  'assign_owner',
  'create_opportunity',
  'move_opportunity_stage',
  'create_order',
  'cancel_subscription',
  'http_request',
  'add_to_sequence',
  'remove_from_sequence',
  'end',
] as const;

export const stepSchema = z.discriminatedUnion('type', [
  /** Waits for a duration; with `window` the contact resumes at the next allowed slot. */
  z.strictObject({
    ...stepBase,
    type: z.literal('delay'),
    duration: durationSchema,
    window: sendWindowSchema.optional(),
  }),
  /** Waits until a calendar date and time (immediately when already past). */
  z.strictObject({
    ...stepBase,
    type: z.literal('wait_until'),
    date: dateSchema,
    time: timeOfDaySchema,
    time_zone: timeZoneRefSchema.optional(),
  }),
  /** Waits until a moment relative to a contact date field. */
  z.strictObject({
    ...stepBase,
    type: z.literal('field_timer'),
    field: contactDateFieldSchema,
    offset: z
      .strictObject({ ...durationSchema.shape, direction: z.enum(['before', 'after']) })
      .optional(),
    time: timeOfDaySchema.optional(),
    /** Next yearly occurrence (birthdays, anniversaries) instead of the exact date. */
    yearly: z.boolean().optional(),
    /** When the field is empty: skip the timer (default) or stop the contact here. */
    if_missing: z.enum(['skip', 'stop']).optional(),
    time_zone: timeZoneRefSchema.optional(),
  }),
  /** Template id, or inline subject + Tiptap body. */
  z.strictObject({
    ...stepBase,
    type: z.literal('send_email'),
    template_id: idSchema.optional(),
    subject: z.string().trim().min(1).max(500).optional(),
    preheader: z.string().trim().max(500).optional(),
    body: richTextSchema.optional(),
    from_name: z.string().trim().max(200).optional(),
    reply_to: z.email().optional(),
    window: sendWindowSchema.optional(),
  }),
  z.strictObject({ ...stepBase, type: z.literal('apply_tag'), tag_ids: idList.min(1) }),
  z.strictObject({ ...stepBase, type: z.literal('remove_tag'), tag_ids: idList.min(1) }),
  z.strictObject({
    ...stepBase,
    type: z.literal('add_note'),
    title: z.string().trim().max(255).optional(),
    body: richTextSchema,
  }),
  z.strictObject({
    ...stepBase,
    type: z.literal('create_task'),
    title: z.string().trim().min(1).max(255),
    description: richTextSchema.optional(),
    due_in: durationSchema.optional(),
    assign_to: userRefSchema.optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    task_type: z.enum(TASK_TYPES).optional(),
  }),
  z.strictObject({
    ...stepBase,
    type: z.literal('create_appointment'),
    title: z.string().trim().min(1).max(255),
    start_in: durationSchema,
    duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    owner: userRefSchema.optional(),
    location: z.string().trim().max(500).optional(),
    description: z.string().trim().max(10_000).optional(),
  }),
  /** `increment` adds a number (score_value or numeric custom fields). */
  z.strictObject({
    ...stepBase,
    type: z.literal('set_field'),
    field: settableContactFieldSchema,
    value: z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]),
    mode: z.enum(['set', 'increment']).optional(),
  }),
  /** `fixed` assigns the first user; `round_robin` rotates among them. */
  z.strictObject({
    ...stepBase,
    type: z.literal('assign_owner'),
    user_ids: z.array(idSchema).min(1).max(50),
    strategy: z.enum(['fixed', 'round_robin']).optional(),
  }),
  z.strictObject({
    ...stepBase,
    type: z.literal('create_opportunity'),
    title: z.string().trim().min(1).max(255),
    pipeline_id: idSchema.optional(),
    stage_id: idSchema.optional(),
    value_minor: z.number().int().min(0).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    owner: userRefSchema.optional(),
  }),
  /** Moves the contact's most recent open opportunity in the pipeline. */
  z.strictObject({
    ...stepBase,
    type: z.literal('move_opportunity_stage'),
    pipeline_id: idSchema,
    stage_id: idSchema,
    if_missing: z.enum(['skip', 'create']).optional(),
  }),
  /** Delegated to the e-commerce module (`orders.create`). */
  z.strictObject({
    ...stepBase,
    type: z.literal('create_order'),
    items: z
      .array(
        z.strictObject({
          product_id: idSchema,
          quantity: z.number().int().min(1).max(10_000),
          unit_price_minor: z.number().int().min(0).optional(),
        }),
      )
      .min(1)
      .max(50),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  }),
  /** Delegated to the e-commerce module (`subscriptions.cancelForContact`). */
  z.strictObject({
    ...stepBase,
    type: z.literal('cancel_subscription'),
    product_ids: idList.optional(),
    at_period_end: z.boolean().optional(),
  }),
  /**
   * Outbound HTTP through the SSRF-safe client; signed with the automation
   * secret (`Amable-Signature`) unless `sign` is false.
   */
  z.strictObject({
    ...stepBase,
    type: z.literal('http_request'),
    method: z.enum(HTTP_METHODS),
    url: z.url().max(2048),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(1000)).optional(),
    /** `contact` (default for non-GET): JSON with the contact; `minimal`: ids only; `none`. */
    payload: z.enum(['contact', 'minimal', 'none']).optional(),
    sign: z.boolean().optional(),
    timeout_ms: z.number().int().min(500).max(30_000).optional(),
  }),
  z.strictObject({
    ...stepBase,
    type: z.literal('add_to_sequence'),
    automation_id: idSchema,
    node_id: nodeIdSchema,
  }),
  /** Without `node_id` removes the contact from the whole automation. */
  z.strictObject({
    ...stepBase,
    type: z.literal('remove_from_sequence'),
    automation_id: idSchema,
    node_id: nodeIdSchema.optional(),
  }),
  /** Ends the automation for the contact (every other position is cancelled). */
  z.strictObject({ ...stepBase, type: z.literal('end') }),
]);
export type Step = z.infer<typeof stepSchema>;
export type StepType = Step['type'];
export type StepOf<T extends StepType> = Extract<Step, { type: T }>;

export const sequenceNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('sequence'),
  position: positionSchema,
  label: labelSchema,
  steps: z.array(stepSchema).max(100),
});
export type SequenceNode = z.infer<typeof sequenceNodeSchema>;

export const decisionBranchSchema = z.strictObject({
  id: nodeIdSchema,
  label: labelSchema,
  filter: filterGroupSchema,
});

export const decisionNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('decision'),
  position: positionSchema,
  label: labelSchema,
  branches: z.array(decisionBranchSchema).min(1).max(10),
});
export type DecisionNode = z.infer<typeof decisionNodeSchema>;

export const noteNodeSchema = z.strictObject({
  id: nodeIdSchema,
  type: z.literal('note'),
  position: positionSchema,
  text: z.string().max(5000),
  color: z.string().max(32).optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
export type NoteNode = z.infer<typeof noteNodeSchema>;

export const graphNodeSchema = z.discriminatedUnion('type', [
  goalNodeSchema,
  sequenceNodeSchema,
  decisionNodeSchema,
  noteNodeSchema,
]);
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const DEFAULT_HANDLE = 'default';

export const graphEdgeSchema = z.strictObject({
  id: nodeIdSchema,
  source: nodeIdSchema,
  target: nodeIdSchema,
  /** Decision branch id or `default`; omitted for other sources. */
  source_handle: nodeIdSchema.optional(),
});
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const automationGraphSchema = z.strictObject({
  schema_version: z.literal(GRAPH_SCHEMA_VERSION),
  nodes: z.array(graphNodeSchema).max(500),
  edges: z.array(graphEdgeSchema).max(2000),
});
export type AutomationGraph = z.infer<typeof automationGraphSchema>;

export const EMPTY_GRAPH: AutomationGraph = { schema_version: 1, nodes: [], edges: [] };

/** Automation-level settings (copied into every published version). */
export const automationSettingsSchema = z.strictObject({
  /** `once` (default): a contact enters at most once; `multiple`: again after leaving. */
  reentry: z.enum(['once', 'multiple']).optional(),
  /** Default send window of every email step without its own window. */
  send_window: sendWindowSchema.optional(),
  /** Overrides the tenant time zone as the fallback for contacts without one. */
  time_zone: timeZoneRefSchema.optional(),
});
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;
