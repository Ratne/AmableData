import {
  addressSchema,
  contactEmailSchema,
  contactPhoneSchema,
  type AddressInput,
  type CreateContactInput,
  type UpdateContactInput,
} from '@amable/api-types';
import { sha256HexSync, type RegistryMessage } from '@amable/app-edge/analytics';
import { encodeTime } from 'ulid';
import type { CrmContext } from '../crm/context';
import {
  backfillIdentityHashes,
  emailHash,
  phoneHash,
  recordIdentityHash as recordHash,
  type IdentityHashKind,
} from '../crm/identity-hashes';
import { createContact, updateContact } from '../crm/contacts';
import { mergeAddresses, mergeEmails, mergePhones } from '../crm/import/service';

/**
 * Workspace registry of the web contact data (TenantDb operations, spread
 * into `crmOps`). The edge splits clear emails, phones and profile fields off
 * the analytics events; here they create or enrich contacts, and their hashes
 * index the contact so the sites' hashed identities resolve.
 */

export interface RegistrationResult {
  eid: string;
  contactId: string | null;
  created: boolean;
}

/** Registrations older than this are forgotten (queue retries and replays are far shorter). */
const APPLIED_TTL_MS = 30 * 86_400_000;

const NAME_FIELDS = ['given_name', 'family_name'] as const;
type NameField = (typeof NAME_FIELDS)[number];

/** Live contact a (possibly merged) contact id ends at, or null when deleted. */
function liveContact(ctx: CrmContext, id: string): string | null {
  let current = id;
  for (let hop = 0; hop < 10; hop += 1) {
    const row = ctx.db.all<{ merged_into_id: string | null; deleted_at: number | null }>(
      `SELECT merged_into_id, deleted_at FROM crm_contacts WHERE id = ?`,
      current,
    )[0];
    if (row === undefined) return null;
    if (row.merged_into_id !== null) {
      current = row.merged_into_id;
      continue;
    }
    return row.deleted_at === null ? current : null;
  }
  return null;
}

function contactByEmail(ctx: CrmContext, email: string): string | null {
  const row = ctx.db.all<{ id: string }>(
    `SELECT c.id FROM crm_contact_emails e JOIN crm_contacts c ON c.id = e.contact_id
     WHERE e.email_normalized = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id LIMIT 1`,
    email,
  )[0];
  return row === undefined ? null : liveContact(ctx, row.id);
}

function contactByPhone(ctx: CrmContext, e164: string): string | null {
  const row = ctx.db.all<{ id: string }>(
    `SELECT c.id FROM crm_contact_phones p JOIN crm_contacts c ON c.id = p.contact_id
     WHERE p.number_digits = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id LIMIT 1`,
    e164.replace(/\D/g, ''),
  )[0];
  return row === undefined ? null : liveContact(ctx, row.id);
}

function namesOf(profile: RegistryMessage['profile']): Partial<Record<NameField, string>> {
  const out: Partial<Record<NameField, string>> = {};
  if (profile.given_name !== undefined) out.given_name = profile.given_name.slice(0, 100);
  if (profile.family_name !== undefined) out.family_name = profile.family_name.slice(0, 100);
  if (
    profile.full_name !== undefined &&
    out.given_name === undefined &&
    out.family_name === undefined
  ) {
    const [first, ...rest] = profile.full_name.trim().split(/\s+/);
    if (first !== undefined && first !== '') out.given_name = first.slice(0, 100);
    if (rest.length > 0) out.family_name = rest.join(' ').slice(0, 100);
  }
  return out;
}

function addressOf(profile: RegistryMessage['profile']): AddressInput | null {
  const country = profile.country?.trim().toUpperCase();
  const candidate = {
    type: 'other' as const,
    ...(profile.street !== undefined || profile.address !== undefined
      ? { line1: (profile.street ?? profile.address ?? '').slice(0, 255) }
      : {}),
    ...(profile.city !== undefined ? { locality: profile.city.slice(0, 100) } : {}),
    ...(profile.region !== undefined ? { region: profile.region.slice(0, 100) } : {}),
    ...(profile.postal_code !== undefined ? { postal_code: profile.postal_code.slice(0, 20) } : {}),
    ...(country !== undefined && /^[A-Z]{2}$/.test(country) ? { country_code: country } : {}),
  };
  if (Object.keys(candidate).length === 1) return null;
  const parsed = addressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Name fields the registration may write: empty ones, and ones the registry
 * itself wrote earlier (same value still there) from an older event. A value
 * typed by a person is never overwritten.
 */
function writableNames(
  ctx: CrmContext,
  contactId: string,
  names: Partial<Record<NameField, string>>,
  ts: number,
): Partial<Record<NameField, string>> {
  const row = ctx.db.all<Record<NameField, string | null>>(
    `SELECT given_name, family_name FROM crm_contacts WHERE id = ?`,
    contactId,
  )[0];
  const out: Partial<Record<NameField, string>> = {};
  for (const field of NAME_FIELDS) {
    const next = names[field];
    if (next === undefined) continue;
    const current = row?.[field] ?? null;
    if (current === next) continue;
    if (current === null || current === '') {
      out[field] = next;
      continue;
    }
    const web = ctx.db.all<{ ts: number; value: string | null }>(
      `SELECT ts, value FROM crm_web_fields WHERE contact_id = ? AND field = ?`,
      contactId,
      field,
    )[0];
    if (web !== undefined && web.value === current && web.ts < ts) out[field] = next;
  }
  return out;
}

function recordWebFields(
  ctx: CrmContext,
  contactId: string,
  names: Partial<Record<NameField, string>>,
  ts: number,
): void {
  for (const [field, value] of Object.entries(names)) {
    ctx.db.run(
      `INSERT INTO crm_web_fields (contact_id, field, ts, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (contact_id, field) DO UPDATE SET ts = excluded.ts, value = excluded.value`,
      contactId,
      field,
      ts,
      value,
    );
  }
}

/** Opted-out / erased people are never registered again from the web. */
function suppressed(
  ctx: CrmContext,
  entry: RegistryMessage,
  email: string | null,
  phone: string | null,
): boolean {
  const probes: Array<[string, string | null]> = [
    ['visitor', entry.visitorId],
    ['email', email === null ? null : emailHash(email)],
    ['phone', phone === null ? null : phoneHash(phone)],
  ];
  return probes.some(
    ([kind, value]) =>
      value !== null &&
      ctx.db.all(
        `SELECT 1 AS x FROM crm_web_suppressions WHERE kind = ? AND value = ?`,
        kind,
        value,
      ).length > 0,
  );
}

function registerOne(
  ctx: CrmContext,
  entry: RegistryMessage,
  linkedContact: string | null,
): RegistrationResult {
  const done = ctx.db.all<{ contact_id: string | null }>(
    `SELECT contact_id FROM crm_registry_applied WHERE eid = ?`,
    entry.eid,
  )[0];
  if (done !== undefined) return { eid: entry.eid, contactId: done.contact_id, created: false };

  const email =
    entry.email !== null && contactEmailSchema.safeParse({ email: entry.email }).success
      ? entry.email
      : null;
  const phone =
    entry.phone !== null && contactPhoneSchema.safeParse({ number: entry.phone }).success
      ? entry.phone
      : null;
  if (suppressed(ctx, entry, email, phone)) {
    ctx.db.run(
      `INSERT INTO crm_registry_applied (eid, contact_id, applied_at) VALUES (?, NULL, ?)`,
      entry.eid,
      ctx.now(),
    );
    return { eid: entry.eid, contactId: null, created: false };
  }
  const names = namesOf(entry.profile);
  const address = addressOf(entry.profile);

  let contactId =
    (email === null ? null : contactByEmail(ctx, email)) ??
    (phone === null ? null : contactByPhone(ctx, phone)) ??
    (linkedContact === null ? null : liveContact(ctx, linkedContact));
  let created = false;
  if (contactId === null && (email !== null || phone !== null)) {
    const input: CreateContactInput = {
      ...names,
      source_type: entry.source === 'lead' || entry.source === 'sale' ? 'api' : 'web',
      ...(email === null ? {} : { emails: [{ email }] }),
      ...(phone === null ? {} : { phones: [{ number: phone }] }),
      ...(address === null ? {} : { addresses: [address] }),
    };
    contactId = createContact(ctx, input, { lenient: true, requireAll: false }).id;
    recordWebFields(ctx, contactId, names, entry.ts);
    created = true;
  } else if (contactId !== null) {
    const update: UpdateContactInput = {};
    const writable = writableNames(ctx, contactId, names, entry.ts);
    Object.assign(update, writable);
    if (email !== null && contactByEmail(ctx, email) !== contactId) {
      update.emails = mergeEmails(ctx, contactId, [{ email }]);
    }
    if (phone !== null && contactByPhone(ctx, phone) !== contactId) {
      update.phones = mergePhones(ctx, contactId, [{ number: phone }]);
    }
    if (address !== null) {
      const merged = mergeAddresses(ctx, contactId, [address]);
      const count = ctx.db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM crm_contact_addresses WHERE contact_id = ?`,
        contactId,
      )[0]?.n;
      if (merged.length !== count) update.addresses = merged;
    }
    if (Object.keys(update).length > 0) {
      updateContact(ctx, { id: contactId, data: update }, { lenient: true, requireAll: false });
      recordWebFields(ctx, contactId, writable, entry.ts);
    }
  }
  if (contactId !== null) {
    recordHash(ctx, 'email', email === null ? null : emailHash(email), contactId);
    recordHash(ctx, 'phone', phone === null ? null : phoneHash(phone), contactId);
  }
  ctx.db.run(
    `INSERT INTO crm_registry_applied (eid, contact_id, applied_at) VALUES (?, ?, ?)`,
    entry.eid,
    contactId,
    ctx.now(),
  );
  return { eid: entry.eid, contactId, created };
}

/**
 * Applies registry messages (idempotent per event id). `linked` maps visitor
 * ids already linked to a contact: profile-only data (a name, no email or
 * phone) enriches that contact; without one it is dropped.
 */
function registerIdentities(
  ctx: CrmContext,
  input: { entries: RegistryMessage[]; linked?: Record<string, string> },
): RegistrationResult[] {
  ctx.db.run(`DELETE FROM crm_registry_applied WHERE applied_at < ?`, ctx.now() - APPLIED_TTL_MS);
  const linked = input.linked ?? {};
  return [...input.entries]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => registerOne(ctx, e, e.visitorId === null ? null : (linked[e.visitorId] ?? null)));
}

/** Live contacts of identity hashes (the hashed identify keys of the sites). */
function contactsByIdentityHash(
  ctx: CrmContext,
  input: { items: Array<{ kind: IdentityHashKind; hash: string }> },
): Array<{ kind: IdentityHashKind; hash: string; contactId: string }> {
  const out: Array<{ kind: IdentityHashKind; hash: string; contactId: string }> = [];
  for (const item of input.items.slice(0, 500)) {
    const row = ctx.db.all<{ contact_id: string }>(
      `SELECT contact_id FROM crm_identity_hashes WHERE kind = ? AND hash = ?`,
      item.kind,
      item.hash,
    )[0];
    const contactId = row === undefined ? null : liveContact(ctx, row.contact_id);
    if (contactId !== null) out.push({ kind: item.kind, hash: item.hash, contactId });
  }
  return out;
}

/** Indexes the hashes of contacts' emails and phones (contacts linked by the sync). */
function recordIdentityHashes(
  ctx: CrmContext,
  input: { items: Array<{ kind: IdentityHashKind; hash: string; contactId: string }> },
): void {
  for (const item of input.items.slice(0, 2000))
    recordHash(ctx, item.kind, item.hash, item.contactId);
}

/** Compact web facts of identified visitors, materialized as the contact's permanent journey. */
export interface WebTimelineItem {
  kind: 'linked' | 'goal' | 'pageview';
  contactId: string;
  visitorId: string;
  sessionId: string | null;
  name: string | null;
  hostname: string | null;
  path: string | null;
  /** Link source (`identify`, `form`…) of a `linked` item. */
  source?: string | undefined;
  ts: number;
}

/** Distinct paths remembered per session row (pages beyond it are still counted). */
const SESSION_PATHS_MAX = 100;

/** Time-ordered activity id (sorts like the ULIDs of the timeline), stable for the same key. */
function webActivityId(ts: number, key: string): string {
  return `${encodeTime(Math.max(0, Math.floor(ts)), 10)}${sha256HexSync(key).slice(0, 16).toUpperCase()}`;
}

function insertWebActivity(
  ctx: CrmContext,
  id: string,
  type: string,
  contactId: string,
  data: object,
  ts: number,
): void {
  ctx.db.run(
    `INSERT INTO crm_activities (id, type, contact_id, company_id, opportunity_id, actor_type, actor_id, data, occurred_at)
     VALUES (?, ?, ?, NULL, NULL, 'system', NULL, ?, ?) ON CONFLICT (id) DO NOTHING`,
    id,
    type,
    contactId,
    JSON.stringify(data),
    ts,
  );
}

/**
 * Timeline rows of the web journey, bounded by design: one row per link, per
 * goal and per session (pages counted into it), never one per raw event.
 * They outlive the sites' hot window. Idempotent (stable ids, session rows
 * keyed by session id).
 */
function recordWebTimeline(
  ctx: CrmContext,
  input: { siteId: string; items: WebTimelineItem[] },
): number {
  let written = 0;
  for (const item of input.items.slice(0, 1000)) {
    const contactId = liveContact(ctx, item.contactId);
    if (contactId === null) continue;
    const base = { siteId: input.siteId, visitorId: item.visitorId };
    if (item.kind === 'linked') {
      const id = webActivityId(item.ts, `link:${input.siteId}:${item.visitorId}:${contactId}`);
      insertWebActivity(
        ctx,
        id,
        'web.linked',
        contactId,
        { ...base, source: item.source ?? null },
        item.ts,
      );
    } else if (item.kind === 'goal' && item.name !== null) {
      const id = webActivityId(
        item.ts,
        `goal:${input.siteId}:${item.visitorId}:${item.name}:${item.ts}`,
      );
      const type = item.name === 'payment' ? 'web.payment' : 'web.goal';
      insertWebActivity(
        ctx,
        id,
        type,
        contactId,
        { ...base, goal: item.name, path: item.path },
        item.ts,
      );
    } else if (item.kind === 'pageview' && item.sessionId !== null) {
      const existing = ctx.db.all<{ id: string; data: string }>(
        `SELECT id, data FROM crm_activities WHERE contact_id = ? AND type = 'web.session'
           AND json_extract(data, '$.sessionId') = ? LIMIT 1`,
        contactId,
        item.sessionId,
      )[0];
      if (existing === undefined) {
        const data = {
          ...base,
          sessionId: item.sessionId,
          hostname: item.hostname,
          landing: item.path,
          lastPath: item.path,
          pages: 1,
          paths: item.path === null ? [] : [item.path],
          lastAt: item.ts,
        };
        insertWebActivity(
          ctx,
          webActivityId(item.ts, `session:${item.sessionId}`),
          'web.session',
          contactId,
          data,
          item.ts,
        );
      } else {
        const data = JSON.parse(existing.data) as {
          pages?: number;
          paths?: string[];
          lastAt?: number;
        };
        const paths = data.paths ?? [];
        // The site queues one item per page and session: a path already counted is a redelivery.
        if (item.path === null || paths.includes(item.path)) continue;
        const later = item.ts >= (data.lastAt ?? 0);
        ctx.db.run(
          `UPDATE crm_activities SET data = ? WHERE id = ?`,
          JSON.stringify({
            ...data,
            pages: (data.pages ?? 1) + 1,
            paths: paths.length < SESSION_PATHS_MAX ? [...paths, item.path] : paths,
            ...(later ? { lastPath: item.path, lastAt: item.ts } : {}),
          }),
          existing.id,
        );
      }
    } else {
      continue;
    }
    written += 1;
  }
  return written;
}

export const registryCrmOps = {
  'analytics.recordWebTimeline': recordWebTimeline,
  'analytics.registerIdentities': registerIdentities,
  'analytics.contactsByIdentityHash': contactsByIdentityHash,
  'analytics.recordIdentityHashes': recordIdentityHashes,
  'analytics.backfillIdentityHashes': backfillIdentityHashes,
};
