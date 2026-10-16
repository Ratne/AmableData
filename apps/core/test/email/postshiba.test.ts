import { EmailProviderError, PostShibaEmailMarketingProvider } from '@amable/core';
import { describe, expect, it } from 'vitest';

/** The provider never reaches the network in tests: the transport is injected. */
function transport(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    return next === undefined ? Promise.reject(new Error('offline')) : Promise.resolve(next);
  };
  return { fetch, calls };
}

describe('PostShiba provider', () => {
  it('POSTs /emails with the Bearer key, idempotency key, tenant and unique args', async () => {
    const t = transport([
      new Response(JSON.stringify({ queued: true, message_id: 'ps_msg_1', suppressed: [] }), { status: 201 }),
    ]);
    const provider = new PostShibaEmailMarketingProvider({ apiKey: 'key_123', fetch: t.fetch });
    const result = await provider.sendEmail({
      from: 'news@acme.test',
      to: 'a@x.test',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      headers: { 'List-Unsubscribe': '<https://t/unsub/x>' },
      providerTenantId: 'ps_acme',
      idempotencyKey: 'msg_1',
      metadata: { message_id: 'msg_1' },
    });
    expect(result).toEqual({ messageId: 'ps_msg_1', accepted: true });
    const call = t.calls[0];
    expect(call?.url).toBe('https://app.postshiba.com/api/v1/emails');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer key_123');
    expect(headers['idempotency-key']).toBe('msg_1');
    const sent = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      tenant: 'ps_acme',
      headers: { 'List-Unsubscribe': '<https://t/unsub/x>' },
      unique_args: { message_id: 'msg_1' },
    });
    expect(sent).not.toHaveProperty('metadata');
    expect(sent).not.toHaveProperty('tenant_id');
  });

  it('reports a recipient listed in `suppressed` as a permanent suppressed error', async () => {
    const email = { from: 'a@b.c', to: 'Gone@x.test', subject: 's', html: 'h', text: 't' };
    const t = transport([
      new Response(JSON.stringify({ queued: false, message_id: 'm', suppressed: ['gone@x.test'] }), { status: 201 }),
      new Response('{"error":"suppressed","message":"every recipient is suppressed"}', { status: 403 }),
    ]);
    const provider = new PostShibaEmailMarketingProvider({ apiKey: 'k', fetch: t.fetch });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ code: 'suppressed', retryable: false });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ code: 'suppressed', retryable: false, status: 403 });
  });

  it('maps documented send error codes to retry / permanent / outcome unknown', async () => {
    const email = { from: 'a@b.c', to: 'd@e.f', subject: 's', html: 'h', text: 't' };
    const cases: { body: Record<string, unknown>; status: number; expected: Record<string, unknown> }[] = [
      { body: { error: 'throttled', retryable: true }, status: 429, expected: { retryable: true, code: 'throttled' } },
      { body: { error: 'idempotency_in_progress' }, status: 409, expected: { retryable: true } },
      { body: { error: 'idempotency_outcome_unknown' }, status: 409, expected: { retryable: false, code: 'outcome_unknown' } },
      { body: { error: 'inject_timeout_unknown', retryable: false }, status: 502, expected: { retryable: false, code: 'outcome_unknown' } },
      { body: { error: 'inject_unavailable', retryable: true }, status: 503, expected: { retryable: true } },
      { body: { error: 'inject_failed', retryable: false }, status: 502, expected: { retryable: false } },
      { body: { error: 'domain_unverified', field: 'from', message: 'must be a verified sending domain' }, status: 403, expected: { retryable: false, code: 'domain_unverified', message: 'must be a verified sending domain' } },
      { body: { error: 'kyc_required' }, status: 403, expected: { retryable: false } },
      { body: { error: 'cluster_not_ready' }, status: 403, expected: { retryable: true } },
    ];
    const t = transport(cases.map((c) => new Response(JSON.stringify(c.body), { status: c.status })));
    const provider = new PostShibaEmailMarketingProvider({ apiKey: 'k', fetch: t.fetch });
    for (const c of cases) {
      await expect(provider.sendEmail(email)).rejects.toMatchObject(c.expected);
    }
  });

  it('treats an accepted send without a message id as outcome unknown (never resend)', async () => {
    const t = transport([new Response(JSON.stringify({ queued: true }), { status: 201 })]);
    const provider = new PostShibaEmailMarketingProvider({ apiKey: 'k', fetch: t.fetch });
    await expect(
      provider.sendEmail({ from: 'a@b.c', to: 'd@e.f', subject: 's', html: 'h', text: 't' }),
    ).rejects.toMatchObject({ code: 'outcome_unknown', retryable: false });
  });

  it('classifies errors: 429/5xx/network retryable, 4xx permanent, missing key permanent', async () => {
    const email = { from: 'a@b.c', to: 'd@e.f', subject: 's', html: 'h', text: 't' };
    const t = transport([
      new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '30' } }),
      new Response('{"error":"bad address"}', { status: 422 }),
      new Response('oops', { status: 503 }),
    ]);
    const provider = new PostShibaEmailMarketingProvider({ apiKey: 'k', fetch: t.fetch });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ retryable: true, status: 429, retryAfterSeconds: 30 });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ retryable: false, message: 'bad address' });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ retryable: true, status: 503 });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ retryable: true, message: 'network error: offline' });
    const unconfigured = new PostShibaEmailMarketingProvider({ apiKey: '', fetch: t.fetch });
    await expect(unconfigured.sendEmail(email)).rejects.toBeInstanceOf(EmailProviderError);
    await expect(unconfigured.sendEmail(email)).rejects.toMatchObject({ retryable: false });
  });

  it('manages tenants and domains', async () => {
    const t = transport([
      new Response(JSON.stringify({ data: { id: 'ps_t1' } })),
      new Response(
        JSON.stringify({
          domain: 'acme.test',
          status: 'pending',
          records: [{ type: 'txt', name: 'acme.test', value: 'v=spf1 ~all' }, { type: 'A', name: 'x', value: 'y' }],
        }),
      ),
      new Response(JSON.stringify({ status: 'verified', records: [] })),
      new Response('{}'),
    ]);
    const provider = new PostShibaEmailMarketingProvider({ apiKey: 'k', baseUrl: 'https://ps.test/api/v1/', fetch: t.fetch });
    expect(await provider.createTenant('Acme')).toEqual({ providerTenantId: 'ps_t1', name: 'Acme' });
    expect(await provider.addDomain('ps_t1', 'acme.test')).toEqual({
      domain: 'acme.test',
      status: 'pending',
      records: [{ type: 'TXT', name: 'acme.test', value: 'v=spf1 ~all' }],
    });
    expect((await provider.verifyDomain('acme.test', 'ps_t1')).status).toBe('verified');
    await provider.suspendTenant('ps_t1', 'bounce_rate');
    expect(t.calls.map((c) => c.url)).toEqual([
      'https://ps.test/api/v1/tenants',
      'https://ps.test/api/v1/tenants/ps_t1/domains',
      'https://ps.test/api/v1/tenants/ps_t1/domains/acme.test/verify',
      'https://ps.test/api/v1/tenants/ps_t1/suspend',
    ]);
  });
});
