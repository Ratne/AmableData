import type { CommerceSettings, UpdateCommerceSettingsInput } from '@amable/api-types';
import type { CrmContext } from '../crm/context';

const DEFAULTS: CommerceSettings = {
  default_currency: 'EUR',
  order_prefix: 'ORD-',
  invoice_prefix: 'INV-',
  payment_terms_days: 14,
  default_tax_rate_bps: 0,
};

const KEY_PREFIX = 'commerce.';

/** Tenant e-commerce settings, stored as `commerce.*` rows of tenant_meta. */
export function getSettings(ctx: CrmContext, _input: Record<string, never> = {}): CommerceSettings {
  const rows = ctx.db.all<{ key: string; value: string }>(
    `SELECT key, value FROM tenant_meta WHERE key LIKE 'commerce.%'`,
  );
  const stored = new Map(rows.map((r) => [r.key.slice(KEY_PREFIX.length), r.value]));
  return {
    default_currency: stored.get('default_currency') ?? DEFAULTS.default_currency,
    order_prefix: stored.get('order_prefix') ?? DEFAULTS.order_prefix,
    invoice_prefix: stored.get('invoice_prefix') ?? DEFAULTS.invoice_prefix,
    payment_terms_days: Number(stored.get('payment_terms_days') ?? DEFAULTS.payment_terms_days),
    default_tax_rate_bps: Number(
      stored.get('default_tax_rate_bps') ?? DEFAULTS.default_tax_rate_bps,
    ),
  };
}

export function updateSettings(
  ctx: CrmContext,
  input: UpdateCommerceSettingsInput,
): CommerceSettings {
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    ctx.db.run(
      `INSERT INTO tenant_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `${KEY_PREFIX}${key}`,
      String(value),
    );
  }
  return getSettings(ctx);
}

/**
 * Next value of a per-tenant sequence. Runs inside the caller's transaction
 * (the DO is single-threaded), so numbers are gapless: a rolled-back mutation
 * also rolls back its counter increment.
 */
export function nextCounter(ctx: CrmContext, name: string): number {
  ctx.db.run(
    `INSERT INTO crm_counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
    name,
  );
  return (
    ctx.db.all<{ value: number }>(`SELECT value FROM crm_counters WHERE name = ?`, name)[0]
      ?.value ?? 1
  );
}
