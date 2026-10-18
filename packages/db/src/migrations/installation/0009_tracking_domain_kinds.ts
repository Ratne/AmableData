import type { Migration } from '../types';

/**
 * Tracking domains served as zones of the same Cloudflare account (`kind =
 * 'zone'`): no custom hostname at the provider, the domain is verified by
 * probing the edge worker. Existing rows are custom hostnames (`cname`).
 */
export const m0009TrackingDomainKinds: Migration = {
  id: 9,
  name: 'tracking_domain_kinds',
  statements: [`ALTER TABLE tracking_domains ADD COLUMN kind TEXT NOT NULL DEFAULT 'cname'`],
};
