import {
  DirectPostShibaAdmin,
  EmailProviderError,
  PostShibaAccount,
  PostShibaEmailMarketingProvider,
  postshibaDnsRecords,
  type PostShibaSenderStore,
  type PostShibaWorkspace,
  type PostShibaWorkspaceAdmin,
} from '@amable/core';
import { describe, expect, it } from 'vitest';

/** Real PostShiba responses (recorded 2026-10, names and keys redacted). */
const DOMAIN = {
  id: 'Dom001',
  name: 'mail.acme.test',
  tenant_id: 'Ten001',
  tenant: 'ws-acme',
  dkim_status: 'pending',
  return_path_status: 'pending',
  dmarc_status: 'pending',
  sending_allowed: false,
  dkim_selector: 'ps1',
  dkim_manual: false,
  dkim_txt: 'v=DKIM1; k=rsa; p=REDACTED',
  dkim_cname_host: 'ps1._domainkey.mail.acme.test',
  dkim_cname_target: '472.customers.postshiba.com',
  dmarc_host: '_dmarc.mail.acme.test',
  dmarc_record: 'v=DMARC1; p=none;',
  return_path_host: 'rp.mail.acme.test',
  return_path_target: 'rp.postshiba.com',
  last_verification_error: null,
  suspended: false,
  suspended_reason: null,
  operator_held: false,
  primary: false,
  queued_messages: 0,
  queue_flushed_at: null,
};
const VERIFIED = { ...DOMAIN, dkim_status: 'verified', return_path_status: 'verified', dmarc_status: 'verified', sending_allowed: true };
const TENANT = { id: 'Ten001', name: 'acme', slug: 'ws-acme', suspended: false };
const CREDENTIAL = { id: 'Cred01', username: 'smtp_42', password: 'pw-redacted', tenant_id: 'Ten001', tenant: 'ws-acme', cluster_id: 'Clu001' };
const ENDPOINT = {
  id: 'Hook01',
  url: 'https://crm.acme.test/hooks/email/postshiba/acme',
  enabled: true,
  cluster_id: null,
  tenant_id: 'Ten001',
  event_types: ['processed', 'delivered', 'deferred', 'bounce', 'dropped', 'spamreport', 'unsubscribe'],
  status: 'idle',
  secret: 'whsec-redacted',
};

type Handler = (body: unknown) => { status?: number; json: unknown } | Error;

/** Fake PostShiba routed on `METHOD url`; every call is recorded, unknown routes are 404. */
function postshiba(routes: Record<string, Handler | Handler[]>) {
  const calls: { key: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const key = `${init.method ?? 'GET'} ${url}`;
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: init.headers as Record<string, string> });
    const route = routes[key];
    const handler = Array.isArray(route) ? route.shift() : route;
    if (handler === undefined) return Promise.resolve(new Response('{"error":"not_found"}', { status: 404 }));
    const out = handler(body);
    if (out instanceof Error) return Promise.reject(out);
    return Promise.resolve(new Response(JSON.stringify(out.json), { status: out.status ?? 200 }));
  };
  return { fetch, calls, keys: () => calls.map((c) => c.key) };
}

const API = 'https://app.postshiba.com/api/v1';
const TEAM = `${API}/teams/Team01`;
const INJECT = 'https://inject.postshiba.com/api/inject/v1';

function memoryStore(): PostShibaSenderStore & { saved: Map<string, PostShibaWorkspace> } {
  const saved = new Map<string, PostShibaWorkspace>();
  return {
    saved,
    get: (id) => Promise.resolve(saved.get(id) ?? null),
    put: (_workspaceId, workspace) => {
      saved.set(workspace.providerTenantId, workspace);
      return Promise.resolve();
    },
  };
}

const unusedAdmin = {} as PostShibaWorkspaceAdmin;
const SENDER: PostShibaWorkspace = {
  providerTenantId: 'Ten001',
  smtp: { username: 'smtp_42', password: 'pw-redacted' },
  webhookSecret: 'whsec-redacted',
  injectUrl: null,
};

function sender(fetch: ReturnType<typeof postshiba>['fetch']) {
  const senders = memoryStore();
  senders.saved.set('Ten001', SENDER);
  return new PostShibaEmailMarketingProvider({ admin: unusedAdmin, senders, webhookUrl: () => '', fetch });
}

const email = {
  from: 'Acme News <news@mail.acme.test>',
  to: 'a@x.test',
  subject: 'Hi',
  html: '<p>Hi</p>',
  text: 'Hi',
  replyTo: 'help@acme.test',
  headers: { 'List-Unsubscribe': '<https://t/unsub/x>' },
  providerTenantId: 'Ten001',
  idempotencyKey: 'msg_1',
  metadata: { account: 'acme', amb_message_id: 'msg_1' },
};

describe('PostShiba sending (HTTP inject)', () => {
  it('injects with the workspace SMTP login, envelope sender and unique args', async () => {
    const ps = postshiba({ [`POST ${INJECT}`]: () => ({ json: { success_count: 1, fail_count: 0, failed_recipients: [], errors: [] } }) });
    expect(await sender(ps.fetch).sendEmail(email)).toEqual({ messageId: 'msg_1', accepted: true });
    const call = ps.calls[0];
    expect(call?.headers['authorization']).toBe(`Basic ${btoa('smtp_42:pw-redacted')}`);
    expect(call?.body).toEqual({
      envelope_sender: 'news@mail.acme.test',
      content: {
        text_body: 'Hi',
        html_body: '<p>Hi</p>',
        headers: {
          'List-Unsubscribe': '<https://t/unsub/x>',
          From: 'Acme News <news@mail.acme.test>',
          To: 'a@x.test',
          Subject: 'Hi',
          'Reply-To': 'help@acme.test',
          'X-Capsule-Unique-Args': JSON.stringify({ account: 'acme', amb_message_id: 'msg_1' }),
        },
      },
      recipients: [{ email: 'a@x.test' }],
    });
  });

  it('refuses to send before the workspace has a sender', async () => {
    const ps = postshiba({});
    const provider = new PostShibaEmailMarketingProvider({ admin: unusedAdmin, senders: memoryStore(), webhookUrl: () => '', fetch: ps.fetch });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ code: 'credential_missing', retryable: false });
    expect(ps.calls).toEqual([]);
  });

  it('maps refused recipients, error codes and timeouts', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const ps = postshiba({
      [`POST ${INJECT}`]: [
        () => ({ json: { success_count: 0, fail_count: 1, failed_recipients: ['a@x.test'], errors: ['550 5.1.1 recipient suppressed'] } }),
        () => ({ json: { success_count: 0, fail_count: 1, failed_recipients: ['a@x.test'], errors: [] } }),
        () => ({ status: 401, json: { error: 'unauthorized' } }),
        () => ({ status: 503, json: { error: 'inject_unavailable', retryable: true } }),
        () => ({ status: 429, json: { error: 'throttled', retryable: true } }),
        () => ({ status: 502, json: { error: 'inject_timeout_unknown', retryable: false } }),
        () => ({ status: 403, json: { error: 'domain_unverified', field: 'from', message: 'must be a verified sending domain' } }),
        () => timeout,
        () => new Error('offline'),
      ],
    });
    const provider = sender(ps.fetch);
    const expected = [
      { code: 'suppressed', retryable: false },
      { code: 'inject_failed', retryable: false },
      { status: 401, retryable: false },
      { code: 'inject_unavailable', retryable: true },
      { code: 'throttled', retryable: true },
      { code: 'outcome_unknown', retryable: false },
      { code: 'domain_unverified', retryable: false, message: 'must be a verified sending domain' },
      { code: 'outcome_unknown', retryable: false },
      { retryable: true, message: 'network error: offline' },
    ];
    for (const e of expected) {
      const error = await provider.sendEmail(email).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(EmailProviderError);
      expect(error).toMatchObject(e);
    }
  });
});

describe('PostShiba workspace on an own account', () => {
  const account = (fetch: ReturnType<typeof postshiba>['fetch']) => new PostShibaAccount({ apiKey: 'team-key', teamId: 'Team01', fetch });

  it('creates tenant, SMTP credential and tenant webhook once, and stores the sender', async () => {
    const ps = postshiba({
      [`GET ${TEAM}/tenants`]: [() => ({ json: [] }), () => ({ json: [TENANT] })],
      [`POST ${TEAM}/tenants`]: () => ({ status: 201, json: TENANT }),
      [`POST ${TEAM}/clusters/Clu001/smtp_credentials`]: () => ({ status: 201, json: CREDENTIAL }),
      [`GET ${TEAM}/webhook_endpoints`]: [() => ({ json: [] }), () => ({ json: [{ ...ENDPOINT, secret: undefined }] })],
      [`POST ${TEAM}/webhook_endpoints`]: () => ({ status: 201, json: ENDPOINT }),
      [`GET ${API}/webhook_endpoints/Hook01`]: () => ({ json: ENDPOINT }),
    });
    const senders = memoryStore();
    const provider = new PostShibaEmailMarketingProvider({
      admin: new DirectPostShibaAdmin(account(ps.fetch), { clusterId: 'Clu001' }),
      senders,
      webhookUrl: (id) => `https://crm.acme.test/hooks/email/postshiba/${id}`,
      fetch: ps.fetch,
    });
    expect(await provider.createTenant('acme', 'ACME')).toEqual({ providerTenantId: 'Ten001', name: 'acme' });
    expect(senders.saved.get('Ten001')).toEqual(SENDER);
    expect(ps.calls[0]?.headers['authorization']).toBe('Bearer team-key');
    expect(ps.calls.find((c) => c.key === `POST ${TEAM}/tenants`)?.body).toEqual({ tenant: { name: 'acme', slug: 'ws-acme' } });
    expect(ps.calls.find((c) => c.key.endsWith('/smtp_credentials'))?.body).toEqual({ smtp_credential: { tenant_id: 'Ten001' } });
    expect(ps.calls.find((c) => c.key === `POST ${TEAM}/webhook_endpoints`)?.body).toEqual({
      webhook_endpoint: { url: 'https://crm.acme.test/hooks/email/postshiba/ACME', tenant_id: 'Ten001', enabled: true, event_types: ENDPOINT.event_types },
    });

    await provider.createTenant('acme', 'acme');
    const creates = ps.keys().filter((k) => k === `POST ${TEAM}/tenants` || k === `POST ${TEAM}/webhook_endpoints`);
    expect(creates).toEqual([`POST ${TEAM}/tenants`, `POST ${TEAM}/webhook_endpoints`]);
  });

  it('adds, verifies and removes a sending domain of the tenant only', async () => {
    const ps = postshiba({
      [`GET ${TEAM}/sending_domains`]: [() => ({ json: [] }), () => ({ json: [DOMAIN] }), () => ({ json: [{ ...DOMAIN, tenant_id: 'Other1' }] }), () => ({ json: [DOMAIN] })],
      [`POST ${TEAM}/sending_domains`]: () => ({ status: 201, json: DOMAIN }),
      [`POST ${API}/sending_domains/Dom001/verify`]: () => ({ json: VERIFIED }),
      [`DELETE ${API}/sending_domains/Dom001`]: () => ({ json: {} }),
    });
    const admin = new DirectPostShibaAdmin(account(ps.fetch), { clusterId: 'Clu001' });
    expect(await admin.addDomain('Ten001', 'mail.acme.test')).toEqual({
      domain: 'mail.acme.test',
      status: 'pending',
      records: [
        { type: 'CNAME', name: 'ps1._domainkey.mail.acme.test', value: '472.customers.postshiba.com' },
        { type: 'CNAME', name: 'rp.mail.acme.test', value: 'rp.postshiba.com' },
        { type: 'TXT', name: '_dmarc.mail.acme.test', value: 'v=DMARC1; p=none;', unlessPrefix: 'v=DMARC1' },
      ],
    });
    expect(ps.calls.find((c) => c.key === `POST ${TEAM}/sending_domains`)?.body).toEqual({
      sending_domain: { name: 'mail.acme.test', tenant_id: 'Ten001' },
    });
    expect((await admin.verifyDomain('Ten001', 'mail.acme.test')).status).toBe('verified');
    await expect(admin.addDomain('Ten001', 'mail.acme.test')).rejects.toMatchObject({ code: 'hostname_taken', status: 409 });
    await admin.removeDomain('Ten001', 'MAIL.acme.test');
    expect(ps.keys()).toContain(`DELETE ${API}/sending_domains/Dom001`);
  });

  it('publishes the DKIM key as TXT when it is imported', () => {
    const manual = { ...DOMAIN, dkim_manual: true };
    const records = postshibaDnsRecords({
      id: manual.id,
      name: manual.name,
      tenantId: manual.tenant_id,
      dkimStatus: 'pending',
      returnPathStatus: 'pending',
      dmarcStatus: 'pending',
      sendingAllowed: false,
      dkimManual: true,
      dkimTxt: manual.dkim_txt,
      dkimCnameHost: manual.dkim_cname_host,
      dkimCnameTarget: manual.dkim_cname_target,
      dmarcHost: manual.dmarc_host,
      dmarcRecord: manual.dmarc_record,
      returnPathHost: manual.return_path_host,
      returnPathTarget: manual.return_path_target,
      lastVerificationError: null,
      suspended: false,
    });
    expect(records[0]).toEqual({ type: 'TXT', name: 'ps1._domainkey.mail.acme.test', value: 'v=DKIM1; k=rsa; p=REDACTED' });
  });

  it('fails permanently without team key or team id', async () => {
    const ps = postshiba({});
    await expect(new PostShibaAccount({ apiKey: '', teamId: 'Team01', fetch: ps.fetch }).listTenants()).rejects.toMatchObject({ retryable: false });
    expect(ps.calls).toEqual([]);
  });
});
