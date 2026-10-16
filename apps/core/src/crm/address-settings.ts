import type { CrmContext } from './context';

/**
 * Address autocomplete provider of the tenant, stored as `address_lookup.*` rows of
 * tenant_meta. The Mapbox token arrives already encrypted by the worker (SecretBox):
 * the DO only keeps the ciphertext and a hint to recognize it.
 */
export interface StoredAddressLookup {
  readonly provider: 'default' | 'mapbox';
  readonly mapbox_token_ciphertext: string | null;
  readonly mapbox_token_hint: string | null;
  readonly mapbox_permanent: boolean;
}

export type AddressLookupPatch = Partial<{
  provider: StoredAddressLookup['provider'];
  /** `null` removes the token. */
  mapbox_token_ciphertext: string | null;
  mapbox_token_hint: string | null;
  mapbox_permanent: boolean;
}>;

const PREFIX = 'address_lookup.';

export function getAddressLookup(ctx: CrmContext, _input: Record<string, never> = {}): StoredAddressLookup {
  const rows = ctx.db.all<{ key: string; value: string }>(
    `SELECT key, value FROM tenant_meta WHERE key >= ? AND key < ?`,
    PREFIX,
    `${PREFIX}\uffff`,
  );
  const stored = new Map(rows.map((r) => [r.key.slice(PREFIX.length), r.value]));
  return {
    provider: stored.get('provider') === 'mapbox' ? 'mapbox' : 'default',
    mapbox_token_ciphertext: stored.get('mapbox_token_ciphertext') ?? null,
    mapbox_token_hint: stored.get('mapbox_token_hint') ?? null,
    mapbox_permanent: stored.get('mapbox_permanent') === 'true',
  };
}

export function updateAddressLookup(ctx: CrmContext, input: AddressLookupPatch): StoredAddressLookup {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null) {
      ctx.db.run(`DELETE FROM tenant_meta WHERE key = ?`, `${PREFIX}${key}`);
      continue;
    }
    ctx.db.run(
      `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `${PREFIX}${key}`,
      String(value),
    );
  }
  return getAddressLookup(ctx);
}
