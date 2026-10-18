import type { Migration } from '../types';

/**
 * Custom tracking hostnames of analytics sites (custom hostnames of the
 * platform zone). Global: the edge resolves `hostname` → (tenant, site) here,
 * and a hostname belongs to one site of one tenant across the installation.
 */
export const m0008TrackingDomains: Migration = {
  id: 8,
  name: 'tracking_domains',
  statements: [
    `CREATE TABLE tracking_domains (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      site_id TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending_dns',
      provider_id TEXT,
      cname_target TEXT NOT NULL,
      txt_name TEXT,
      txt_value TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      checked_at INTEGER,
      activated_at INTEGER
    )`,
    `CREATE INDEX idx_tracking_domains_tenant_site ON tracking_domains(tenant_id, site_id)`,
  ],
};
