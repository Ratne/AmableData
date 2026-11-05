import { CHECKOUT_STRINGS, fill, formatMoney, type BankTransferDetails, type CheckoutLocale } from '@amable/checkout';
import type { EmailSendRequest } from '@amable/core';
import { textToDoc } from '../booking/messages';
import type { CrmContext } from '../crm/context';
import { parseJson } from '../crm/util';
import type { StoredBankAccount } from '../commerce/bank-accounts';
import type { SessionRow } from './sessions';

/** Without an answer on the offer page, the summary email goes out this long after the last action. */
export const SUMMARY_IDLE_MS = 15 * 60_000;

/** Coordinates the purchase was placed with (kept on the session: later edits of the account do not change them). */
export interface BankSnapshot {
  tenant_id: string;
  holder: string;
  iban: string;
  bic: string;
  bank_name: string;
  instructions: string;
}

export function bankSnapshot(account: StoredBankAccount, tenantId: string): BankSnapshot {
  return {
    tenant_id: tenantId,
    holder: account.holder,
    iban: account.iban,
    bic: account.bic,
    bank_name: account.bank_name,
    instructions: account.instructions,
  };
}

function snapshotOf(session: Pick<SessionRow, 'bank_details'>): BankSnapshot | null {
  return session.bank_details === null ? null : parseJson<BankSnapshot | null>(session.bank_details, null);
}

function localeOf(session: Pick<SessionRow, 'locale'>): CheckoutLocale {
  return session.locale === 'it' ? 'it' : 'en';
}

/** IBAN in groups of four, as printed by banks. */
function groupIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** What is left to transfer: the main order and every accepted offer of the purchase. */
export function bankTransferDetails(ctx: CrmContext, session: SessionRow): BankTransferDetails | null {
  const bank = snapshotOf(session);
  if (session.payment_method !== 'bank_transfer' || bank === null) return null;
  const orders = ctx.db.all<{ number: string; balance: number }>(
    `SELECT number, total_minor - paid_minor AS balance FROM crm_orders
     WHERE checkout_session_id = ? AND payment_method = 'bank_transfer' AND deleted_at IS NULL
       AND status IN ('unpaid', 'partially_paid')
     ORDER BY parent_order_id IS NOT NULL, created_at, id`,
    session.id,
  );
  return {
    holder: bank.holder,
    iban: groupIban(bank.iban),
    bic: bank.bic,
    bank_name: bank.bank_name,
    instructions: bank.instructions,
    reference: orders.map((o) => o.number).join(', '),
    currency: session.currency,
    orders: orders.map((o) => ({ number: o.number, total_minor: o.balance })),
    total_minor: orders.reduce((sum, o) => sum + o.balance, 0),
  };
}

/**
 * When the single summary email of the purchase goes out: now (offer chain
 * over, page closed) or after `SUMMARY_IDLE_MS` without answers. An offer
 * accepted after it was sent re-arms it: one corrected summary follows.
 */
export function scheduleSummary(ctx: CrmContext, sessionId: string, when: 'now' | 'idle', resend: boolean): void {
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET summary_email_due_at = ?, summary_email_sent_at = CASE WHEN ? THEN NULL ELSE summary_email_sent_at END
     WHERE id = ? AND payment_method = 'bank_transfer' AND (summary_email_sent_at IS NULL OR ?)`,
    when === 'now' ? now : now + SUMMARY_IDLE_MS,
    resend ? 1 : 0,
    sessionId,
    resend ? 1 : 0,
  );
}

function summaryEmail(session: SessionRow, details: BankTransferDetails, tenantId: string, now: number): EmailSendRequest | null {
  if (session.contact_id === null || details.orders.length === 0) return null;
  const locale = localeOf(session);
  const s = CHECKOUT_STRINGS[locale];
  const money = (minor: number): string => formatMoney(minor, details.currency, locale);
  const coordinates = [
    `${s.bankHolder}: ${details.holder}`,
    `${s.bankIban}: ${details.iban}`,
    ...(details.bic === '' ? [] : [`${s.bankBic}: ${details.bic}`]),
    ...(details.bank_name === '' ? [] : [`${s.bankName}: ${details.bank_name}`]),
    `${s.bankAmount}: ${money(details.total_minor)}`,
    `${s.bankReference}: ${details.reference}`,
  ].join('\n');
  const orders = [`${s.summaryOrders}:`, ...details.orders.map((o) => `${o.number} — ${money(o.total_minor)}`)].join('\n');
  const body = [s.summaryIntro, coordinates, orders, details.instructions, s.summaryOutro].filter((p) => p !== '').join('\n\n');
  return {
    kind: 'email.send',
    version: 1,
    id: `checkout-summary-${session.id}-${String(now)}`,
    tenantId,
    contactId: session.contact_id,
    content: {
      templateId: null,
      subject: fill(s.summarySubject, { reference: details.reference }),
      preheader: null,
      body: textToDoc(body),
      fromName: null,
      replyTo: null,
    },
    source: { type: 'transactional', purpose: 'checkout', referenceId: session.id, userId: null },
    requestedAt: new Date(now).toISOString(),
    notAfter: null,
  };
}

/** Claims the summary email of a due session (once per arming); null: nothing left to transfer. */
function claim(ctx: CrmContext, session: SessionRow): EmailSendRequest | null {
  const now = ctx.now();
  const bank = snapshotOf(session);
  ctx.db.run(
    `UPDATE crm_checkout_sessions SET summary_email_due_at = NULL, summary_email_sent_at = ? WHERE id = ?`,
    now,
    session.id,
  );
  const details = bankTransferDetails(ctx, session);
  return bank === null || details === null ? null : summaryEmail(session, details, bank.tenant_id, now);
}

/**
 * Summary emails due, sent by the TenantDb alarm (the checkout ops re-arm
 * it, so one due "now" leaves right after the op).
 */
export function dueSummaries(ctx: CrmContext, input: { limit?: number } = {}): { emails: EmailSendRequest[] } {
  const sessions = ctx.db.all<SessionRow>(
    `SELECT * FROM crm_checkout_sessions WHERE summary_email_due_at IS NOT NULL AND summary_email_due_at <= ?
     ORDER BY summary_email_due_at LIMIT ?`,
    ctx.now(),
    input.limit ?? 50,
  );
  const emails: EmailSendRequest[] = [];
  for (const session of sessions) {
    const email = claim(ctx, session);
    if (email !== null) emails.push(email);
  }
  return { emails };
}

/** The buyer closed the offer page: the summary goes out now instead of after the idle time. */
export function flushSummary(ctx: CrmContext, input: { tokenHash: string }): { sent: boolean } {
  const pending = ctx.db.all<{ id: string }>(
    `SELECT id FROM crm_checkout_sessions WHERE token_hash = ? AND summary_email_due_at IS NOT NULL`,
    input.tokenHash,
  )[0];
  if (pending === undefined) return { sent: false };
  ctx.db.run(`UPDATE crm_checkout_sessions SET summary_email_due_at = ? WHERE id = ?`, ctx.now(), pending.id);
  return { sent: true };
}

/** The send failed: try again later. */
export function summaryFailed(ctx: CrmContext, input: { sessionIds: string[] }): { ok: true } {
  for (const id of input.sessionIds) {
    ctx.db.run(
      `UPDATE crm_checkout_sessions SET summary_email_due_at = ?, summary_email_sent_at = NULL WHERE id = ?`,
      ctx.now() + 60_000,
      id,
    );
  }
  return { ok: true };
}

export function nextSummaryDue(db: CrmContext['db']): number | null {
  return (
    db.all<{ due: number | null }>(
      `SELECT MIN(summary_email_due_at) AS due FROM crm_checkout_sessions WHERE summary_email_due_at IS NOT NULL`,
    )[0]?.due ?? null
  );
}
