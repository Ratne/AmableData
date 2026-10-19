import type {
  EsignParty,
  EsignRequest,
  EsignRequestDetail,
  EsignSignerInput,
  ListEsignRequestsQuery,
  Page,
} from '@amable/api-types';
import { randomToken } from '@amable/auth';
import { createContact, getContact } from '../crm/contacts';
import type { CrmContext } from '../crm/context';
import { CrmError, invalid, notFound } from '../crm/errors';
import { decodeCursor, paginate } from '../crm/util';
import { findContactByEmail } from '../forms/mapping';
import {
  eventsOf,
  fieldsOf,
  isActive,
  pagesOf,
  partiesOf,
  recordEvent,
  rememberTenant,
  requestToApi,
  settingsOf,
  signersOf,
  type ClientFacts,
  type RequestRow,
  type SignerRow,
  type TenantFacts,
} from './model';
import { getTemplateRow, templateReady } from './templates';

export const DAY_MS = 86_400_000;

export function getRequestRow(ctx: CrmContext, id: string): RequestRow {
  const row = ctx.db.all<RequestRow>(`SELECT * FROM esign_requests WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('signature request', id);
  return row;
}

function splitName(name: string): { given_name?: string; family_name?: string } {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((p) => p !== '');
  if (parts.length === 0) return {};
  if (parts.length === 1) return { given_name: parts[0]!.slice(0, 100) };
  return {
    given_name: parts.slice(0, -1).join(' ').slice(0, 100),
    family_name: parts[parts.length - 1]!.slice(0, 100),
  };
}

function displayName(contact: {
  given_name: string | null;
  family_name: string | null;
  preferred_name: string | null;
}): string {
  return [contact.preferred_name ?? contact.given_name, contact.family_name]
    .filter((p) => p !== null && p !== '')
    .join(' ');
}

/** The contact a party signs as: an existing one, matched by email, or created. */
function resolveSigner(
  ctx: CrmContext,
  input: EsignSignerInput,
  index: number,
): { contactId: string; email: string; name: string } {
  const path = `signers.${String(index)}`;
  if (input.contact_id !== undefined) {
    const contact = getContact(ctx, { id: input.contact_id });
    const emails = contact.emails.map((e) => e.email.toLowerCase());
    const primary = (contact.emails.find((e) => e.is_primary) ?? contact.emails[0])?.email;
    const email = input.email?.toLowerCase() ?? primary?.toLowerCase();
    if (email === undefined) throw invalid(`${path}.email`, 'the contact has no email address');
    if (!emails.includes(email))
      throw invalid(`${path}.email`, "not one of the contact's email addresses");
    return { contactId: contact.id, email, name: input.name ?? displayName(contact) };
  }
  const email = (input.email ?? '').trim().toLowerCase();
  const existing = findContactByEmail(ctx, email);
  if (existing !== null) {
    const contact = getContact(ctx, { id: existing });
    return { contactId: existing, email, name: input.name ?? displayName(contact) };
  }
  const created = createContact(
    ctx,
    { ...splitName(input.name ?? ''), emails: [{ email }], source_type: 'other' },
    { requireAll: false },
  );
  return { contactId: created.id, email, name: input.name ?? '' };
}

/**
 * The live contact that carries the signer's address, re-linked when the
 * original was merged, deleted or lost that email: the email pipeline only
 * delivers to live contacts, and only to their own addresses.
 */
export function ensureSignerContact(
  ctx: CrmContext,
  signer: Pick<SignerRow, 'id' | 'contact_id' | 'email' | 'name'>,
): string {
  const email = signer.email.toLowerCase();
  const hasEmail = (id: string): boolean =>
    ctx.db.all(
      `SELECT 1 FROM crm_contact_emails WHERE contact_id = ? AND lower(email) = ? LIMIT 1`,
      id,
      email,
    ).length > 0;
  let current = signer.contact_id;
  for (let hop = 0; current !== null && hop < 10; hop += 1) {
    const row = ctx.db.all<{ deleted_at: number | null; merged_into_id: string | null }>(
      `SELECT deleted_at, merged_into_id FROM crm_contacts WHERE id = ?`,
      current,
    )[0];
    if (row === undefined) {
      current = null;
    } else if (row.deleted_at === null) {
      break;
    } else {
      current = row.merged_into_id;
    }
  }
  let contactId = current !== null && hasEmail(current) ? current : findContactByEmail(ctx, email);
  if (contactId === null) {
    contactId = createContact(
      ctx,
      { ...splitName(signer.name), emails: [{ email }], source_type: 'other' },
      { requireAll: false },
    ).id;
  }
  if (contactId !== signer.contact_id) {
    ctx.db.run(
      `UPDATE esign_signers SET contact_id = ?, updated_at = ? WHERE id = ?`,
      contactId,
      ctx.now(),
      signer.id,
    );
  }
  return contactId;
}

export interface CreateRequestInput {
  template_id: string;
  signers: EsignSignerInput[];
  message?: string | undefined;
  expire_days?: number | null | undefined;
  locale?: 'en' | 'it' | undefined;
  origin: 'manual' | 'api' | 'automation';
  /** Idempotency of automation sends (one request per step execution). */
  origin_ref?: string | undefined;
  client?: ClientFacts | undefined;
  tenant?: TenantFacts | undefined;
}

function insertSigner(
  ctx: CrmContext,
  input: {
    requestId: string;
    party: EsignParty;
    position: number;
    contactId: string;
    email: string;
    name: string;
    notifyAt: number | null;
  },
): string {
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO esign_signers (id, request_id, party_id, party_name, position, contact_id, email, name, token_nonce, notify_due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.requestId,
    input.party.id,
    input.party.name,
    input.position,
    input.contactId,
    input.email,
    input.name.slice(0, 200),
    randomToken(12),
    input.notifyAt,
    now,
    now,
  );
  return id;
}

/** Snapshots the template and creates one signer per party; invitations go out from the TenantDb alarm. */
export function createRequest(ctx: CrmContext, input: CreateRequestInput): EsignRequest {
  if (input.origin_ref !== undefined) {
    const existing = ctx.db.all<{ id: string }>(
      `SELECT id FROM esign_requests WHERE origin_ref = ?`,
      input.origin_ref,
    )[0];
    if (existing !== undefined) return getRequest(ctx, { id: existing.id });
  }
  const template = getTemplateRow(ctx, input.template_id);
  const parties = partiesOf(template.parties);
  const fields = fieldsOf(template.fields);
  const pages = pagesOf(template.pages);
  if (
    template.status !== 'active' ||
    template.source_r2_key === null ||
    template.source_sha256 === null
  ) {
    throw new CrmError('conflict', 'the template must be active before sending it');
  }
  if (!templateReady(pages, parties, fields))
    throw new CrmError('conflict', 'the template is not ready to be sent');

  const byParty = new Map<string, { input: EsignSignerInput; index: number }>();
  input.signers.forEach((signer, index) => {
    if (!parties.some((p) => p.id === signer.party_id)) {
      throw invalid(`signers.${String(index)}.party_id`, `unknown party ${signer.party_id}`);
    }
    if (byParty.has(signer.party_id))
      throw invalid(`signers.${String(index)}.party_id`, 'one signer per party');
    byParty.set(signer.party_id, { input: signer, index });
  });
  const missing = parties.filter((p) => !byParty.has(p.id));
  if (missing.length > 0) {
    throw invalid('signers', `missing a signer for ${missing.map((p) => p.name).join(', ')}`);
  }

  const settings = settingsOf(template.settings);
  const now = ctx.now();
  const expireDays = input.expire_days === undefined ? settings.expire_days : input.expire_days;
  const locale = input.locale ?? settings.locale;
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO esign_requests (id, template_id, name, status, signing_order, parties, fields, pages, settings, source_r2_key, source_sha256,
       origin, origin_ref, message, locale, created_by, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    template.id,
    template.name,
    template.signing_order,
    template.parties,
    template.fields,
    template.pages,
    JSON.stringify(settings),
    template.source_r2_key,
    template.source_sha256,
    input.origin,
    input.origin_ref ?? null,
    input.message ?? settings.email_message,
    locale,
    ctx.actor.type === 'user' || ctx.actor.type === 'api_key' ? ctx.actor.id : null,
    expireDays === null ? null : now + expireDays * DAY_MS,
    now,
    now,
  );
  recordEvent(ctx, {
    requestId: id,
    type: 'created',
    ...(input.client === undefined ? {} : { client: input.client }),
    meta: {
      origin: input.origin,
      template_id: template.id,
      source_sha256: template.source_sha256,
      parties: parties.length,
    },
  });
  parties.forEach((party, position) => {
    const entry = byParty.get(party.id)!;
    const signer = resolveSigner(ctx, entry.input, entry.index);
    const notifyAt = template.signing_order === 'parallel' || position === 0 ? now : null;
    insertSigner(ctx, { requestId: id, party, position, ...signer, notifyAt });
  });
  rememberTenant(ctx, input.tenant);
  return getRequest(ctx, { id });
}

/** `send_signature_request` automation step: the enrolled contact signs as `party_id`. */
export function createRequestFromAutomation(
  ctx: CrmContext,
  input: {
    template_id: string;
    contact_id: string;
    party_id?: string | undefined;
    others?: Array<{ party_id: string; email: string; name?: string | undefined }> | undefined;
    message?: string | undefined;
    origin_ref: string;
  },
): EsignRequest {
  const template = getTemplateRow(ctx, input.template_id);
  const parties = partiesOf(template.parties);
  const party = input.party_id ?? parties[0]?.id;
  if (party === undefined) throw invalid('party_id', 'the template has no parties');
  const signers: EsignSignerInput[] = [
    { party_id: party, contact_id: input.contact_id },
    ...(input.others ?? [])
      .filter((o) => o.party_id !== party)
      .map((o) => ({
        party_id: o.party_id,
        email: o.email,
        ...(o.name === undefined ? {} : { name: o.name }),
      })),
  ];
  return createRequest(ctx, {
    template_id: input.template_id,
    signers,
    ...(input.message === undefined || input.message === '' ? {} : { message: input.message }),
    origin: 'automation',
    origin_ref: input.origin_ref,
  });
}

export function listRequests(ctx: CrmContext, input: ListEsignRequestsQuery): Page<EsignRequest> {
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const contact = input.contact_id ?? null;
  const rows = ctx.db.all<RequestRow>(
    `SELECT * FROM esign_requests r
     WHERE (? IS NULL OR r.status = ?) AND (? IS NULL OR r.template_id = ?)
       AND (? IS NULL OR EXISTS (SELECT 1 FROM esign_signers s WHERE s.request_id = r.id AND s.contact_id = ?))
       AND (? IS NULL OR r.id < ?)
     ORDER BY r.id DESC LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    input.template_id ?? null,
    input.template_id ?? null,
    contact,
    contact,
    after,
    after,
    input.limit + 1,
  );
  const page = paginate(rows, input.limit, (row) => ({ v: null, id: row.id }));
  return {
    data: page.rows.map((row) => requestToApi(row, signersOf(ctx, row.id))),
    next_cursor: page.nextCursor,
  };
}

export function getRequest(ctx: CrmContext, input: { id: string }): EsignRequest {
  const row = getRequestRow(ctx, input.id);
  return requestToApi(row, signersOf(ctx, row.id));
}

export function getRequestDetail(ctx: CrmContext, input: { id: string }): EsignRequestDetail {
  const row = getRequestRow(ctx, input.id);
  return {
    ...requestToApi(row, signersOf(ctx, row.id)),
    events: eventsOf(ctx, row.id),
    fields: fieldsOf(row.fields),
    parties: partiesOf(row.parties),
  };
}

/** Stops every pending timer of a request (it ended). */
export function clearTimers(ctx: CrmContext, requestId: string): void {
  ctx.db.run(
    `UPDATE esign_signers SET notify_due_at = NULL, next_reminder_at = NULL, otp_hash = NULL, updated_at = ? WHERE request_id = ?`,
    ctx.now(),
    requestId,
  );
}

export function voidRequest(
  ctx: CrmContext,
  input: { id: string; reason?: string | undefined; client?: ClientFacts },
): EsignRequest {
  const row = getRequestRow(ctx, input.id);
  if (!isActive(row)) throw new CrmError('conflict', `the request is ${row.status}`);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE esign_requests SET status = 'voided', voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?`,
    now,
    input.reason ?? null,
    now,
    row.id,
  );
  clearTimers(ctx, row.id);
  recordEvent(ctx, {
    requestId: row.id,
    type: 'voided',
    ...(input.client === undefined ? {} : { client: input.client }),
    meta: { reason: input.reason ?? null },
  });
  return getRequest(ctx, { id: row.id });
}

/** Signers whose turn it is and who did not finish (sequential: only the first unfinished party). */
export function signersToRemind(
  signers: readonly SignerRow[],
  order: RequestRow['signing_order'],
): SignerRow[] {
  const open = signers.filter((s) => s.status !== 'completed' && s.status !== 'declined');
  return order === 'sequential' ? open.slice(0, 1) : open;
}

/** Manual reminder: due now on the TenantDb alarm (an invitation not sent yet goes out as the invitation). */
export function remindRequest(
  ctx: CrmContext,
  input: { id: string; signer_id?: string | undefined; client?: ClientFacts },
): EsignRequest {
  const row = getRequestRow(ctx, input.id);
  if (!isActive(row)) throw new CrmError('conflict', `the request is ${row.status}`);
  const targets = signersToRemind(signersOf(ctx, row.id), row.signing_order).filter(
    (s) => input.signer_id === undefined || s.id === input.signer_id,
  );
  if (targets.length === 0) throw new CrmError('conflict', 'nobody to remind');
  const now = ctx.now();
  for (const signer of targets) {
    if (signer.sent_at === null) {
      ctx.db.run(
        `UPDATE esign_signers SET notify_due_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        signer.id,
      );
    } else {
      ctx.db.run(
        `UPDATE esign_signers SET next_reminder_at = ?, updated_at = ? WHERE id = ?`,
        now,
        now,
        signer.id,
      );
    }
  }
  recordEvent(ctx, {
    requestId: row.id,
    type: 'reminder_requested',
    ...(input.client === undefined ? {} : { client: input.client }),
    meta: { signer_ids: targets.map((s) => s.id) },
  });
  return getRequest(ctx, { id: row.id });
}

/** Signing link of one signer, for staff ("copy link"): the worker derives the token from the nonce. */
export function signerLinkFacts(
  ctx: CrmContext,
  input: { requestId: string; signerId: string; client?: ClientFacts },
): { signerId: string; tokenNonce: string; tokenHash: string | null } {
  const row = getRequestRow(ctx, input.requestId);
  const signer = signersOf(ctx, row.id).find((s) => s.id === input.signerId);
  if (signer === undefined) throw notFound('signer', input.signerId);
  if (!isActive(row) && row.status !== 'completed')
    throw new CrmError('conflict', `the request is ${row.status}`);
  recordEvent(ctx, {
    requestId: row.id,
    signerId: signer.id,
    type: 'link_copied',
    ...(input.client === undefined ? {} : { client: input.client }),
  });
  return { signerId: signer.id, tokenNonce: signer.token_nonce, tokenHash: signer.token_hash };
}

/** PDF of a request for staff: the sealed one, or the original sent for signature. */
export function requestFile(
  ctx: CrmContext,
  input: { id: string; kind: 'completed' | 'original'; client?: ClientFacts },
): { key: string; content_type: string; filename: string } {
  const row = getRequestRow(ctx, input.id);
  const base = row.name.replace(/[^\p{L}\p{N} _.-]+/gu, '').trim() || 'document';
  if (input.kind === 'completed') {
    if (row.completed_r2_key === null) throw notFound('signed document of request', row.id);
    recordEvent(ctx, {
      requestId: row.id,
      type: 'downloaded',
      ...(input.client === undefined ? {} : { client: input.client }),
      meta: { document: 'completed' },
    });
    return {
      key: row.completed_r2_key,
      content_type: 'application/pdf',
      filename: `${base} (signed).pdf`,
    };
  }
  return { key: row.source_r2_key, content_type: 'application/pdf', filename: `${base}.pdf` };
}

/** Stores the hash of a signer's link the first time the worker derives it. */
export function setTokenHash(
  ctx: CrmContext,
  input: { signerId: string; tokenHash: string; force?: boolean },
): { ok: true } {
  const signer = ctx.db.all<SignerRow>(
    `SELECT * FROM esign_signers WHERE id = ?`,
    input.signerId,
  )[0];
  if (signer === undefined || signer.token_hash === input.tokenHash) return { ok: true };
  if (signer.token_hash !== null && input.force !== true) return { ok: true };
  ctx.db.run(
    `UPDATE esign_signers SET token_hash = ?, updated_at = ? WHERE id = ?`,
    input.tokenHash,
    ctx.now(),
    signer.id,
  );
  if (signer.token_hash !== null) {
    recordEvent(ctx, {
      requestId: signer.request_id,
      signerId: signer.id,
      type: 'link_rotated',
      actor: { type: 'system', id: null },
    });
  }
  return { ok: true };
}
