import type { Migration } from '../types';
import { m0001Init } from './0001_init';
import { m0002Indexes } from './0002_indexes';
import { m0003Auth } from './0003_auth';
import { m0004Platform } from './0004_platform';
import { m0005Developers } from './0005_developers';
import { m0006TenantSlugAliases } from './0006_tenant_slug_aliases';
import { m0007Apps } from './0007_apps';
import { m0008TrackingDomains } from './0008_tracking_domains';

/**
 * Ordered list of installation D1 migrations.
 * Append new migrations here — never edit an already shipped one.
 */
export const installationMigrations: readonly Migration[] = [
  m0001Init,
  m0002Indexes,
  m0003Auth,
  m0004Platform,
  m0005Developers,
  m0006TenantSlugAliases,
  m0007Apps,
  m0008TrackingDomains,
];
