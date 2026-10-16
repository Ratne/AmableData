import {
  EmailProviderError,
  type DomainVerification,
  type EmailMarketingProvider,
  type MarketingEmail,
  type ProviderTenant,
  type SendEmailResult,
} from './email-marketing';

/**
 * In-memory EmailMarketingProvider for tests: records every accepted email and
 * can be scripted to fail (`failNext`) to exercise retries.
 */
export class FakeEmailMarketingProvider implements EmailMarketingProvider {
  readonly sent: MarketingEmail[] = [];
  readonly suspended = new Set<string>();
  readonly domains = new Map<string, DomainVerification>();
  private readonly failures: EmailProviderError[] = [];
  private counter = 0;

  /** The next `times` sends throw `error` (default: retryable 503). */
  failNext(times = 1, error = new EmailProviderError('unavailable', true, 503)): void {
    for (let i = 0; i < times; i += 1) this.failures.push(error);
  }

  sendEmail(email: MarketingEmail): Promise<SendEmailResult> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.counter += 1;
    this.sent.push(email);
    return Promise.resolve({ messageId: `fake-${String(this.counter)}`, accepted: true });
  }

  createTenant(name: string): Promise<ProviderTenant> {
    return Promise.resolve({ providerTenantId: `fake-tenant-${name}`, name });
  }

  suspendTenant(providerTenantId: string): Promise<void> {
    this.suspended.add(providerTenantId);
    return Promise.resolve();
  }

  resumeTenant(providerTenantId: string): Promise<void> {
    this.suspended.delete(providerTenantId);
    return Promise.resolve();
  }

  addDomain(_providerTenantId: string, domain: string): Promise<DomainVerification> {
    const verification: DomainVerification = {
      domain,
      status: 'pending',
      records: [{ type: 'TXT', name: domain, value: 'v=spf1 include:fake ~all' }],
    };
    this.domains.set(domain, verification);
    return Promise.resolve(verification);
  }

  verifyDomain(domain: string): Promise<DomainVerification> {
    return Promise.resolve(this.domains.get(domain) ?? { domain, status: 'pending', records: [] });
  }
}
