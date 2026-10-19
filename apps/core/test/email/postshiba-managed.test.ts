import { hmacSha256Hex } from '@amable/auth';
import type { EmailDomainResponse, EmailWorkspaceResponse } from '@amable/core/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { domainService } from '../../src/domains/runtime';
import { postshibaSenderStore, workspaceWebhookSecret } from '../../src/email/postshiba-senders';
import { emailPublicApp } from '../../src/email/public';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';
import { fakeControlPlane, license, type FakeControlPlane } from '../platform/link/helpers';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const WORKSPACE: EmailWorkspaceResponse = {
  providerTenantId: 'Ten001',
  smtp: { username: 'smtp_42', password: 'pw-secret-value' },
  webhookSecret: 'whsec-workspace',
  injectUrl: 'https://inject.postshiba.com/api/inject/v1',
};
const PENDING: EmailDomainResponse = {
  domain: 'mail.acme.test',
  status: 'pending',
  records: [{ type: 'CNAME', name: 'rp.mail.acme.test', value: 'rp.postshiba.com' }],
};

let h: Harness;
let cp: FakeControlPlane;

beforeEach(async () => {
  h = await createHarness();
  await seedTenant(h, 'acme');
  license(h.env);
  Object.assign(h.env, { ENVIRONMENT: 'staging', APP_ORIGIN: 'https://crm.acme.test' });
  cp = fakeControlPlane(() => h.clock.now);
  cp.routes['POST /v1/installation/email/workspaces'] = () => json(WORKSPACE);
  cp.routes['POST /v1/installation/email/domains'] = () => json(PENDING);
  cp.routes['POST /v1/installation/email/domains/verify'] = () => json({ ...PENDING, status: 'verified' });
  cp.routes['POST /v1/installation/email/domains/remove'] = () => json({ removed: true });
});

afterEach(() => cp.restore());

describe('managed PostShiba through the control plane', () => {
  it('provisions the workspace on its first sending domain and keeps the credential encrypted', async () => {
    const service = domainService(h.env);
    const domain = await service.add('t_acme', { kind: 'sending', hostname: 'mail.acme.test' });
    expect(domain.records).toEqual(PENDING.records);
    const provisioning = cp.calls.find((c) => c.path === '/v1/installation/email/workspaces');
    expect(provisioning?.body).toEqual({ workspaceId: 't_acme', name: 'acme', webhookUrl: 'https://crm.acme.test/hooks/email/postshiba/t_acme' });
    expect(cp.calls.find((c) => c.path === '/v1/installation/email/domains')?.body).toEqual({ providerTenantId: 'Ten001', hostname: 'mail.acme.test' });

    const raw = await h.env.DB.prepare(`SELECT value FROM installation_meta WHERE key = 'postshiba_sender:Ten001'`).first<{ value: string }>();
    expect(raw?.value).toBeDefined();
    expect(raw?.value).not.toContain('pw-secret-value');
    expect(await postshibaSenderStore(h.env).get('Ten001')).toEqual(WORKSPACE);
    expect(await workspaceWebhookSecret(h.env, 't_acme')).toBe('whsec-workspace');

    expect((await service.verify('t_acme', domain.id)).status).toBe('verified');
    await service.remove('t_acme', domain.id);
    expect(cp.calls.filter((c) => c.path.startsWith('/v1/installation/email/')).map((c) => c.path)).toEqual([
      '/v1/installation/email/workspaces',
      '/v1/installation/email/domains',
      '/v1/installation/email/domains/verify',
      '/v1/installation/email/domains/remove',
    ]);
  });

  it('verifies delivery webhooks with the workspace secret', async () => {
    await domainService(h.env).add('t_acme', { kind: 'sending', hostname: 'mail.acme.test' });
    const received: unknown[] = [];
    const mail = (_tenantId: string, _op: string, input: unknown) => {
      received.push(input);
      return Promise.resolve({ ok: true, value: { processed: 1 } });
    };
    Object.assign(h.env, { MAIL_DB: { idFromName: (n: string) => n, get: () => ({ mail }) } });
    const body = '[{"event":"delivered","sg_event_id":"ev_1"}]';
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await emailPublicApp.request(
      'https://crm.acme.test/hooks/email/postshiba/t_acme',
      { method: 'POST', body, headers: { 'x-capsule-timestamp': ts, 'x-capsule-signature': `sha256=${await hmacSha256Hex('whsec-workspace', `${ts}.${body}`)}` } },
      h.env,
    );
    expect(res.status).toBe(200);
    expect(received[0]).toMatchObject({ rawBody: body, secrets: ['whsec-workspace'] });
  });

  it('reports an unreachable control plane as retry later', async () => {
    cp.down = true;
    await expect(domainService(h.env).add('t_acme', { kind: 'sending', hostname: 'mail.acme.test' })).rejects.toMatchObject({
      status: 503,
      code: 'email_provider_unavailable',
    });
  });
});
