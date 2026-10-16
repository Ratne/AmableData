import { app as edgeApp, type Env as EdgeEnv } from '@amable/app-edge';
import { FORMS_WIDGET_BUNDLE_HASH } from '@amable/forms/bundle';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { overrideFormsRuntime } from '../../src/forms/runtime';
import { handleEdgeGateway } from '../../src/public/gateway';
import type { TestTenant } from '../crm/helpers';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';
import { collectWaits, inspectableTenantDb, leadDefinition, useFormsFakes } from './helpers';

// The edge entry exports its Durable Object class, which needs the Workers runtime.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const SECRET = 'e2e-edge-gateway-secret';

let h: Harness;
let db: TestTenant;
let edgeEnv: EdgeEnv;
let formId = '';
const waits = collectWaits();

function edge(path: string, init: RequestInit = {}) {
  return edgeApp.request(`https://forms.acme.example${path}`, init, edgeEnv, waits.ctx);
}

beforeAll(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  const acme = await seedTenant(h, 'acme');
  db = tenants.tenant(acme.id);
  useFormsFakes();
  formId = db.op('forms.create', { name: 'Contact us', definition: leadDefinition() }).id;
  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => handleEdgeGateway(new Request(input, init), h.env, waits.ctx),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

afterAll(() => overrideFormsRuntime(null));

describe('edge → core hosted forms', () => {
  it('serves the widget bundle with a hash ETag', async () => {
    const res = await edge('/forms.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${FORMS_WIDGET_BUNDLE_HASH}"`);
    expect(await res.text()).toContain('data-amable-form');
    const cached = await edge('/forms.js', { headers: { 'if-none-match': `"${FORMS_WIDGET_BUNDLE_HASH}"` } });
    expect(cached.status).toBe(304);
  });

  it('serves the public config with open CORS and a noindex hosted page', async () => {
    const config = await edge(`/f/acme/${formId}/config`);
    expect(config.status).toBe(200);
    expect(config.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await config.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: formId, tenant: 'acme', turnstile_site_key: null });
    expect(body).not.toHaveProperty('crm');

    const hosted = await edge(`/f/acme/${formId}`, { headers: { 'accept-language': 'it' } });
    expect(hosted.status).toBe(200);
    expect(hosted.headers.get('x-robots-tag')).toContain('noindex');
    const html = await hosted.text();
    expect(html).toContain(`data-amable-form="${formId}"`);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect((await edge('/f/acme/unknown_form')).status).toBe(404);
    expect((await edge(`/f/nobody/${formId}/config`)).status).toBe(404);

    const preflight = await edge(`/f/acme/${formId}`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('accepts a JSON submission end to end and creates the contact', async () => {
    const res = await edge(`/f/acme/${formId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.4',
        cookie: 'amb_vid=visitor_abcdef12',
      },
      body: JSON.stringify({
        values: { first_name: 'Grace', email: 'grace@example.com' },
        tracking: { utm_campaign: 'launch' },
        meta: { page_url: 'https://www.acme.example/pricing' },
      }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { ok: boolean; submission_id: string };
    expect(result.ok).toBe(true);
    await waits.flush();
    const row = db.db.all<{ status: string; contact_id: string; visitor_id: string; utm_campaign: string }>(
      `SELECT status, contact_id, visitor_id, utm_campaign FROM form_submissions WHERE id = ?`,
      result.submission_id,
    )[0];
    expect(row).toMatchObject({ status: 'processed', visitor_id: 'visitor_abcdef12', utm_campaign: 'launch' });
    expect(db.op('contacts.get', { id: row?.contact_id ?? '' }).given_name).toBe('Grace');
  });

  it('answers validation errors as JSON details and plain form posts as HTML', async () => {
    const invalid = await edge(`/f/acme/${formId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { email: 'x' } }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: 'validation_failed', details: [{ path: 'first_name', message: 'required' }, { path: 'email', message: 'invalid_email' }] });

    const html = await edge(`/f/acme/${formId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://www.acme.example/' },
      body: 'first_name=Linus&email=linus%40example.com&company_website=',
    });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');

    const huge = await edge(`/f/acme/${formId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { first_name: 'x'.repeat(70_000) } }),
    });
    expect(huge.status).toBe(413);
  });
});
