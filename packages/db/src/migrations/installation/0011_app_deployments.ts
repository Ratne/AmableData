import type { Migration } from '../types';

/**
 * Marketplace apps deployed into the installation's own Cloudflare account
 * (apps/core/src/apps/deployer.ts):
 * - `app_deployments`: one Worker (and its D1 databases) per app, shared by
 *   every workspace of the installation that installs it; `provider` says who
 *   holds the Cloudflare token (`control_plane` on the managed offering,
 *   `direct` on a self-hosted installation);
 * - `app_cloudflare_credentials`: the self-hosted token (encrypted) and the
 *   account the apps are deployed to. The managed offering never stores one
 *   here: the control plane already has the token collected at onboarding.
 */
export const m0011AppDeployments: Migration = {
  id: 11,
  name: 'app_deployments',
  statements: [
    `CREATE TABLE app_deployments (
      app_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      account_id TEXT,
      script_name TEXT NOT NULL,
      origin TEXT,
      databases TEXT NOT NULL DEFAULT '[]',
      bundle_sha256 TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE app_cloudflare_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token TEXT NOT NULL,
      token_hint TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      saved_by TEXT,
      verified_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ],
};
