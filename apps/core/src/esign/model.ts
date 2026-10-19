import {
  ESIGN_DEFAULT_SETTINGS,
  esignSettingsSchema,
  type EsignEvent,
  type EsignField,
  type EsignParty,
  type EsignRequest,
  type EsignSettings,
  type EsignSigner,
} from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { parseJson, toIso } from '../crm/util';

/** Page of a template / request as stored: size in PDF points and its rendered image in R2. */
export interface StoredPage {
  index: number;
  width: number;
  height: number;
  image_key: string | null;
  image_type: string | null;
}

/** Image value (signature, initials, picture) stored in R2. */
export interface ImageValue {
  key: string;
  sha256: string;
  content_type: string;
  /** `drawn` / `typed` signatures, `upload` pictures. */
  method: string;
}

export type FieldValue = string | boolean | ImageValue;
export type FieldValues = Record<string, FieldValue>;

export function isImageValue(value: FieldValue | undefined): value is ImageValue {
  return typeof value === 'object' && value !== null && typeof value.key === 'string';
}

/** What the browser / API caller looked like when an audit event happened. */
export interface ClientFacts {
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  /** Accept-Language, referer, visitor id, time zone, screen, platform… */
  meta: Record<string, unknown>;
}

export const NO_CLIENT: ClientFacts = { ip: null, user_agent: null, country: null, meta: {} };

export interface TemplateRow {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
  source_r2_key: string | null;
  source_filename: string | null;
  source_size: number | null;
  source_sha256: string | null;
  pages: string;
  parties: string;
  signing_order: 'parallel' | 'sequential';
  fields: string;
  settings: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface RequestRow {
  id: string;
  template_id: string;
  name: string;
  status: EsignRequest['status'];
  signing_order: 'parallel' | 'sequential';
  parties: string;
  fields: string;
  pages: string;
  settings: string;
  source_r2_key: string;
  source_sha256: string;
  completed_r2_key: string | null;
  completed_sha256: string | null;
  finalize_due_at: number | null;
  finalize_attempts: number;
  finalize_error: string | null;
  origin: 'manual' | 'api' | 'automation';
  origin_ref: string | null;
  message: string;
  locale: string;
  created_by: string | null;
  expires_at: number | null;
  completed_at: number | null;
  declined_at: number | null;
  voided_at: number | null;
  void_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface SignerRow {
  id: string;
  request_id: string;
  party_id: string;
  party_name: string;
  position: number;
  contact_id: string | null;
  email: string;
  name: string;
  status: EsignSigner['status'];
  token_nonce: string;
  token_hash: string | null;
  field_values: string;
  otp_hash: string | null;
  otp_expires_at: number | null;
  otp_attempts: number;
  otp_sends: string;
  otp_verified_at: number | null;
  consent_at: number | null;
  notify_due_at: number | null;
  next_reminder_at: number | null;
  reminders_sent: number;
  sent_at: number | null;
  opened_at: number | null;
  completed_at: number | null;
  declined_at: number | null;
  decline_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface EventRow {
  id: string;
  request_id: string;
  signer_id: string | null;
  type: string;
  actor_type: string;
  actor_id: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  meta: string;
  occurred_at: number;
}

export const ACTIVE_STATUSES = ['sent', 'partially_signed'] as const;

export function isActive(row: Pick<RequestRow, 'status'>): boolean {
  return row.status === 'sent' || row.status === 'partially_signed';
}

export function settingsOf(text: string): EsignSettings {
  const parsed = esignSettingsSchema.safeParse(parseJson<unknown>(text, {}));
  return parsed.success ? parsed.data : ESIGN_DEFAULT_SETTINGS;
}

export const partiesOf = (text: string): EsignParty[] => parseJson<EsignParty[]>(text, []);
export const fieldsOf = (text: string): EsignField[] => parseJson<EsignField[]>(text, []);
export const pagesOf = (text: string): StoredPage[] => parseJson<StoredPage[]>(text, []);
export const valuesOf = (text: string): FieldValues => parseJson<FieldValues>(text, {});

export function signerToApi(row: SignerRow): EsignSigner {
  return {
    id: row.id,
    party_id: row.party_id,
    party_name: row.party_name,
    position: row.position,
    contact_id: row.contact_id,
    email: row.email,
    name: row.name,
    status: row.status,
    sent_at: toIso(row.sent_at),
    opened_at: toIso(row.opened_at),
    completed_at: toIso(row.completed_at),
    declined_at: toIso(row.declined_at),
    decline_reason: row.decline_reason,
    reminders_sent: row.reminders_sent,
    next_reminder_at: toIso(row.next_reminder_at),
    otp_verified_at: toIso(row.otp_verified_at),
  };
}

export function requestToApi(row: RequestRow, signers: readonly SignerRow[]): EsignRequest {
  return {
    id: row.id,
    template_id: row.template_id,
    name: row.name,
    status: row.status,
    signing_order: row.signing_order,
    origin: row.origin,
    message: row.message,
    locale: row.locale,
    source_sha256: row.source_sha256,
    completed_sha256: row.completed_sha256,
    document_ready: row.completed_r2_key !== null,
    finalize_error: row.finalize_error,
    finalize_next_attempt_at: row.completed_r2_key === null ? toIso(row.finalize_due_at) : null,
    expires_at: toIso(row.expires_at),
    completed_at: toIso(row.completed_at),
    declined_at: toIso(row.declined_at),
    voided_at: toIso(row.voided_at),
    void_reason: row.void_reason,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    signers: signers.map(signerToApi),
  };
}

function eventToApi(row: EventRow): EsignEvent {
  return {
    id: row.id,
    signer_id: row.signer_id,
    type: row.type,
    actor: { type: row.actor_type, id: row.actor_id },
    ip: row.ip,
    user_agent: row.user_agent,
    country: row.country,
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    occurred_at: toIso(row.occurred_at),
  };
}

const clip = (value: string | null, max: number): string | null =>
  value === null ? null : value.slice(0, max);

/** Appends one audit event. Signer-side events carry the browser facts, staff ones the API caller's. */
export function recordEvent(
  ctx: CrmContext,
  input: {
    requestId: string;
    signerId?: string | null;
    type: string;
    client?: ClientFacts;
    meta?: Record<string, unknown>;
    /** Signers act through their link: recorded as `signer`, not as the anonymous public actor. */
    actor?: { type: string; id: string | null };
  },
): void {
  const client = input.client ?? NO_CLIENT;
  const actor = input.actor ?? { type: ctx.actor.type, id: ctx.actor.id };
  ctx.db.run(
    `INSERT INTO esign_events (id, request_id, signer_id, type, actor_type, actor_id, ip, user_agent, country, meta, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.newId(),
    input.requestId,
    input.signerId ?? null,
    input.type,
    actor.type,
    actor.id,
    clip(client.ip, 64),
    clip(client.user_agent, 1024),
    clip(client.country, 8),
    JSON.stringify({ ...client.meta, ...input.meta }).slice(0, 16_000),
    ctx.now(),
  );
}

export function eventsOf(ctx: CrmContext, requestId: string): EsignEvent[] {
  return ctx.db
    .all<EventRow>(`SELECT * FROM esign_events WHERE request_id = ? ORDER BY id`, requestId)
    .map(eventToApi);
}

export function signersOf(ctx: CrmContext, requestId: string): SignerRow[] {
  return ctx.db.all<SignerRow>(
    `SELECT * FROM esign_signers WHERE request_id = ? ORDER BY position, id`,
    requestId,
  );
}

/** Tenant facts the TenantDb alarm needs to build links and emails (it only knows its own storage). */
export interface TenantFacts {
  id: string;
  slug: string;
  name: string;
}

const TENANT_META_KEY = 'esign_tenant';

export function rememberTenant(ctx: CrmContext, tenant: TenantFacts | undefined): void {
  if (tenant === undefined) return;
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    TENANT_META_KEY,
    JSON.stringify({ id: tenant.id, slug: tenant.slug, name: tenant.name }),
  );
}

export function tenantFacts(ctx: CrmContext): TenantFacts | null {
  const row = ctx.db.all<{ value: string }>(
    `SELECT value FROM tenant_meta WHERE key = ?`,
    TENANT_META_KEY,
  )[0];
  const parsed = parseJson<Partial<TenantFacts>>(row?.value, {});
  return typeof parsed.id === 'string' && typeof parsed.slug === 'string'
    ? { id: parsed.id, slug: parsed.slug, name: parsed.name ?? parsed.slug }
    : null;
}
