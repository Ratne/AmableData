import { facebookCapiConfigSchema, tiktokEventsConfigSchema } from '@amable/api-types';
import { submissionMetaSchema, type FormField } from '@amable/forms';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { facebookCapiConnector } from '../../src/forms/connectors/facebook-capi';
import { tiktokEventsConnector } from '../../src/forms/connectors/tiktok-events';
import type { ConnectorContext } from '../../src/forms/connectors/types';
import type { FormsRuntime } from '../../src/forms/runtime';

const NOW = Date.parse('2026-11-26T10:00:00Z');

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url));
  };
  return { calls, fetch };
}

const fields = [
  { key: 'mail', kind: 'email', label: 'Email', map_to: 'email' },
  { key: 'tel', kind: 'phone', label: 'Telefono', map_to: 'phone' },
] as unknown as FormField[];

function ctx<C>(config: C, fetch: FormsRuntime['fetch'], test = false): ConnectorContext<C> {
  return {
    env: {} as Env,
    tenantId: 't_acme',
    form: { id: 'frm_1', name: 'Lead', fields },
    submission: {
      id: 'sub_123',
      submittedAt: new Date(NOW - 5_000).toISOString(),
      contactId: null,
      values: { mail: ' Ada@Example.com ', tel: '333 123 4567' },
      tracking: { utm_source: 'tiktok', ttclid: 'TTCLID1', fbclid: 'FBCLID1' },
      meta: submissionMetaSchema.parse({
        page_url: 'https://www.example.com/landing',
        fbp: 'fb.1.1700000000000.123',
        ttp: 'TTP_COOKIE',
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0',
      }),
    },
    connection: { id: 'conn_1', name: 'Pixel', config, secret: 'secret-token-xyz' },
    attempt: 1,
    runtime: { now: () => NOW, fetch } as unknown as FormsRuntime,
    submissionUrl: null,
    test,
  };
}

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

describe('tiktok_events connector', () => {
  const config = tiktokEventsConfigSchema.parse({ pixel_code: 'CABC123XYZ', default_calling_code: '39' });

  it('sends the submission as a Lead with hashed PII, ttclid, _ttp and the submission id as event_id', async () => {
    const { calls, fetch } = fakeFetch(() => Response.json({ code: 0, message: 'OK', request_id: 'req_1' }));
    const result = await tiktokEventsConnector.run(ctx(config, fetch));
    expect(result.status).toBe('success');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toContain('business-api.tiktok.com');
    const body = JSON.stringify(JSON.parse(String(call?.init?.body)));
    expect(body).toContain('CABC123XYZ');
    expect(body).toContain('"Lead"');
    expect(body).toContain('sub_123');
    expect(body).toContain('TTCLID1');
    expect(body).toContain('TTP_COOKIE');
    expect(body).toContain(await sha256('ada@example.com'));
    expect(body).not.toContain('Ada@Example.com');
    expect(body).not.toContain('FBCLID1');
    expect(result.request ?? '').not.toContain('secret-token-xyz');
  });

  it('marks auth errors as permanent failures', async () => {
    const { fetch } = fakeFetch(() => Response.json({ code: 40105, message: 'Access token is invalid' }));
    const result = await tiktokEventsConnector.run(ctx(config, fetch));
    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
  });

  it('only verifies the token on a test run without test event code', async () => {
    const { calls, fetch } = fakeFetch(() => Response.json({ code: 40002, message: 'data: field required' }));
    const result = await tiktokEventsConnector.run(ctx(config, fetch, true));
    expect(result.status).toBe('success');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ event_source_id: 'CABC123XYZ', data: [] });
  });
});

describe('facebook_capi connector', () => {
  const config = facebookCapiConfigSchema.parse({ pixel_id: '1234567890', event_name: 'CompleteRegistration' });

  it('sends the event to the pixel with fbclid/_fbp and hashed email', async () => {
    const { calls, fetch } = fakeFetch(() => Response.json({ events_received: 1, fbtrace_id: 'trace' }));
    const result = await facebookCapiConnector.run(ctx(config, fetch));
    expect(result.status).toBe('success');
    const call = calls[0];
    expect(call?.url).toContain('/1234567890/events');
    const body = String(call?.init?.body);
    expect(body).toContain('CompleteRegistration');
    expect(body).toContain('sub_123');
    expect(body).toContain('fb.1.1700000000000.123');
    expect(body).toContain('FBCLID1');
    expect(body).toContain(await sha256('ada@example.com'));
    expect(body).not.toContain('TTCLID1');
  });

  it('accepts a token that can post events but not read the pixel', async () => {
    const { calls, fetch } = fakeFetch((url) =>
      url.includes('fields=name')
        ? Response.json({ error: { code: 100, message: 'Unsupported get request' } }, { status: 400 })
        : Response.json({ error: { code: 100, message: 'The parameter data is required' } }, { status: 400 }),
    );
    const result = await facebookCapiConnector.run(ctx(config, fetch, true));
    expect(result.status).toBe('success');
    expect(calls).toHaveLength(2);
  });
});
