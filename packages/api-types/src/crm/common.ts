import { z } from 'zod';

/** Opaque ULID-style identifier. */
export const idSchema = z.string().min(1).max(64);

/** ISO 8601 timestamp in API responses (always UTC). */
export const timestampSchema = z.string();

/** Calendar date, YYYY-MM-DD. */
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** ISO 8601 date-time with timezone offset or Z. */
export const dateTimeSchema = z.iso.datetime({ offset: true });

export const errorCodeSchema = z.enum([
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'idempotency_conflict',
  'idempotency_in_progress',
  'payload_too_large',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Error body of every non-2xx response — same flat shape as the access layer
 * (`{ error: '<code>' }`), extended with a human message and field details.
 * Codes from the access layer (unauthenticated, forbidden, tenant_not_found, …)
 * share this envelope.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** Cursor pagination query parameters shared by every list endpoint. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** Wraps an item schema into the standard paginated list envelope. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export const idParamSchema = z.object({ id: idSchema });

export const deletedResponseSchema = z.object({ id: idSchema, deleted: z.literal(true) });

/** Free-form rich text document (Tiptap JSON). Size is bounded server-side. */
export const richTextSchema = z.looseObject({
  type: z.literal('doc'),
  content: z.array(z.unknown()).optional(),
});
export type RichText = z.infer<typeof richTextSchema>;

/** Optional nullable string with a max length (PATCH-friendly). */
export function optText(max = 255) {
  return z.string().trim().max(max).nullable().optional();
}
