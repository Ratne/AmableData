import { normalizeEmailKey, normalizePhoneKey, sha256HexSync } from '@amable/app-edge/analytics';
import type { CrmContext } from './context';

/**
 * Index of the SHA-256 of contacts' emails and phones (the form the tracking
 * sites hold): kept in step with every write of a contact's emails/phones, and
 * by the web registry.
 */

export type IdentityHashKind = 'email' | 'phone';

export function emailHash(email: string): string | null {
  const e = normalizeEmailKey(email);
  return e === null ? null : sha256HexSync(e);
}

export function phoneHash(phone: string): string | null {
  const p = normalizePhoneKey(phone);
  return p === null ? null : sha256HexSync(p);
}

export function recordIdentityHash(
  ctx: CrmContext,
  kind: IdentityHashKind,
  hash: string | null,
  contactId: string,
): void {
  if (hash === null) return;
  ctx.db.run(
    `INSERT INTO crm_identity_hashes (kind, hash, contact_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, hash) DO UPDATE SET contact_id = excluded.contact_id`,
    kind,
    hash,
    contactId,
    ctx.now(),
  );
}

const BACKFILL_KEY = 'identity_hashes_backfill';

/**
 * Indexes the contacts written before the hash index existed, a page at a
 * time (contact id cursor in `tenant_meta`, `done` at the end). Run by the
 * analytics sync until done; later writes index themselves.
 */
export function backfillIdentityHashes(
  ctx: CrmContext,
  input: { limit?: number },
): { indexed: number; done: boolean } {
  const state = ctx.db.all<{ value: string }>(
    `SELECT value FROM tenant_meta WHERE key = ?`,
    BACKFILL_KEY,
  )[0]?.value;
  if (state === 'done') return { indexed: 0, done: true };
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);
  const ids = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_contacts WHERE id > ? ORDER BY id LIMIT ?`,
    state ?? '',
    limit,
  );
  for (const { id } of ids) {
    const emails = ctx.db.all<{ email: string }>(
      `SELECT email FROM crm_contact_emails WHERE contact_id = ?`,
      id,
    );
    const phones = ctx.db.all<{ number: string }>(
      `SELECT number FROM crm_contact_phones WHERE contact_id = ?`,
      id,
    );
    const hashes = [
      ...emails.map((e) => ['email', emailHash(e.email)] as const),
      ...phones.map((p) => ['phone', phoneHash(p.number)] as const),
    ];
    // A mapping already written by a live contact write is newer: kept.
    for (const [kind, hash] of hashes) {
      if (hash === null) continue;
      ctx.db.run(
        `INSERT INTO crm_identity_hashes (kind, hash, contact_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, hash) DO NOTHING`,
        kind,
        hash,
        id,
        ctx.now(),
      );
    }
  }
  const done = ids.length < limit;
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    BACKFILL_KEY,
    done ? 'done' : (ids[ids.length - 1]?.id ?? ''),
  );
  return { indexed: ids.length, done };
}

/** Replaces the contact's hashes of one kind with those of its current values. */
export function indexContactHashes(
  ctx: CrmContext,
  contactId: string,
  kind: IdentityHashKind,
  values: readonly string[],
): void {
  ctx.db.run(`DELETE FROM crm_identity_hashes WHERE contact_id = ? AND kind = ?`, contactId, kind);
  for (const v of values)
    recordIdentityHash(ctx, kind, kind === 'email' ? emailHash(v) : phoneHash(v), contactId);
}
