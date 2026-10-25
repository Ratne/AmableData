import { z } from 'zod';
import { idSchema } from '../crm/common';
import { activitySchema } from '../crm/contacts';
import { formSubmissionSchema } from '../forms/index';

/**
 * Event archive: rows older than the retention window live in the workspace's
 * R2 bucket as monthly compressed files and stay readable through these
 * endpoints (timeline, form submissions, broadcast messages).
 */

export const archiveMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'yyyy-mm');

export const archivedTimelineQuerySchema = z.object({
  /** Only months before this one (`next_before` of the previous page). */
  before: archiveMonthSchema.optional(),
});
export type ArchivedTimelineQuery = z.infer<typeof archivedTimelineQuerySchema>;

export const archivedTimelineSchema = z.object({
  data: z.array(activitySchema),
  /** Pass as `before` to read older months; null when none are left. */
  next_before: archiveMonthSchema.nullable(),
});
export type ArchivedTimeline = z.infer<typeof archivedTimelineSchema>;

export const archivedMonthsSchema = z.object({
  data: z.array(z.object({ month: archiveMonthSchema, rows: z.number().int().nonnegative() })),
});
export type ArchivedMonths = z.infer<typeof archivedMonthsSchema>;

export const archivedSubmissionsParamSchema = z.object({
  formId: idSchema,
  month: archiveMonthSchema,
});

export const archivedSubmissionsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const archivedSubmissionsSchema = z.object({
  data: z.array(formSubmissionSchema),
  /** Offset of the next page within the month; null at the end. */
  next_offset: z.number().int().nullable(),
});
export type ArchivedSubmissions = z.infer<typeof archivedSubmissionsSchema>;

export const ARCHIVE_RETENTION_FAMILIES = ['crm_events', 'email', 'clicks', 'submissions', 'esign'] as const;
export type ArchiveRetentionFamily = (typeof ARCHIVE_RETENTION_FAMILIES)[number];

/** Months kept in the live database per family; 0 = keep forever (never archived). */
const retentionMonths = z.union([z.literal(0), z.number().int().min(3).max(120)]);

export const archiveRetentionSchema = z.object({
  crm_events: retentionMonths,
  email: retentionMonths,
  clicks: retentionMonths,
  submissions: retentionMonths,
  esign: retentionMonths,
});
export type ArchiveRetention = z.infer<typeof archiveRetentionSchema>;

export const updateArchiveRetentionSchema = archiveRetentionSchema.partial().strict();
export type UpdateArchiveRetentionInput = z.infer<typeof updateArchiveRetentionSchema>;

export const archiveStreamSummarySchema = z.object({
  stream: z.enum(['crm_activities', 'form_submissions', 'esign_events', 'mail_messages', 'mail_clicks']),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  oldest: archiveMonthSchema.nullable(),
  newest: archiveMonthSchema.nullable(),
});

export const archiveSettingsSchema = z.object({
  retention: archiveRetentionSchema,
  streams: z.array(archiveStreamSummarySchema),
});
export type ArchiveSettings = z.infer<typeof archiveSettingsSchema>;
