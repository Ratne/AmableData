import type { BroadcastSegment, Contact } from '@amable/api-types';
import type {
  EmailMarketingProvider,
  EmailSendRequest,
  QuotaGuard,
} from '@amable/core';
import type { SqlDb } from '../crm/db/sql';
import type { BridgedEmailEvent } from '../crm/email-events';
import type { MailRecipientFacts, MailSendContact } from '../crm/mail-reads';

/**
 * Dependencies of the email domain. The MailDb DO builds them from its env
 * (TenantDb RPC, D1, queue, provider); tests build them over node:sqlite with
 * fakes. Nothing in the domain touches the DO or Workers APIs directly.
 */

/** Read access to the tenant CRM (TenantDb RPC ops `mail.*`) + the marketable status write and the event bridge. */
export interface CrmReader {
  segmentMemberIds(segment: BroadcastSegment): Promise<string[]>;
  /** At most 500 ids per call. */
  recipientFacts(ids: string[]): Promise<MailRecipientFacts[]>;
  /** At most 500 ids per call; deleted contacts are omitted. */
  contactsForSend(ids: string[]): Promise<MailSendContact[]>;
  setMarketableStatus(contactId: string, status: Contact['marketable_status']): Promise<void>;
  /** Email events into the CRM outbox + timeline (TenantDb `mail.recordEvents`, at most 200). */
  recordEvents(events: BridgedEmailEvent[]): Promise<{ recorded: number }>;
  /** A transactional email was skipped or failed for good: its module records it (e-signature audit trail). */
  transactionalUndelivered?(input: {
    purpose: string;
    referenceId: string;
    email: string;
    reason: string;
  }): Promise<void>;
}

export interface TenantUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

/** Tenant members (test sends go to members only) and owner details for Liquid. */
export interface UserDirectory {
  members(userIds: readonly string[]): Promise<TenantUser[]>;
  users(userIds: readonly string[]): Promise<TenantUser[]>;
}

export interface SendingDomain {
  readonly hostname: string;
  readonly kind: string;
  readonly status: string;
}

/** Sending-domain state of the tenant (plan rule: no sending before verification). */
export interface SendingState {
  readonly state: 'verified' | 'unverified' | 'dev_override';
  readonly domains: readonly SendingDomain[];
  /** Origin of the tracking/unsubscribe links (verified tracking domain or the edge default). */
  readonly trackingOrigin: string;
  /** Provider tenant backing this CRM tenant (managed offering), if provisioned. */
  readonly providerTenantId: string | null;
}

export interface EmailQueue {
  send(requests: readonly EmailSendRequest[]): Promise<void>;
}

/** Wakes the automation Engine DO after bridged email events landed in the CRM outbox. */
export interface AutomationSink {
  kick(): Promise<void>;
}

export interface MailDeps {
  readonly db: SqlDb;
  readonly tenantId: string;
  readonly now: () => number;
  readonly newId: () => string;
  readonly crm: CrmReader;
  readonly users: UserDirectory;
  readonly provider: EmailMarketingProvider;
  readonly queue: EmailQueue;
  readonly quota: QuotaGuard;
  readonly sending: () => Promise<SendingState>;
  /** First secret signs; all verify (rotation). */
  readonly tokenSecrets: readonly string[];
  readonly automation: AutomationSink | null;
  /** Arms the DO alarm (broadcast scheduler, outbox bridge) at `at` epoch ms, keeping an earlier one. */
  readonly scheduleAlarm: (at: number) => Promise<void>;
}

export interface MailErrorShape {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class MailError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }

  toShape(): MailErrorShape {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const notFound = (what: string, id: string): MailError =>
  new MailError('not_found', 404, `${what} ${id} not found`);

export function toIso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Durable Object SQLite binds at most 100 parameters per statement: IN lists go in chunks. */
export const SQL_IN_CHUNK = 90;

export function chunked<T>(items: readonly T[], size: number = SQL_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function encodeCursor(parts: readonly (string | number)[]): string {
  return btoa(JSON.stringify(parts)).replace(/=+$/, '');
}

export function decodeCursor(cursor: string | undefined): (string | number)[] | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(atob(cursor));
    return Array.isArray(parsed) &&
      parsed.every((p) => typeof p === 'string' || typeof p === 'number')
      ? (parsed as (string | number)[])
      : null;
  } catch {
    return null;
  }
}
