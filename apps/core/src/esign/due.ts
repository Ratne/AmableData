import type { EsignEvent } from '@amable/api-types';
import type { EsignLocale } from '@amable/esign';
import type { CrmContext } from '../crm/context';
import type { SqlDb } from '../crm/db/sql';
import { emit } from '../crm/events';
import {
  eventsOf,
  isActive,
  recordEvent,
  settingsOf,
  signersOf,
  tenantFacts,
  type RequestRow,
  type SignerRow,
  type TenantFacts,
} from './model';
import { DAY_MS, ensureSignerContact, getRequestRow } from './requests';
import { expireIfDue } from './signing';

/** Emails the alarm sends: the worker derives the link from the nonce and builds the message. */
export interface EsignMail {
  kind: 'invite' | 'reminder' | 'completed';
  signerId: string;
  requestId: string;
  contactId: string;
  email: string;
  name: string;
  partyName: string;
  tokenNonce: string;
  tokenHash: string | null;
  requestName: string;
  message: string;
  subject: string;
  locale: EsignLocale;
  expiresAt: number | null;
  /** The signer's contact time zone (dates in emails); null: the workspace's. */
  timeZone: string | null;
  /** First name for the greeting, as `{{ contact.first_name }}` reads it; null when the contact has none. */
  firstName: string | null;
}

const BATCH = 50;
const FINALIZE_MAX_ATTEMPTS = 8;
/** A sealing job that neither succeeded nor failed by then is considered lost (worker killed) and handed out again. */
export const FINALIZE_LEASE_MS = 15 * 60_000;

function contactPrefs(
  ctx: CrmContext,
  contactId: string,
): { preferred_locale: string | null; time_zone: string | null; first_name: string | null } {
  return (
    ctx.db.all<{ preferred_locale: string | null; time_zone: string | null; first_name: string | null }>(
      `SELECT preferred_locale, time_zone, COALESCE(preferred_name, given_name) AS first_name FROM crm_contacts WHERE id = ?`,
      contactId,
    )[0] ?? { preferred_locale: null, time_zone: null, first_name: null }
  );
}

/** Language of the page the signer accepted the consent on. */
function signedLocale(ctx: CrmContext, signerId: string): EsignLocale | null {
  const meta = ctx.db.all<{ meta: string | null }>(
    `SELECT meta FROM esign_events WHERE signer_id = ? AND type = 'consent_given' ORDER BY id DESC LIMIT 1`,
    signerId,
  )[0]?.meta;
  if (meta == null) return null;
  const locale = (JSON.parse(meta) as { locale?: unknown }).locale;
  return locale === 'it' || locale === 'en' ? locale : null;
}

export function mailFor(
  ctx: CrmContext,
  kind: EsignMail['kind'],
  request: RequestRow,
  signer: SignerRow,
): EsignMail {
  const settings = settingsOf(request.settings);
  const contactId = ensureSignerContact(ctx, signer);
  const prefs = contactPrefs(ctx, contactId);
  const locale: EsignLocale =
    request.locale === 'en' || request.locale === 'it'
      ? request.locale
      : (signedLocale(ctx, signer.id) ??
        (prefs.preferred_locale?.toLowerCase().startsWith('it') === true ? 'it' : 'en'));
  return {
    kind,
    signerId: signer.id,
    requestId: request.id,
    contactId,
    email: signer.email,
    name: signer.name,
    partyName: signer.party_name,
    tokenNonce: signer.token_nonce,
    tokenHash: signer.token_hash,
    requestName: request.name,
    message: request.message,
    subject: settings.email_subject,
    locale,
    expiresAt: request.expires_at,
    timeZone: prefs.time_zone,
    firstName: prefs.first_name === null || prefs.first_name.trim() === '' ? null : prefs.first_name.trim(),
  };
}

/** Work due now: expires overdue requests, returns invitations / reminders to send and requests to seal. */
export function esignDue(
  ctx: CrmContext,
  _input: Record<string, never> = {},
): { tenant: TenantFacts | null; mails: EsignMail[]; finalize: string[] } {
  const now = ctx.now();
  const overdue = ctx.db.all<RequestRow>(
    `SELECT * FROM esign_requests WHERE status IN ('sent', 'partially_signed') AND expires_at IS NOT NULL AND expires_at <= ? LIMIT ?`,
    now,
    BATCH,
  );
  for (const request of overdue) expireIfDue(ctx, request);

  const due = ctx.db.all<SignerRow & { kind: 'invite' | 'reminder' }>(
    `SELECT s.*, CASE WHEN s.notify_due_at IS NOT NULL AND s.notify_due_at <= ? THEN 'invite' ELSE 'reminder' END AS kind
     FROM esign_signers s JOIN esign_requests r ON r.id = s.request_id
     WHERE r.status IN ('sent', 'partially_signed') AND s.status NOT IN ('completed', 'declined')
       AND ((s.notify_due_at IS NOT NULL AND s.notify_due_at <= ?) OR (s.notify_due_at IS NULL AND s.next_reminder_at IS NOT NULL AND s.next_reminder_at <= ?))
     ORDER BY s.id LIMIT ?`,
    now,
    now,
    now,
    BATCH,
  );
  const requests = new Map<string, RequestRow>();
  const mails = due.map((signer) => {
    const request = requests.get(signer.request_id) ?? getRequestRow(ctx, signer.request_id);
    requests.set(request.id, request);
    return mailFor(ctx, signer.kind, request, signer);
  });
  const finalize = ctx.db
    .all<{ id: string }>(
      `SELECT id FROM esign_requests WHERE status = 'completed' AND completed_r2_key IS NULL AND finalize_due_at IS NOT NULL AND finalize_due_at <= ? ORDER BY id LIMIT 10`,
      now,
    )
    .map((r) => r.id);
  return { tenant: tenantFacts(ctx), mails, finalize };
}

/** After an invitation / reminder left: schedules the next reminder. */
export function markNotified(
  ctx: CrmContext,
  input: { signerId: string; kind: 'invite' | 'reminder'; tokenHash: string },
): { ok: true } {
  const signer = ctx.db.all<SignerRow>(
    `SELECT * FROM esign_signers WHERE id = ?`,
    input.signerId,
  )[0];
  if (signer === undefined) return { ok: true };
  const request = getRequestRow(ctx, signer.request_id);
  if (!isActive(request)) return { ok: true };
  const { reminders } = settingsOf(request.settings);
  const now = ctx.now();
  const rotated = signer.token_hash !== null && signer.token_hash !== input.tokenHash;
  const cap = (at: number): number | null =>
    request.expires_at !== null && at >= request.expires_at ? null : at;
  if (input.kind === 'invite') {
    const first =
      reminders.enabled && reminders.max > 0
        ? cap(now + reminders.first_after_days * DAY_MS)
        : null;
    ctx.db.run(
      `UPDATE esign_signers SET status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?),
         notify_due_at = NULL, next_reminder_at = ?, token_hash = ?, updated_at = ? WHERE id = ?`,
      now,
      first,
      input.tokenHash,
      now,
      signer.id,
    );
    recordEvent(ctx, {
      requestId: request.id,
      signerId: signer.id,
      type: 'sent',
      actor: { type: 'system', id: null },
      meta: { to: signer.email },
    });
    emit(
      ctx,
      'esign.signer_notified',
      {
        requestId: request.id,
        templateId: request.template_id,
        signerId: signer.id,
        contactId: signer.contact_id,
        partyId: signer.party_id,
      },
      { name: request.name, party_name: signer.party_name },
    );
  } else {
    const sent = signer.reminders_sent + 1;
    const next =
      reminders.enabled && sent < reminders.max ? cap(now + reminders.every_days * DAY_MS) : null;
    ctx.db.run(
      `UPDATE esign_signers SET reminders_sent = ?, next_reminder_at = ?, token_hash = ?, updated_at = ? WHERE id = ?`,
      sent,
      next,
      input.tokenHash,
      now,
      signer.id,
    );
    recordEvent(ctx, {
      requestId: request.id,
      signerId: signer.id,
      type: 'reminder_sent',
      actor: { type: 'system', id: null },
      meta: { to: signer.email, count: sent },
    });
  }
  if (rotated)
    recordEvent(ctx, {
      requestId: request.id,
      signerId: signer.id,
      type: 'link_rotated',
      actor: { type: 'system', id: null },
    });
  return { ok: true };
}

/** The email pipeline gave up on a signer email (suppressed address, bounce, blocked sending…). */
export function mailUndelivered(
  ctx: CrmContext,
  input: { requestId: string; email: string; reason: string },
): { ok: true } {
  const signer = ctx.db.all<SignerRow>(
    `SELECT * FROM esign_signers WHERE request_id = ? AND lower(email) = ? ORDER BY position LIMIT 1`,
    input.requestId,
    input.email.toLowerCase(),
  )[0];
  if (signer === undefined) return { ok: true };
  recordEvent(ctx, {
    requestId: signer.request_id,
    signerId: signer.id,
    type: 'notify_failed',
    actor: { type: 'system', id: null },
    meta: { to: signer.email, error: input.reason.slice(0, 500) },
  });
  return { ok: true };
}

export interface FinalizeContext {
  request: RequestRow;
  signers: SignerRow[];
  events: EsignEvent[];
  tenant: TenantFacts | null;
}

export function finalizeContext(ctx: CrmContext, input: { requestId: string }): FinalizeContext {
  const request = getRequestRow(ctx, input.requestId);
  return {
    request,
    signers: signersOf(ctx, request.id),
    events: eventsOf(ctx, request.id),
    tenant: tenantFacts(ctx),
  };
}

/**
 * Hands out one sealing attempt: counts it and leases the request until
 * `FINALIZE_LEASE_MS`, so the alarm does not hand it out twice and a lost job
 * comes back. Past the last attempt it gives up with an error staff can retry.
 */
export function finalizeLease(ctx: CrmContext, input: { requestId: string }): { granted: boolean } {
  const request = getRequestRow(ctx, input.requestId);
  if (request.status !== 'completed' || request.completed_r2_key !== null) return { granted: false };
  const attempts = request.finalize_attempts + 1;
  const now = ctx.now();
  if (attempts > FINALIZE_MAX_ATTEMPTS) {
    ctx.db.run(
      `UPDATE esign_requests SET finalize_due_at = NULL, finalize_error = COALESCE(finalize_error, ?), updated_at = ? WHERE id = ?`,
      'the signed PDF was not prepared in time',
      now,
      request.id,
    );
    return { granted: false };
  }
  ctx.db.run(
    `UPDATE esign_requests SET finalize_attempts = ?, finalize_due_at = ?, updated_at = ? WHERE id = ?`,
    attempts,
    now + FINALIZE_LEASE_MS,
    now,
    request.id,
  );
  return { granted: true };
}

/** The sealed PDF is stored: returns the "completed" emails to send to every signer (`stored: false`: already sealed). */
export function markFinalized(
  ctx: CrmContext,
  input: { requestId: string; key: string; sha256: string },
): { stored: boolean; mails: EsignMail[] } {
  const request = getRequestRow(ctx, input.requestId);
  if (request.completed_r2_key !== null) return { stored: false, mails: [] };
  const now = ctx.now();
  ctx.db.run(
    `UPDATE esign_requests SET completed_r2_key = ?, completed_sha256 = ?, finalize_due_at = NULL, finalize_error = NULL, updated_at = ? WHERE id = ?`,
    input.key,
    input.sha256,
    now,
    request.id,
  );
  recordEvent(ctx, {
    requestId: request.id,
    type: 'document_sealed',
    actor: { type: 'system', id: null },
    meta: { sha256: input.sha256 },
  });
  const fresh = getRequestRow(ctx, request.id);
  return { stored: true, mails: signersOf(ctx, request.id).map((s) => mailFor(ctx, 'completed', fresh, s)) };
}

export function markFinalizeFailed(
  ctx: CrmContext,
  input: { requestId: string; error: string },
): { ok: true } {
  const request = getRequestRow(ctx, input.requestId);
  if (request.completed_r2_key !== null) return { ok: true };
  // The attempt was counted when it was handed out (`finalizeLease`).
  const attempts = request.finalize_attempts;
  const retryAt =
    attempts >= FINALIZE_MAX_ATTEMPTS
      ? null
      : ctx.now() + Math.min(6 * 3_600_000, 60_000 * 2 ** attempts);
  ctx.db.run(
    `UPDATE esign_requests SET finalize_due_at = ?, finalize_error = ?, updated_at = ? WHERE id = ?`,
    retryAt,
    input.error.slice(0, 1000),
    ctx.now(),
    request.id,
  );
  return { ok: true };
}

/** Staff "retry sealing" after the automatic attempts gave up. */
export function retryFinalize(ctx: CrmContext, input: { id: string }): { ok: true } {
  const request = getRequestRow(ctx, input.id);
  if (request.status !== 'completed' || request.completed_r2_key !== null) return { ok: true };
  ctx.db.run(
    `UPDATE esign_requests SET finalize_due_at = ?, finalize_attempts = 0, finalize_error = NULL, updated_at = ? WHERE id = ?`,
    ctx.now(),
    ctx.now(),
    request.id,
  );
  return { ok: true };
}

/** Next instant the TenantDb alarm has signature work (null: nothing scheduled). */
export function nextEsignDue(db: SqlDb): number | null {
  const row = db.all<{ at: number | null }>(
    `SELECT MIN(at) AS at FROM (
       SELECT MIN(COALESCE(s.notify_due_at, s.next_reminder_at)) AS at
         FROM esign_signers s JOIN esign_requests r ON r.id = s.request_id
        WHERE r.status IN ('sent', 'partially_signed') AND s.status NOT IN ('completed', 'declined')
       UNION ALL SELECT MIN(expires_at) FROM esign_requests WHERE status IN ('sent', 'partially_signed')
       UNION ALL SELECT MIN(finalize_due_at) FROM esign_requests WHERE status = 'completed' AND completed_r2_key IS NULL
     )`,
  )[0];
  return row?.at ?? null;
}
