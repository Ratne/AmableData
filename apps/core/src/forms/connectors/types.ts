import type { ConnectorType, DeliveryStatus } from '@amable/api-types';
import type { FormField, SubmissionMeta, SubmissionValues } from '@amable/forms';
import type { Env } from '../../env';
import type { FormsRuntime } from '../runtime';

/** What a connector knows about the submission it delivers. */
export interface ConnectorSubmission {
  readonly id: string;
  /** ISO 8601. */
  readonly submittedAt: string;
  readonly contactId: string | null;
  readonly values: SubmissionValues;
  readonly tracking: Readonly<Record<string, string>>;
  readonly meta: SubmissionMeta;
}

export interface ConnectorContext<C> {
  readonly env: Env;
  readonly tenantId: string;
  readonly form: { readonly id: string; readonly name: string; readonly fields: readonly FormField[] };
  readonly submission: ConnectorSubmission;
  readonly connection: { readonly id: string; readonly name: string; readonly config: C; readonly secret: string | null };
  /** 1 for the first try; connectors without idempotency keys use it to detect a previous success. */
  readonly attempt: number;
  readonly runtime: FormsRuntime;
  /** Link to the submission in the app, when the app origin is known. */
  readonly submissionUrl: string | null;
  /** True for "test connection" runs with sample data. */
  readonly test: boolean;
}

export interface ConnectorResult {
  readonly status: Extract<DeliveryStatus, 'success' | 'failed' | 'skipped'>;
  /** Failed but worth retrying (network error, 5xx, 429). */
  readonly retryable: boolean;
  readonly statusCode: number | null;
  /** Short description of the request, never containing secrets. */
  readonly request: string | null;
  readonly response: string | null;
}

/**
 * A destination for submissions. New connectors implement this interface and
 * register in `registry.ts`; the API, processing and UI catalog pick them up.
 */
export interface Connector<C> {
  readonly type: ConnectorType;
  /** `generated`: we create a signing secret (shown once); `api_key`: provided by the user. */
  readonly secret: 'none' | 'generated' | 'api_key';
  readonly oauthProvider: 'google' | null;
  available(runtime: FormsRuntime): boolean;
  /** Validates a stored or submitted config; throws a ZodError-like `issues` list via `safeParse`. */
  parseConfig(raw: unknown): { success: true; data: C } | { success: false; issues: Array<{ path: string; message: string }> };
  run(ctx: ConnectorContext<C>): Promise<ConnectorResult>;
}

export function transient(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function httpResult(status: number, request: string, response: string): ConnectorResult {
  const ok = status >= 200 && status < 400;
  return {
    status: ok ? 'success' : 'failed',
    retryable: !ok && transient(status),
    statusCode: status,
    request,
    response: response.slice(0, 1000),
  };
}

export function failure(message: string, retryable: boolean, request: string | null = null): ConnectorResult {
  return { status: 'failed', retryable, statusCode: null, request, response: message.slice(0, 1000) };
}
