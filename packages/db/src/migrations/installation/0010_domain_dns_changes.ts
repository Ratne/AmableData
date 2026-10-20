import type { Migration } from '../types';

/**
 * Sending domains whose DNS records changed at the email provider (managed
 * email moved to another cluster): set when the control plane reports the
 * change, cleared once the domain verifies with the new records.
 */
export const m0010DomainDnsChanges: Migration = {
  id: 10,
  name: 'domain_dns_changes',
  statements: [`ALTER TABLE domains ADD COLUMN dns_changed_at INTEGER`],
};
