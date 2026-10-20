import type { Contact } from '@amable/api-types';
import {
  allowAllQuotaGuard,
  FakeEmailMarketingProvider,
  type EmailSendRequest,
  type QuotaGuard,
} from '@amable/core';
import { monotonicFactory } from 'ulid';
import type { MailRecipientFacts, MailSendContact } from '../../src/crm/mail-reads';
import type { MailDeps, SendingState, TenantUser } from '../../src/email/context';
import { mailMigrations } from '../../src/email/db/migrations';
import { runMailOp, type MailOpInput, type MailOpName, type MailOpOutput } from '../../src/email/ops';
import type { Env } from '../../src/env';
import { createNodeSqlDb, createTestTenant, type TestTenant } from '../crm/helpers';

export const TENANT_ID = 'tenant_acme';
export const SECRET = 'test-email-secret';
export const ORIGIN = 'https://t.acme.test';

export interface MailWorld {
  deps: MailDeps;
  crm: TestTenant;
  provider: FakeEmailMarketingProvider;
  queue: EmailSendRequest[];
  /** Engine kicks requested by the outbox bridge. */
  kicks: { count: number };
  alarms: number[];
  clock: { now: number };
  sending: { current: SendingState };
  quota: { current: QuotaGuard };
  members: TenantUser[];
  op<K extends MailOpName>(op: K, input: MailOpInput<K>): Promise<MailOpOutput<K>>;
  /** Runs an op expecting a domain error; returns its shape. */
  fail(op: MailOpName, input: unknown): Promise<{ code: string; status: number; message: string }>;
  contact(input: { email?: string | null; given?: string; tz?: string | null; tags?: string[] }): string;
  /** Drains the in-memory queue through the pipeline (one batch). */
  drain(): Promise<void>;
}

/** Durable Object SQLite rejects statements with more than 100 bound parameters: mirror it in tests. */
function enforceParamLimit(db: { all: (q: string, ...p: never[]) => unknown; run: (q: string, ...p: never[]) => void }): void {
  const all = db.all.bind(db);
  const run = db.run.bind(db);
  const check = (params: unknown[]) => {
    if (params.length > 100) throw new Error(`too many SQL parameters: ${String(params.length)}`);
  };
  db.all = ((query: string, ...params: never[]) => {
    check(params);
    return all(query, ...params);
  }) as typeof db.all;
  db.run = ((query: string, ...params: never[]) => {
    check(params);
    run(query, ...params);
  }) as typeof db.run;
}

export function verifiedSending(): SendingState {
  return {
    state: 'verified',
    domains: [
      { hostname: 'acme.test', kind: 'sending', status: 'verified' },
      { hostname: 't.acme.test', kind: 'tracking', status: 'verified' },
    ],
    trackingOrigin: ORIGIN,
    providerTenantId: 'ps_acme',
  };
}

export function createMailWorld(options: { verified?: boolean } = {}): MailWorld {
  const nextUlid = monotonicFactory();
  const db = createNodeSqlDb();
  for (const migration of mailMigrations) {
    for (const statement of migration.statements) db.raw.exec(statement);
  }
  const crm = createTestTenant();
  enforceParamLimit(db);
  enforceParamLimit(crm.db);
  const clock = { now: Date.UTC(2026, 9, 15, 12, 0, 0) };
  crm.clock.now = clock.now;
  const provider = new FakeEmailMarketingProvider();
  const queue: EmailSendRequest[] = [];
  const kicks = { count: 0 };
  const alarms: number[] = [];
  const sending = { current: options.verified === false ? { ...verifiedSending(), state: 'unverified' as const, domains: [] } : verifiedSending() };
  const quota = { current: allowAllQuotaGuard };
  const members: TenantUser[] = [
    { id: 'user_owner', email: 'owner@acme.test', name: 'Olivia Owner' },
    { id: 'user_mkt', email: 'marketer@acme.test', name: 'Mark Eter' },
  ];
  // CRM ops through the test tenant, cloned like the RPC boundary.
  const runCrm = <T>(op: string, input: unknown): T =>
    structuredClone(crm.op(op as never, structuredClone(input) as never)) as T;

  const deps: MailDeps = {
    db,
    tenantId: TENANT_ID,
    now: () => clock.now,
    newId: () => nextUlid(clock.now),
    crm: {
      segmentMemberIds: (segment) => Promise.resolve(runCrm<string[]>('mail.segmentMemberIds', { segment })),
      recipientFacts: (ids) => Promise.resolve(runCrm<MailRecipientFacts[]>('mail.recipientFacts', { ids })),
      contactsForSend: (ids) => Promise.resolve(runCrm<MailSendContact[]>('mail.contactsForSend', { ids })),
      setMarketableStatus: (contactId: string, status: Contact['marketable_status']) => {
        runCrm('contacts.update', { id: contactId, data: { marketable_status: status } });
        return Promise.resolve();
      },
      recordEvents: (events) => Promise.resolve(runCrm<{ recorded: number }>('mail.recordEvents', { events })),
    },
    users: {
      members: (ids) => Promise.resolve(members.filter((m) => ids.includes(m.id))),
      users: (ids) => Promise.resolve(members.filter((m) => ids.includes(m.id))),
    },
    provider,
    queue: {
      send(requests) {
        queue.push(...structuredClone([...requests]));
        return Promise.resolve();
      },
    },
    quota: {
      check: (input) => quota.current.check(input),
      ratePerMinute: () => quota.current.ratePerMinute?.() ?? Promise.resolve(null),
    },
    sending: () => Promise.resolve(sending.current),
    tokenSecrets: [SECRET],
    automation: {
      kick() {
        kicks.count += 1;
        return Promise.resolve();
      },
    },
    scheduleAlarm: (at) => {
      alarms.push(at);
      return Promise.resolve();
    },
  };

  const world: MailWorld = {
    deps,
    crm,
    provider,
    queue,
    kicks,
    alarms,
    clock,
    sending,
    quota,
    members,
    async op(op, input) {
      const result = await runMailOp(deps, op, structuredClone(input));
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      return result.value as never;
    },
    async fail(op, input) {
      const result = await runMailOp(deps, op, structuredClone(input));
      if (result.ok) throw new Error(`expected ${op} to fail`);
      return result.error;
    },
    contact({ email = 'ada@example.com', given = 'Ada', tz = null, tags = [] }) {
      const tagIds = tags.map((name) => {
        const existing = runCrm<{ data: { id: string; name: string }[] }>('tags.list', { limit: 200 }).data.find(
          (t) => t.name === name,
        );
        return existing?.id ?? runCrm<{ id: string }>('tags.create', { name }).id;
      });
      const created = runCrm<{ id: string }>('contacts.create', {
        given_name: given,
        ...(email === null ? {} : { emails: [{ email }] }),
        ...(tz === null ? {} : { time_zone: tz }),
        ...(tagIds.length === 0 ? {} : { tag_ids: tagIds }),
      });
      return created.id;
    },
    async drain() {
      const batch = queue.splice(0, queue.length).map((request) => ({ request, queueAttempts: 1 }));
      await world.op('send.process', { batch });
    },
  };
  return world;
}

/** A small email document with two links, a Liquid field and a footer. */
export function sampleDoc(): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hi ' },
          {
            type: 'liquidVariable',
            attrs: { path: 'contact.first_name', label: 'First name', fallback: 'there', filter: null },
          },
          { type: 'text', text: ', read ' },
          { type: 'text', text: 'our news', marks: [{ type: 'link', attrs: { href: 'https://example.com/news?a=1&b=2' } }] },
        ],
      },
      {
        type: 'emailButton',
        attrs: { label: 'Shop', href: 'https://shop.example.com/', align: 'center', backgroundColor: '#2563eb', textColor: '#ffffff' },
      },
      { type: 'emailFooter', attrs: { unsubscribeLabel: 'Unsubscribe' }, content: [] },
    ],
  };
}

/** Minimal settings so real sends pass the gate. */
export async function configureSender(world: MailWorld): Promise<void> {
  await world.op('settings.update', {
    from_name: 'Acme',
    from_email: 'news@acme.test',
    physical_address: 'Acme Srl, Via Roma 1, Milano',
  });
}

export function sendRequest(
  contactId: string,
  overrides: Partial<EmailSendRequest> = {},
): EmailSendRequest {
  return {
    kind: 'email.send',
    version: 1,
    id: overrides.id ?? `req_${contactId}`,
    tenantId: TENANT_ID,
    contactId,
    content: {
      templateId: null,
      subject: 'Hello {{ contact.first_name }}',
      preheader: null,
      body: sampleDoc(),
      fromName: null,
      replyTo: null,
    },
    source: { type: 'single', userId: 'user_owner' },
    requestedAt: new Date(Date.UTC(2026, 9, 15, 12)).toISOString(),
    notAfter: null,
    ...overrides,
  };
}

/** In-memory MAIL_DB namespace for HTTP tests: one MailWorld per tenant id. */
export function fakeMailDbNamespace(): { namespace: Env['MAIL_DB']; worlds: Map<string, MailWorld> } {
  const worlds = new Map<string, MailWorld>();
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let world = worlds.get(id);
      if (world === undefined) {
        world = createMailWorld();
        worlds.set(id, world);
      }
      const current = world;
      return {
        mail: async (tenantId: string, op: string, input: unknown) =>
          structuredClone(await runMailOp({ ...current.deps, tenantId }, op, structuredClone(input))),
      };
    },
  };
  return { namespace: namespace as unknown as Env['MAIL_DB'], worlds };
}
