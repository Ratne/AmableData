import { COMPANY_FIELDS, type CompanyProfile } from '@amable/api-types';
import type { CrmContext } from '../crm/context';

/**
 * Workspace settings kept in the tenant DO as `workspace.*` rows of tenant_meta.
 * Name and slug live in the installation D1 (`tenants`), the timezone in the
 * mail DO and the currency in `commerce.*`: the API stitches them together.
 */
export interface StoredWorkspace {
  /** R2 key of the uploaded logo. */
  readonly logo_key: string | null;
  readonly primary_color: string | null;
  readonly language: 'it' | 'en' | null;
  readonly country_code: string | null;
  readonly company: CompanyProfile;
}

const SCALAR_KEYS = ['logo_key', 'primary_color', 'language', 'country_code'] as const;
type ScalarKey = (typeof SCALAR_KEYS)[number];

/** `null` or `''` removes the value. */
export type WorkspacePatch = Partial<Record<ScalarKey, string | null>> & {
  readonly company?: Partial<Record<keyof CompanyProfile, string | null>>;
};

const PREFIX = 'workspace.';
const COMPANY_PREFIX = 'company.';

export function getWorkspace(ctx: CrmContext, _input: Record<string, never> = {}): StoredWorkspace {
  const rows = ctx.db.all<{ key: string; value: string }>(
    `SELECT key, value FROM tenant_meta WHERE key >= ? AND key < ?`,
    PREFIX,
    `${PREFIX}\uffff`,
  );
  const stored = new Map(rows.map((r) => [r.key.slice(PREFIX.length), r.value]));
  const language = stored.get('language');
  return {
    logo_key: stored.get('logo_key') ?? null,
    primary_color: stored.get('primary_color') ?? null,
    language: language === 'it' || language === 'en' ? language : null,
    country_code: stored.get('country_code') ?? null,
    company: Object.fromEntries(
      COMPANY_FIELDS.map((field) => [field, stored.get(`${COMPANY_PREFIX}${field}`) ?? null]),
    ) as CompanyProfile,
  };
}

export function updateWorkspace(ctx: CrmContext, input: WorkspacePatch): StoredWorkspace {
  const write = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null || value.trim() === '') {
      ctx.db.run(`DELETE FROM tenant_meta WHERE key = ?`, `${PREFIX}${key}`);
      return;
    }
    ctx.db.run(
      `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      `${PREFIX}${key}`,
      value.trim(),
    );
  };
  for (const key of SCALAR_KEYS) write(key, input[key]);
  for (const field of COMPANY_FIELDS) write(`${COMPANY_PREFIX}${field}`, input.company?.[field]);
  return getWorkspace(ctx);
}
