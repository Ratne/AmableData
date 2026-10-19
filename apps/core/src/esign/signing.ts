import { timingSafeEqual } from '@amable/auth';
import {
  consentText,
  ESIGN_CONSENT_VERSION,
  resolveEsignLocale,
  type EsignLocale,
  type SigningOtherField,
  type SigningView,
} from '@amable/esign';
import type { CrmContext } from '../crm/context';
import { CrmError, invalidMany, notFound } from '../crm/errors';
import { emit } from '../crm/events';
import { parseJson, toIso } from '../crm/util';
import { signingDay, validateValues } from './fields';
import {
  fieldsOf,
  isActive,
  isImageValue,
  pagesOf,
  partiesOf,
  recordEvent,
  settingsOf,
  signersOf,
  valuesOf,
  type ClientFacts,
  type FieldValues,
  type RequestRow,
  type SignerRow,
} from './model';
import { clearTimers, ensureSignerContact, getRequestRow } from './requests';

/** Signer actions are recorded as the signer, not as the anonymous public actor. */
const signerActor = (signer: SignerRow) => ({ type: 'signer', id: signer.id });

export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = 60_000;
const OTP_MAX_PER_HOUR = 5;

export interface SignerRef {
  tokenHash: string;
}

function findSigner(
  ctx: CrmContext,
  tokenHash: string,
): { request: RequestRow; signer: SignerRow } {
  const signer = ctx.db.all<SignerRow>(
    `SELECT * FROM esign_signers WHERE token_hash = ?`,
    tokenHash,
  )[0];
  if (signer === undefined) throw notFound('signing link', 'token');
  const request = getRequestRow(ctx, signer.request_id);
  return { request: expireIfDue(ctx, request), signer };
}

/** Marks an active request past its deadline as expired (the alarm does it too; links must not wait for it). */
export function expireIfDue(ctx: CrmContext, request: RequestRow): RequestRow {
  if (!isActive(request) || request.expires_at === null || request.expires_at > ctx.now())
    return request;
  const now = ctx.now();
  ctx.db.run(
    `UPDATE esign_requests SET status = 'expired', updated_at = ? WHERE id = ?`,
    now,
    request.id,
  );
  clearTimers(ctx, request.id);
  recordEvent(ctx, { requestId: request.id, type: 'expired', actor: { type: 'system', id: null } });
  return { ...request, status: 'expired', updated_at: now };
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const shown = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${shown}${'•'.repeat(Math.max(1, local.length - shown.length))}@${domain}`;
}

function textOf(value: FieldValues[string] | undefined): string | null {
  if (value === undefined || isImageValue(value)) return null;
  if (typeof value === 'boolean') return value ? '✓' : null;
  return value;
}

function turnReached(
  signer: SignerRow,
  all: readonly SignerRow[],
  order: RequestRow['signing_order'],
): boolean {
  return (
    order === 'parallel' ||
    all.every((s) => s.position >= signer.position || s.status === 'completed')
  );
}

export function signerLocale(request: RequestRow, preferred: readonly string[]): EsignLocale {
  return resolveEsignLocale(request.locale, preferred);
}

export function buildView(
  ctx: CrmContext,
  input: {
    request: RequestRow;
    signer: SignerRow;
    tenantName: string;
    preferred: readonly string[];
  },
): SigningView {
  const { request, signer } = input;
  const all = signersOf(ctx, request.id);
  const parties = partiesOf(request.parties);
  const fields = fieldsOf(request.fields);
  const settings = settingsOf(request.settings);
  const locale = signerLocale(request, input.preferred);
  const valuesByParty = new Map(
    all.map((s) => [s.party_id, { status: s.status, values: valuesOf(s.field_values) }]),
  );

  let state: SigningView['state'] = 'ready';
  let closed: SigningView['closed_reason'] = null;
  if (request.status === 'completed') state = 'completed';
  else if (signer.status === 'declined') state = 'declined';
  else if (
    request.status === 'declined' ||
    request.status === 'voided' ||
    request.status === 'expired'
  ) {
    state = 'closed';
    closed = request.status;
  } else if (signer.status === 'completed') state = 'signed';
  else if (!turnReached(signer, all, request.signing_order)) state = 'waiting';

  const own = valuesOf(signer.field_values);
  const others: SigningOtherField[] = fields
    .filter((f) => f.party_id !== signer.party_id)
    .map((f) => {
      const party = valuesByParty.get(f.party_id);
      const value = party?.status === 'completed' ? party.values[f.id] : undefined;
      return {
        id: f.id,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        party_name: parties.find((p) => p.id === f.party_id)?.name ?? f.party_id,
        color: parties.find((p) => p.id === f.party_id)?.color ?? null,
        filled: value !== undefined,
        text: textOf(value),
      };
    });
  const values: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(own)) if (!isImageValue(value)) values[key] = value;

  return {
    tenant_name: input.tenantName,
    request_name: request.name,
    message: request.message,
    locale,
    state,
    closed_reason: closed,
    signer: { name: signer.name, email: signer.email, party_name: signer.party_name },
    expires_at: toIso(request.expires_at),
    otp: {
      required: settings.require_otp,
      verified: signer.otp_verified_at !== null,
      email_hint: maskEmail(signer.email),
    },
    pages: pagesOf(request.pages).map((p) => ({
      index: p.index,
      width: p.width,
      height: p.height,
    })),
    fields: fields
      .filter((f) => f.party_id === signer.party_id)
      .map((f) => ({
        id: f.id,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        required: f.required,
        label: f.label,
        options: f.options,
      })),
    others,
    values,
    document_ready: request.completed_r2_key !== null,
    consent: { version: ESIGN_CONSENT_VERSION, text: consentText(locale) },
  };
}

export interface SignerFacts {
  id: string;
  request_id: string;
  contact_id: string | null;
  email: string;
  name: string;
  party_name: string;
  request_name: string;
  locale: EsignLocale;
}

function factsOf(
  request: RequestRow,
  signer: SignerRow,
  preferred: readonly string[],
): SignerFacts {
  return {
    id: signer.id,
    request_id: request.id,
    contact_id: signer.contact_id,
    email: signer.email,
    name: signer.name,
    party_name: signer.party_name,
    request_name: request.name,
    locale: signerLocale(request, preferred),
  };
}

/** Signing page facts; `open` records the visit (first one moves the signer to `opened`). */
export function signerView(
  ctx: CrmContext,
  input: SignerRef & { tenantName: string; preferred: string[]; open?: { client: ClientFacts } },
): { view: SigningView; signer: SignerFacts } {
  const found = findSigner(ctx, input.tokenHash);
  let { signer } = found;
  if (input.open !== undefined) {
    const now = ctx.now();
    if (signer.opened_at === null && (signer.status === 'pending' || signer.status === 'sent')) {
      ctx.db.run(
        `UPDATE esign_signers SET status = 'opened', opened_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        signer.id,
      );
      signer = { ...signer, status: 'opened', opened_at: now };
    }
    recordEvent(ctx, {
      requestId: found.request.id,
      signerId: signer.id,
      type: 'opened',
      client: input.open.client,
      actor: signerActor(signer),
    });
  }
  return {
    view: buildView(ctx, {
      request: found.request,
      signer,
      tenantName: input.tenantName,
      preferred: input.preferred,
    }),
    signer: factsOf(found.request, signer, input.preferred),
  };
}

function assertCanAct(ctx: CrmContext, request: RequestRow, signer: SignerRow): void {
  if (!isActive(request)) throw new CrmError('conflict', `the request is ${request.status}`);
  if (signer.status === 'completed' || signer.status === 'declined')
    throw new CrmError('conflict', `already ${signer.status}`);
  if (!turnReached(signer, signersOf(ctx, request.id), request.signing_order)) {
    throw new CrmError('conflict', 'another party signs first');
  }
}

/** Stores the hash of a new code; the worker emails the code. Rate limited per signer. */
export function otpIssue(
  ctx: CrmContext,
  input: SignerRef & { codeHash: string; preferred: string[]; client: ClientFacts },
): { ok: true; signer: SignerFacts & { contact_id: string }; retryAfter: number } | { ok: false; retryAfter: number } {
  const { request, signer } = findSigner(ctx, input.tokenHash);
  assertCanAct(ctx, request, signer);
  const now = ctx.now();
  const sends = parseJson<unknown[]>(signer.otp_sends, []).filter(
    (t): t is number => typeof t === 'number' && now - t < 3_600_000,
  );
  const last = sends[sends.length - 1];
  if (last !== undefined && now - last < OTP_RESEND_MS)
    return { ok: false, retryAfter: Math.ceil((last + OTP_RESEND_MS - now) / 1000) };
  if (sends.length >= OTP_MAX_PER_HOUR)
    return { ok: false, retryAfter: Math.ceil((sends[0]! + 3_600_000 - now) / 1000) };
  sends.push(now);
  ctx.db.run(
    `UPDATE esign_signers SET otp_hash = ?, otp_expires_at = ?, otp_attempts = 0, otp_sends = ?, updated_at = ? WHERE id = ?`,
    input.codeHash,
    now + OTP_TTL_MS,
    JSON.stringify(sends),
    now,
    signer.id,
  );
  recordEvent(ctx, {
    requestId: request.id,
    signerId: signer.id,
    type: 'otp_sent',
    client: input.client,
    actor: signerActor(signer),
    meta: { to: signer.email },
  });
  const contactId = ensureSignerContact(ctx, signer);
  return {
    ok: true,
    signer: { ...factsOf(request, signer, input.preferred), contact_id: contactId },
    retryAfter: OTP_RESEND_MS / 1000,
  };
}

/** Checks a code; attempts are persisted (the op returns instead of throwing so the counter commits). */
export function otpVerify(
  ctx: CrmContext,
  input: SignerRef & { codeHash: string; client: ClientFacts },
): { verified: boolean; attempts_left: number; expired: boolean } {
  const { request, signer } = findSigner(ctx, input.tokenHash);
  assertCanAct(ctx, request, signer);
  if (signer.otp_verified_at !== null)
    return { verified: true, attempts_left: OTP_MAX_ATTEMPTS, expired: false };
  const now = ctx.now();
  if (
    signer.otp_hash === null ||
    signer.otp_expires_at === null ||
    signer.otp_expires_at < now ||
    signer.otp_attempts >= OTP_MAX_ATTEMPTS
  ) {
    return { verified: false, attempts_left: 0, expired: true };
  }
  if (timingSafeEqual(signer.otp_hash, input.codeHash)) {
    ctx.db.run(
      `UPDATE esign_signers SET otp_verified_at = ?, otp_hash = NULL, otp_expires_at = NULL, updated_at = ? WHERE id = ?`,
      now,
      now,
      signer.id,
    );
    recordEvent(ctx, {
      requestId: request.id,
      signerId: signer.id,
      type: 'otp_verified',
      client: input.client,
      actor: signerActor(signer),
      meta: { email: signer.email },
    });
    return { verified: true, attempts_left: OTP_MAX_ATTEMPTS, expired: false };
  }
  const attempts = signer.otp_attempts + 1;
  ctx.db.run(
    `UPDATE esign_signers SET otp_attempts = ?, updated_at = ? WHERE id = ?`,
    attempts,
    now,
    signer.id,
  );
  recordEvent(ctx, {
    requestId: request.id,
    signerId: signer.id,
    type: 'otp_failed',
    client: input.client,
    actor: signerActor(signer),
    meta: { attempt: attempts },
  });
  const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
  return { verified: false, attempts_left: left, expired: left === 0 };
}

/** The signer's own fields, for the worker to validate before uploading images. */
export function signerFields(
  ctx: CrmContext,
  input: SignerRef,
): { requestId: string; signerId: string; fields: ReturnType<typeof fieldsOf> } {
  const { request, signer } = findSigner(ctx, input.tokenHash);
  assertCanAct(ctx, request, signer);
  return {
    requestId: request.id,
    signerId: signer.id,
    fields: fieldsOf(request.fields).filter((f) => f.party_id === signer.party_id),
  };
}

function payloadOf(request: RequestRow, signer: SignerRow) {
  return {
    requestId: request.id,
    templateId: request.template_id,
    signerId: signer.id,
    contactId: signer.contact_id,
    partyId: signer.party_id,
  };
}

/** Records the signature: consent, values, completion of the request when every party signed. */
export function completeSigning(
  ctx: CrmContext,
  input: SignerRef & {
    values: FieldValues;
    consentVersion: string;
    tenantName: string;
    preferred: string[];
    client: ClientFacts;
  },
): { view: SigningView; completed: boolean } {
  const { request, signer } = findSigner(ctx, input.tokenHash);
  assertCanAct(ctx, request, signer);
  const settings = settingsOf(request.settings);
  if (settings.require_otp && signer.otp_verified_at === null)
    throw new CrmError('forbidden', 'confirm your email first');
  if (input.consentVersion !== ESIGN_CONSENT_VERSION)
    throw new CrmError('conflict', 'the consent text changed: reload the page');
  const now = ctx.now();
  const own = fieldsOf(request.fields).filter((f) => f.party_id === signer.party_id);
  const checked = validateValues(own, input.values, signingDay(now, input.client.meta['time_zone']));
  if (checked.errors.length > 0) throw invalidMany(checked.errors);

  const locale = signerLocale(request, input.preferred);
  recordEvent(ctx, {
    requestId: request.id,
    signerId: signer.id,
    type: 'consent_given',
    client: input.client,
    actor: signerActor(signer),
    meta: { version: ESIGN_CONSENT_VERSION, locale, text: consentText(locale) },
  });
  ctx.db.run(
    `UPDATE esign_signers SET status = 'completed', field_values = ?, consent_at = ?, completed_at = ?,
       notify_due_at = NULL, next_reminder_at = NULL, otp_hash = NULL, updated_at = ? WHERE id = ?`,
    JSON.stringify(checked.values),
    now,
    now,
    now,
    signer.id,
  );
  const images = Object.entries(checked.values)
    .filter(([, v]) => isImageValue(v))
    .map(([field, v]) => (isImageValue(v) ? { field, sha256: v.sha256, method: v.method } : null));
  recordEvent(ctx, {
    requestId: request.id,
    signerId: signer.id,
    type: 'signed',
    client: input.client,
    actor: signerActor(signer),
    meta: {
      email: signer.email,
      name: signer.name,
      party: signer.party_name,
      fields: Object.keys(checked.values).length,
      images,
    },
  });
  emit(ctx, 'esign.signer_signed', payloadOf(request, signer), {
    name: request.name,
    party_name: signer.party_name,
  });

  const all = signersOf(ctx, request.id);
  const done = all.every((s) => s.status === 'completed');
  if (done) {
    ctx.db.run(
      `UPDATE esign_requests SET status = 'completed', completed_at = ?, finalize_due_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      now,
      request.id,
    );
    recordEvent(ctx, {
      requestId: request.id,
      type: 'completed',
      actor: { type: 'system', id: null },
    });
    for (const s of all) {
      emit(ctx, 'esign.request_completed', payloadOf(request, s), {
        name: request.name,
        party_name: s.party_name,
      });
    }
  } else {
    ctx.db.run(
      `UPDATE esign_requests SET status = 'partially_signed', updated_at = ? WHERE id = ?`,
      now,
      request.id,
    );
    if (request.signing_order === 'sequential') {
      const next = all.find((s) => s.status !== 'completed' && s.sent_at === null);
      if (next !== undefined)
        ctx.db.run(
          `UPDATE esign_signers SET notify_due_at = ?, updated_at = ? WHERE id = ?`,
          now,
          now,
          next.id,
        );
    }
  }
  const fresh = getRequestRow(ctx, request.id);
  const freshSigner = signersOf(ctx, request.id).find((s) => s.id === signer.id)!;
  return {
    view: buildView(ctx, {
      request: fresh,
      signer: freshSigner,
      tenantName: input.tenantName,
      preferred: input.preferred,
    }),
    completed: done,
  };
}

/** Who to tell that a party declined: the sender (`created_by`), else the workspace admins. */
export interface DeclineNotice {
  requestId: string;
  requestName: string;
  createdBy: string | null;
  signer: string;
  reason: string | null;
}

export function declineSigning(
  ctx: CrmContext,
  input: SignerRef & {
    reason?: string | undefined;
    tenantName: string;
    preferred: string[];
    client: ClientFacts;
  },
): { view: SigningView; notice: DeclineNotice } {
  const { request, signer } = findSigner(ctx, input.tokenHash);
  assertCanAct(ctx, request, signer);
  const now = ctx.now();
  const reason = input.reason?.trim().slice(0, 500) || null;
  ctx.db.run(
    `UPDATE esign_signers SET status = 'declined', declined_at = ?, decline_reason = ?, updated_at = ? WHERE id = ?`,
    now,
    reason,
    now,
    signer.id,
  );
  ctx.db.run(
    `UPDATE esign_requests SET status = 'declined', declined_at = ?, updated_at = ? WHERE id = ?`,
    now,
    now,
    request.id,
  );
  clearTimers(ctx, request.id);
  recordEvent(ctx, {
    requestId: request.id,
    signerId: signer.id,
    type: 'declined',
    client: input.client,
    actor: signerActor(signer),
    meta: { reason },
  });
  emit(
    ctx,
    'esign.request_declined',
    { ...payloadOf(request, signer), reason },
    { name: request.name, party_name: signer.party_name },
  );
  const fresh = getRequestRow(ctx, request.id);
  const freshSigner = signersOf(ctx, request.id).find((s) => s.id === signer.id)!;
  return {
    view: buildView(ctx, {
      request: fresh,
      signer: freshSigner,
      tenantName: input.tenantName,
      preferred: input.preferred,
    }),
    notice: {
      requestId: request.id,
      requestName: request.name,
      createdBy: request.created_by,
      signer: signer.name.trim() === '' ? signer.email : `${signer.name} <${signer.email}>`,
      reason,
    },
  };
}

/** R2 object a signer may read: a page image, or the PDF (completed when sealed, original otherwise). */
export function signerFile(
  ctx: CrmContext,
  input: SignerRef & { page?: number; client?: ClientFacts },
): { key: string; content_type: string; filename: string } {
  const { request, signer } = findSigner(ctx, input.tokenHash);
  if (input.page !== undefined) {
    const page = pagesOf(request.pages).find((p) => p.index === input.page);
    if (page?.image_key == null) throw notFound('page', String(input.page));
    return {
      key: page.image_key,
      content_type: page.image_type ?? 'image/webp',
      filename: `page-${String(page.index + 1)}`,
    };
  }
  const completed = request.completed_r2_key;
  recordEvent(ctx, {
    requestId: request.id,
    signerId: signer.id,
    type: 'downloaded',
    ...(input.client === undefined ? {} : { client: input.client }),
    actor: signerActor(signer),
    meta: { document: completed === null ? 'original' : 'completed' },
  });
  const base = request.name.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'document';
  return completed === null
    ? { key: request.source_r2_key, content_type: 'application/pdf', filename: `${base}.pdf` }
    : { key: completed, content_type: 'application/pdf', filename: `${base} (signed).pdf` };
}
