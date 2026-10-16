import {
  EmailProviderError,
  type DnsRecord,
  type DomainVerification,
  type DomainVerificationStatus,
  type EmailMarketingProvider,
  type MarketingEmail,
  type ProviderTenant,
  type SendEmailResult,
} from './email-marketing';

export const POSTSHIBA_DEFAULT_BASE_URL = 'https://app.postshiba.com/api/v1';

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PostShibaConfig {
  /** API root; defaults to https://app.postshiba.com/api/v1. */
  readonly baseUrl?: string;
  /** Bearer API key (Wrangler secret `POSTSHIBA_API_KEY`). */
  readonly apiKey: string;
  /** Injected transport — tests pass a fake; nothing in dev or tests reaches the network. */
  readonly fetch?: FetchLike;
  /** Per-request timeout. Default 15 s. */
  readonly timeoutMs?: number;
}

/** Thrown by provider stubs whose real implementation belongs to a later phase. */
export class ProviderNotImplementedError extends Error {
  override readonly name = 'ProviderNotImplementedError';
  constructor(provider: string, method: string, phase: string) {
    super(`${provider}.${method} is a stub — implemented in the "${phase}" phase`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Send errors where the message may already be queued: resending could deliver it twice. */
const NORMALIZED_CODES: Readonly<Record<string, string>> = {
  idempotency_outcome_unknown: 'outcome_unknown',
  inject_timeout_unknown: 'outcome_unknown',
};
/** Nothing was sent and the same request can go again later. */
const RETRYABLE_CODES = new Set([
  'rate_limited',
  'throttled',
  'idempotency_in_progress',
  'idempotency_unavailable',
  'inject_unavailable',
  'cluster_not_ready',
]);
/** Retrying the same request can never succeed. */
const PERMANENT_CODES = new Set([
  'suppressed',
  'domain_unverified',
  'domain_suspended',
  'credential_missing',
  'firewall',
  'sender_blocked',
  'kyc_required',
  'invalid',
  'too_many_recipients',
  'payload_too_large',
  'idempotency_conflict',
]);

const DNS_TYPES = new Set(['TXT', 'CNAME', 'MX']);
const DOMAIN_STATUSES = new Set(['pending', 'verified', 'failed']);

/** Provider limits: at most 32 scalar keys, keys ≤ 64 bytes, values ≤ 256 bytes. */
function uniqueArgs(metadata: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 32)) {
    if (key.length > 64) continue;
    out[key] = value.slice(0, 256);
  }
  return out;
}

function parseDomain(body: unknown, fallbackDomain: string): DomainVerification {
  const data = isRecord(body) && isRecord(body['data']) ? body['data'] : body;
  if (!isRecord(data)) throw new EmailProviderError('unexpected domain response', true);
  const rawStatus = typeof data['status'] === 'string' ? data['status'].toLowerCase() : 'pending';
  const status: DomainVerificationStatus = DOMAIN_STATUSES.has(rawStatus)
    ? (rawStatus as DomainVerificationStatus)
    : 'pending';
  const records: DnsRecord[] = [];
  if (Array.isArray(data['records'])) {
    for (const record of data['records']) {
      if (!isRecord(record)) continue;
      const type = typeof record['type'] === 'string' ? record['type'].toUpperCase() : '';
      if (
        DNS_TYPES.has(type) &&
        typeof record['name'] === 'string' &&
        typeof record['value'] === 'string'
      ) {
        records.push({ type: type as DnsRecord['type'], name: record['name'], value: record['value'] });
      }
    }
  }
  return {
    domain: typeof data['domain'] === 'string' ? data['domain'] : fallbackDomain,
    status,
    records,
  };
}

/**
 * PostShiba-backed EmailMarketingProvider (managed offering).
 *
 * - `POST /emails` with `Authorization: Bearer <key>` sends one message;
 *   `Idempotency-Key` = our mail message id so retries never double-send.
 *   `metadata` travels as `unique_args`, echoed on every delivery webhook.
 * - Tenants and domains are managed per CRM tenant (`/tenants`, `/tenants/{id}/domains`).
 *
 * Sending, error codes and webhooks follow the public API reference; the
 * tenant/domain management paths still need confirming.
 */
export class PostShibaEmailMarketingProvider implements EmailMarketingProvider {
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly config: PostShibaConfig) {
    this.baseUrl = (config.baseUrl ?? POSTSHIBA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.doFetch = config.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    if (this.config.apiKey === '') {
      throw new EmailProviderError('POSTSHIBA_API_KEY is not configured', false);
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new EmailProviderError(
        `network error: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const rawCode = isRecord(parsed) && typeof parsed['error'] === 'string' ? parsed['error'] : null;
      const message =
        isRecord(parsed) && typeof parsed['message'] === 'string'
          ? parsed['message']
          : (rawCode ?? `HTTP ${String(response.status)}`);
      const code = rawCode === null ? null : (NORMALIZED_CODES[rawCode] ?? rawCode);
      const hinted = isRecord(parsed) && typeof parsed['retryable'] === 'boolean' ? parsed['retryable'] : null;
      const retryable =
        code === 'outcome_unknown'
          ? false
          : (hinted ??
            (code !== null && RETRYABLE_CODES.has(code)
              ? true
              : code !== null && PERMANENT_CODES.has(code)
                ? false
                : response.status === 429 || response.status >= 500));
      throw new EmailProviderError(
        message.slice(0, 300),
        retryable,
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        code,
      );
    }
    return parsed;
  }

  async sendEmail(email: MarketingEmail): Promise<SendEmailResult> {
    const body = await this.request(
      'POST',
      '/emails',
      {
        from: email.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        headers: email.headers ?? {},
        ...(email.providerTenantId ? { tenant: email.providerTenantId } : {}),
        unique_args: uniqueArgs(email.metadata ?? {}),
      },
      email.idempotencyKey === undefined ? {} : { 'idempotency-key': email.idempotencyKey },
    );
    const data = isRecord(body) && isRecord(body['data']) ? body['data'] : body;
    const skipped = isRecord(data) && Array.isArray(data['suppressed']) ? data['suppressed'] : [];
    if (skipped.some((address) => typeof address === 'string' && address.toLowerCase() === email.to.toLowerCase())) {
      throw new EmailProviderError('recipient is on the provider suppression list', false, 403, null, 'suppressed');
    }
    const id = isRecord(data) ? (data['message_id'] ?? data['id']) : undefined;
    if (typeof id !== 'string' || id === '') {
      // Accepted without an id: resending could double-deliver; webhooks still match on unique args.
      throw new EmailProviderError('send response without a message id', false, null, null, 'outcome_unknown');
    }
    return { messageId: id, accepted: true };
  }

  async createTenant(name: string): Promise<ProviderTenant> {
    const body = await this.request('POST', '/tenants', { name });
    const data = isRecord(body) && isRecord(body['data']) ? body['data'] : body;
    const id = isRecord(data) ? data['id'] : undefined;
    if (typeof id !== 'string') throw new EmailProviderError('tenant response without id', true);
    return { providerTenantId: id, name };
  }

  async suspendTenant(providerTenantId: string, reason: string): Promise<void> {
    await this.request('POST', `/tenants/${encodeURIComponent(providerTenantId)}/suspend`, {
      reason,
    });
  }

  async resumeTenant(providerTenantId: string): Promise<void> {
    await this.request('POST', `/tenants/${encodeURIComponent(providerTenantId)}/resume`, {});
  }

  async addDomain(providerTenantId: string, domain: string): Promise<DomainVerification> {
    const body = await this.request(
      'POST',
      `/tenants/${encodeURIComponent(providerTenantId)}/domains`,
      { domain },
    );
    return parseDomain(body, domain);
  }

  async verifyDomain(domain: string, providerTenantId?: string): Promise<DomainVerification> {
    if (providerTenantId === undefined) {
      throw new EmailProviderError('verifyDomain needs the provider tenant id', false);
    }
    const body = await this.request(
      'POST',
      `/tenants/${encodeURIComponent(providerTenantId)}/domains/${encodeURIComponent(domain)}/verify`,
      {},
    );
    return parseDomain(body, domain);
  }
}
