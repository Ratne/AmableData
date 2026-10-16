import type { Context } from 'hono';
import type { z } from 'zod';
import { HttpError } from './errors';

/**
 * Parses a JSON body with a strict Zod schema (unknown keys rejected by the
 * schemas themselves via `z.strictObject`). 422 with the failing paths otherwise.
 */
export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(422, 'invalid_json');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(422, 'validation_failed', {
      fields: result.error.issues.map((issue) => issue.path.join('.') || '(root)'),
    });
  }
  return result.data;
}
