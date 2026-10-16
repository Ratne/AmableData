import type { ErrorCode } from '@amable/api-types';

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Serializable error shape crossing the DO RPC boundary. */
export interface CrmErrorShape {
  code: ErrorCode;
  status: number;
  message: string;
  details?: ErrorDetail[];
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 422,
  idempotency_in_progress: 409,
  payload_too_large: 413,
  internal_error: 500,
};

/** Expected domain error: becomes a 4xx with the standard error body. */
export class CrmError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'CrmError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toShape(): CrmErrorShape {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function notFound(entity: string, id: string): CrmError {
  return new CrmError('not_found', `${entity} ${id} not found`);
}

export function invalid(path: string, message: string): CrmError {
  return new CrmError('validation_failed', message, [{ path, message }]);
}

export function invalidMany(details: ErrorDetail[]): CrmError {
  return new CrmError('validation_failed', details[0]?.message ?? 'validation failed', details);
}
