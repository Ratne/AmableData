import type {
  DnsRecord,
  DomainVerification,
  EmailMarketingProvider,
  MarketingEmail,
  ProviderTenant,
  SendEmailResult,
} from './email-marketing';
import type { SystemEmail, SystemEmailProvider } from './system-email';

/** Placeholder SPF / DKIM / DMARC records, shaped like the provider's, for local wizards. */
export function devDnsRecords(domain: string): DnsRecord[] {
  return [
    { type: 'TXT', name: domain, value: 'v=spf1 include:spf.mail.example.net ~all' },
    { type: 'CNAME', name: `amb1._domainkey.${domain}`, value: 'amb1.dkim.mail.example.net' },
    { type: 'CNAME', name: `amb2._domainkey.${domain}`, value: 'amb2.dkim.mail.example.net' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none; rua=mailto:dmarc@mail.example.net' },
  ];
}

/**
 * Local development EmailMarketingProvider: logs to the console, never sends.
 */
export class ConsoleEmailMarketingProvider implements EmailMarketingProvider {
  private counter = 0;

  sendEmail(email: MarketingEmail): Promise<SendEmailResult> {
    this.counter += 1;
    console.log(
      `[email-marketing] to=${email.to} from=${email.from} subject="${email.subject}"\n${email.text}`,
    );
    return Promise.resolve({
      messageId: `console-${String(Date.now())}-${String(this.counter)}`,
      accepted: true,
    });
  }

  createTenant(name: string): Promise<ProviderTenant> {
    console.log(`[email-marketing] createTenant name="${name}"`);
    return Promise.resolve({ providerTenantId: `console-tenant-${name}`, name });
  }

  suspendTenant(providerTenantId: string, reason: string): Promise<void> {
    console.log(`[email-marketing] suspendTenant ${providerTenantId} reason="${reason}"`);
    return Promise.resolve();
  }

  resumeTenant(providerTenantId: string): Promise<void> {
    console.log(`[email-marketing] resumeTenant ${providerTenantId}`);
    return Promise.resolve();
  }

  addDomain(_providerTenantId: string, domain: string): Promise<DomainVerification> {
    console.log(`[email-marketing] addDomain domain="${domain}" -> pending (dev)`);
    return Promise.resolve({ domain, status: 'pending', records: devDnsRecords(domain) });
  }

  verifyDomain(domain: string): Promise<DomainVerification> {
    console.log(`[email-marketing] verifyDomain domain="${domain}" -> verified (dev)`);
    return Promise.resolve({ domain, status: 'verified', records: devDnsRecords(domain) });
  }
}

/**
 * Local development SystemEmailProvider: system emails end up in the console,
 * nothing is ever sent (dev-env requirement).
 */
export class ConsoleSystemEmailProvider implements SystemEmailProvider {
  send(email: SystemEmail): Promise<void> {
    console.log(
      `[system-email] to=${email.to} locale=${email.locale} subject="${email.subject}"\n${email.text}`,
    );
    return Promise.resolve();
  }
}
