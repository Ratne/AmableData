import type { Migration } from '../types';

/**
 * Former slugs of renamed workspaces: published forms, booking pages, landing
 * pages, tracking snippets and API integrations keep resolving after a rename.
 * A slug is either a live `tenants.slug` or an alias, never both.
 */
export const m0006TenantSlugAliases: Migration = {
  id: 6,
  name: 'tenant_slug_aliases',
  statements: [
    `CREATE TABLE tenant_slug_aliases (
      slug TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_tenant_slug_aliases_tenant ON tenant_slug_aliases(tenant_id)`,
  ],
};
