import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Domain error of the apps module; routes turn it into `{ error, message, details? }`. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
