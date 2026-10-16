import {
  CONTACT_TOKEN_PARAM,
  signContactToken,
  verifyEmailToken,
  type EmailSendSource,
} from '@amable/core';
import { normalizeEmail, parseJson, type MailDeps } from './context';
import { emitEmailEvent } from './outbox';
import { getMessageRow, suppress } from './suppressions';

/**
 * Recipient-side events arriving through the edge worker: link clicks, opens
 * and unsubscribes. Tokens are verified here (the edge only forwards them).
 */

function sourceOf(raw: string | null): EmailSendSource | null {
  return raw === null ? null : parseJson<EmailSendSource | null>(raw, null);
}

/** Appends the signed contact identity (`_amb_c`) to the destination URL. */
export async function withContactToken(
  url: string,
  secret: string,
  tenantId: string,
  contactId: string,
  nowMs: number,
): Promise<string> {
  try {
    const target = new URL(url);
    target.searchParams.set(CONTACT_TOKEN_PARAM, await signContactToken(secret, tenantId, contactId, nowMs));
    return target.toString();
  } catch {
    return url;
  }
}

export async function recordClick(
  deps: MailDeps,
  input: { token: string },
): Promise<{ url: string } | null> {
  const payload = await verifyEmailToken(deps.tokenSecrets, input.token, 'click');
  if (payload === null || payload.t !== deps.tenantId) return null;
  const secret = deps.tokenSecrets[0] ?? '';
  const url = await withContactToken(payload.u, secret, deps.tenantId, payload.c, deps.now());
  const row = getMessageRow(deps, payload.m);
  if (row === undefined) return { url };
  const now = deps.now();
  const unique = row.clicked_at === null;
  // A click proves the open even when images are blocked.
  const impliedOpen = row.opened_at === null;
  const source = sourceOf(row.source);
  deps.db.transaction(() => {
    if (impliedOpen) {
      emitEmailEvent(deps, 'email.opened', { messageId: row.id, contactId: row.contact_id, source, unique: true });
    }
    deps.db.run(
      `INSERT INTO mail_clicks (id, message_id, position, url, broadcast_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      deps.newId(),
      row.id,
      payload.l,
      payload.u,
      row.broadcast_id,
      now,
    );
    deps.db.run(
      `UPDATE mail_messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?),
              opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?`,
      now,
      now,
      now,
      row.id,
    );
    emitEmailEvent(deps, 'email.link_clicked', {
      messageId: row.id,
      contactId: row.contact_id,
      source,
      url: payload.u,
      linkIndex: payload.l,
      unique,
    });
  });
  return { url };
}

export async function recordOpen(deps: MailDeps, input: { token: string }): Promise<{ ok: boolean }> {
  const payload = await verifyEmailToken(deps.tokenSecrets, input.token, 'open');
  if (payload === null || payload.t !== deps.tenantId) return { ok: false };
  const row = getMessageRow(deps, payload.m);
  if (row === undefined) return { ok: false };
  const now = deps.now();
  const unique = row.opened_at === null;
  const source = sourceOf(row.source);
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE mail_messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?`,
      now,
      now,
      row.id,
    );
    emitEmailEvent(deps, 'email.opened', { messageId: row.id, contactId: row.contact_id, source, unique });
  });
  return { ok: true };
}

export interface UnsubscribeInfo {
  readonly valid: boolean;
  readonly email: string | null;
  readonly alreadyUnsubscribed: boolean;
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
}

export async function unsubscribeInfo(deps: MailDeps, input: { token: string }): Promise<UnsubscribeInfo> {
  const payload = await verifyEmailToken(deps.tokenSecrets, input.token, 'unsubscribe');
  if (payload === null || payload.t !== deps.tenantId) {
    return { valid: false, email: null, alreadyUnsubscribed: false };
  }
  const already =
    deps.db.all(`SELECT 1 AS x FROM mail_suppressions WHERE email = ?`, normalizeEmail(payload.e))
      .length > 0;
  return { valid: true, email: maskEmail(payload.e), alreadyUnsubscribed: already };
}

/** Idempotent: suppression + contact marked unsubscribed + `email.unsubscribed` (first time only). */
export async function unsubscribe(
  deps: MailDeps,
  input: { token: string; via: 'link' | 'one_click' },
): Promise<{ ok: boolean }> {
  const payload = await verifyEmailToken(deps.tokenSecrets, input.token, 'unsubscribe');
  if (payload === null || payload.t !== deps.tenantId) return { ok: false };
  const email = normalizeEmail(payload.e);
  const already = deps.db.all(`SELECT 1 AS x FROM mail_suppressions WHERE email = ?`, email).length > 0;
  const row = payload.m === null ? undefined : getMessageRow(deps, payload.m);
  const now = deps.now();
  deps.db.transaction(() => {
    suppress(deps, { email, reason: 'unsubscribe', source: input.via, contactId: payload.c });
    if (row !== undefined) {
      deps.db.run(
        `UPDATE mail_messages SET unsubscribed_at = COALESCE(unsubscribed_at, ?), updated_at = ? WHERE id = ?`,
        now,
        now,
        row.id,
      );
    }
    if (!already) {
      emitEmailEvent(deps, 'email.unsubscribed', {
        messageId: row?.id ?? '',
        contactId: payload.c,
        source: row === undefined ? null : sourceOf(row.source),
        email,
        via: input.via,
      });
    }
  });
  if (!already) {
    try {
      await deps.crm.setMarketableStatus(payload.c, 'unsubscribed');
    } catch (error) {
      console.warn(`[email] marketable status update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true };
}
