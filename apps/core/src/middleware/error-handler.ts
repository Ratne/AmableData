import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reportApiError } from '../platform/telemetry';
import type { AppEnv } from './context';
import { HttpError, jsonError } from './errors';

/** App-wide error handler: HttpError → its JSON body; anything else → opaque 500. */
export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof HttpError) return jsonError(c, error.status, error.code, error.extra);
  if (error instanceof HTTPException) return error.getResponse();
  // Never echo internals (could contain personal data) — log server-side only.
  console.error('[api] unhandled error', error);
  reportApiError(c, error);
  return jsonError(c, 500, 'internal_error');
};
