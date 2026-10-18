import type { Migration } from '../types';

/**
 * Address autocomplete through Mapbox moved to an installable app: the tenant
 * settings (provider choice and the encrypted Mapbox token) are dropped.
 */
export const t0014DropMapboxSettings: Migration = {
  id: 14,
  name: 'drop_mapbox_settings',
  statements: [`DELETE FROM tenant_meta WHERE key LIKE 'address_lookup.%'`],
};
