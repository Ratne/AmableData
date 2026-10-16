/**
 * Provider interface for tenant marketing email infrastructure.
 *
 * Implementations:
 * - PostShiba (managed offering: one PostShiba tenant per CRM tenant) — HTTP
 *   client in postshiba.ts;
 * - console (local dev): logs instead of sending;
 * - fake (tests): records sends in memory and can be told to fail.
 * The open source offering can plug its own PostShiba account or a generic SMTP
 * implementation behind this same interface.
 */

export interface MarketingEmail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string | null;
  /** Mailbox headers such as List-Unsubscribe. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Provider-side tenant that owns the sending domain (managed offering). */
  readonly providerTenantId?: string | null;
  /** Stable key so a retried request is never delivered twice by the provider. */
  readonly idempotencyKey?: string;
  /** Echoed back by delivery webhooks (e.g. tenant id, mail message id). Scalar values only. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SendEmailResult {
  /** Provider-side message id, used to correlate delivery webhooks. */
  readonly messageId: string;
  readonly accepted: boolean;
}

/** A per-CRM-tenant space at the provider (own domains, credentials, suppressions). */
export interface ProviderTenant {
  readonly providerTenantId: string;
  readonly name: string;
}

export type DomainVerificationStatus = 'pending' | 'verified' | 'failed';

export interface DnsRecord {
  readonly type: 'TXT' | 'CNAME' | 'MX';
  readonly name: string;
  readonly value: string;
}

export interface DomainVerification {
  readonly domain: string;
  readonly status: DomainVerificationStatus;
  /** SPF / DKIM / DMARC records the customer must create on their zone. */
  readonly records: readonly DnsRecord[];
}

/**
 * Error raised by providers. `retryable` tells the queue consumer whether the
 * same request may succeed later (rate limit, 5xx, network) or never will
 * (invalid recipient, rejected content, auth).
 */
export class EmailProviderError extends Error {
  override readonly name = 'EmailProviderError';
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
    /** Seconds suggested by the provider (Retry-After), if any. */
    readonly retryAfterSeconds: number | null = null,
    /**
     * Provider error code. Normalized codes the pipeline acts on:
     * `suppressed` (the recipient is on the provider suppression list) and
     * `outcome_unknown` (the message may have been queued: never resend).
     */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export interface EmailMarketingProvider {
  /** Hands one marketing email to the provider for delivery. */
  sendEmail(email: MarketingEmail): Promise<SendEmailResult>;
  /** Create the provider-side tenant that backs a CRM tenant. */
  createTenant(name: string): Promise<ProviderTenant>;
  /** Suspend / resume all sending of a provider-side tenant (anti-abuse). */
  suspendTenant(providerTenantId: string, reason: string): Promise<void>;
  resumeTenant(providerTenantId: string): Promise<void>;
  /** Register a sending domain on the provider tenant; returns the DNS records to create. */
  addDomain(providerTenantId: string, domain: string): Promise<DomainVerification>;
  /** Start / check verification of a sending domain (SPF, DKIM, DMARC). */
  verifyDomain(domain: string, providerTenantId?: string): Promise<DomainVerification>;
}
