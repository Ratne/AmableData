import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Uniform JSON error body: `{ error: '<code>', ...extra }`. */
export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  extra?: Record<string, string | number | boolean | null | readonly string[]>,
) {
  return c.json({ error: code, ...extra }, status);
}

/** Thrown from helpers; the app error handler turns it into a JSON response. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    readonly extra?: Record<string, string | number | boolean | null | readonly string[]>,
  ) {
    super(code);
  }
}
