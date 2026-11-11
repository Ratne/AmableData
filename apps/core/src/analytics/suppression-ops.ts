import type { CrmContext } from '../crm/context';

/**
 * Workspace list of web tracking suppressions (TenantDb operations). Entries
 * are visitor ids or SHA-256 identity hashes; the site DOs hold the active
 * tombstones, this list seeds the sites created later.
 */

export type SuppressionKind = 'visitor' | 'email' | 'phone';

export interface SuppressionRow {
  kind: SuppressionKind;
  value: string;
  purge: number;
  reason: string | null;
  created_by: string | null;
  created_at: number;
}

function contactHashes(
  ctx: CrmContext,
  input: { contactId: string },
): { email: string[]; phone: string[] } {
  const ids = [
    input.contactId,
    ...ctx.db
      .all<{ id: string }>(`SELECT id FROM crm_contacts WHERE merged_into_id = ?`, input.contactId)
      .map((r) => r.id),
  ];
  const out = { email: [] as string[], phone: [] as string[] };
  for (const r of ctx.db.all<{ kind: 'email' | 'phone'; hash: string }>(
    `SELECT kind, hash FROM crm_identity_hashes WHERE contact_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(ids),
  )) {
    out[r.kind].push(r.hash);
  }
  return out;
}

function recordSuppressions(
  ctx: CrmContext,
  input: {
    entries: ReadonlyArray<{ kind: SuppressionKind; value: string }>;
    purge: boolean;
    reason: string | null;
    createdBy: string | null;
  },
): number {
  let added = 0;
  for (const e of input.entries) {
    const rows = ctx.db.all<{ kind: string }>(
      `INSERT INTO crm_web_suppressions (kind, value, purge, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, value) DO UPDATE SET purge = MAX(purge, excluded.purge) RETURNING kind`,
      e.kind,
      e.value,
      input.purge ? 1 : 0,
      input.reason,
      input.createdBy,
      ctx.now(),
    );
    added += rows.length;
    // Workspace sales keep the transaction, not the pseudonymous visitor; the
    // contact timeline loses the visitor's web history (sessions, pages, goals).
    if (e.kind === 'visitor' && input.purge) {
      ctx.db.run(`UPDATE crm_web_sales SET visitor_id = NULL WHERE visitor_id = ?`, e.value);
      ctx.db.run(
        `DELETE FROM crm_activities WHERE type LIKE 'web.%' AND json_extract(data, '$.visitorId') = ?`,
        e.value,
      );
    }
  }
  return added;
}

function listSuppressions(
  ctx: CrmContext,
  input: { limit?: number; offset?: number },
): SuppressionRow[] {
  return ctx.db.all<SuppressionRow>(
    `SELECT * FROM crm_web_suppressions ORDER BY created_at DESC, kind, value LIMIT ? OFFSET ?`,
    Math.min(Math.max(input.limit ?? 100, 1), 1000),
    Math.max(input.offset ?? 0, 0),
  );
}

export const suppressionCrmOps = {
  'analytics.contactHashes': contactHashes,
  'analytics.recordSuppressions': recordSuppressions,
  'analytics.listSuppressions': listSuppressions,
};
