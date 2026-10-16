import type { NotifyRequest } from '../platform/contract';
import type { SystemEmail, SystemEmailProvider } from './system-email';

export type NotifyFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotifyServiceConfig {
  /** Control plane notify endpoint, e.g. `https://app.amabledata.com/v1/installation/notify`. */
  readonly endpoint: string;
  /** License key the installation authenticates with. */
  readonly licenseKey: string;
  /** Injected transport (tests); defaults to the global `fetch`. */
  readonly fetch?: NotifyFetch;
  /** Request timeout, ms (default 10 s). */
  readonly timeoutMs?: number;
}

export type NotifyErrorCode =
  | 'not_configured'
  | 'unreachable'
  | 'invalid_license'
  | 'services_suspended'
  | 'rate_limited'
  | 'rejected'
  | 'server_error';

/** Typed failure of the notify transport; `retryable` tells queue-based callers whether to retry. */
export class NotifyError extends Error {
  override readonly name = 'NotifyError';
  constructor(
    readonly code: NotifyErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.code === 'unreachable' || this.code === 'rate_limited' || this.code === 'server_error';
  }
}

function errorFor(status: number, code: string | null): NotifyError {
  if (status === 401) return new NotifyError('invalid_license', status, 'notify: the license key was rejected');
  if (status === 402) {
    return new NotifyError('services_suspended', status, 'notify: services are suspended for this account');
  }
  if (status === 429) return new NotifyError('rate_limited', status, 'notify: rate limit exceeded');
  if (status >= 500) return new NotifyError('server_error', status, `notify: control plane error ${String(status)}`);
  return new NotifyError('rejected', status, `notify: rejected (${code ?? String(status)})`);
}

/**
 * SystemEmailProvider of the managed offering: forwards each system email to
 * the control plane's central sender (`POST /v1/installation/notify`, Bearer
 * license key). One attempt, errors surfaced to the caller: OTP codes and magic
 * links must go out now or fail visibly. An open source installation without a
 * license must configure its own provider instead.
 */
export class NotifySystemEmailProvider implements SystemEmailProvider {
  constructor(private readonly config: NotifyServiceConfig) {}

  async send(email: SystemEmail): Promise<void> {
    const { endpoint, licenseKey } = this.config;
    if (licenseKey.trim() === '' || endpoint.trim() === '') {
      throw new NotifyError(
        'not_configured',
        0,
        'System email is not configured: without a LICENSE_KEY the managed notify service is unavailable — configure your own system email provider',
      );
    }
    const body: NotifyRequest = {
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      locale: email.locale,
    };
    const doFetch = this.config.fetch ?? ((input, init) => fetch(input, init));
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${licenseKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new NotifyError(
        'unreachable',
        0,
        `notify: control plane unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (res.ok) return;
    const parsed = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw errorFor(res.status, typeof parsed?.error === 'string' ? parsed.error : null);
  }
}
