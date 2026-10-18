import { PROVIDER_ERROR_KINDS, type ProviderErrorKind } from '@amable/api-types';

export { PROVIDER_ERROR_KINDS, type ProviderErrorKind };

/**
 * Classified failure of an ad platform call. `kind` drives the caller:
 * `retryable` → back off and retry, `permanent` → give up on this job,
 * `auth_expired` → mark the connection and ask the user to reconnect.
 */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly platformCode?: string;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { status?: number; platformCode?: string } = {},
  ) {
    super(message);
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.platformCode !== undefined) this.platformCode = options.platformCode;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Default HTTP status mapping shared by every provider. */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth_expired';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retryable';
  return 'permanent';
}
