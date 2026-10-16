const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfFailure = 'missing_origin' | 'bad_origin' | 'missing_header';

/**
 * CSRF defence for cookie-authenticated requests (in addition to SameSite=Lax):
 * 1. the `Origin` header must be one of the installation's own origins;
 * 2. a custom header must be present — cross-site forms cannot set it and
 *    cross-origin fetches would need a CORS preflight we never grant.
 * Bearer-token (API key) requests carry no ambient credentials and skip this.
 */
export function checkCsrf(input: {
  method: string;
  origin: string | null;
  customHeader: string | null;
  allowedOrigins: readonly string[];
}): CsrfFailure | null {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return null;
  if (input.origin === null || input.origin === '' || input.origin === 'null') {
    return 'missing_origin';
  }
  if (!input.allowedOrigins.includes(input.origin)) return 'bad_origin';
  if (input.customHeader === null || input.customHeader === '') return 'missing_header';
  return null;
}
