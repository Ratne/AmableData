import { createStaticTurnstile, verifyWebhook, WEBHOOK_SIGNATURE_HEADER } from '@amable/auth';
import type { OAuthTokenProvider } from '@amable/core';
import type { SubmitPayloadInput } from '@amable/forms';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSubmission, encryptSecret } from '../../src/forms/crypto';
import { formsGatewayHandlers } from '../../src/forms/gateway';
import { processSubmission } from '../../src/forms/process';
import { consumeFormSubmissions } from '../../src/forms/queue';
import { overrideFormsRuntime } from '../../src/forms/runtime';
import { GatewayError } from '../../src/public/context';
import type { TestTenant } from '../crm/helpers';
import { createHarness, seedTenant, type Harness } from '../helpers/harness';
import {
  collectWaits,
  gatewayCtx,
  inspectableTenantDb,
  leadDefinition,
  useFormsFakes,
  type RuntimeFakes,
} from './helpers';

const TENANT = { id: 't_acme', slug: 'acme' };

let h: Harness;
let db: TestTenant;
let formId: string;
let waits: ReturnType<typeof collectWaits>;
let fakes: RuntimeFakes;

const submitHandler = formsGatewayHandlers['forms.submit'];
const configHandler = formsGatewayHandlers['forms.config'];
if (submitHandler === undefined || configHandler === undefined) throw new Error('forms gateway handlers missing');

function payload(values: Record<string, unknown>, extra: Partial<SubmitPayloadInput> = {}): SubmitPayloadInput {
  return {
    values: values as SubmitPayloadInput['values'],
    tracking: { utm_source: 'google', utm_medium: 'cpc' },
    meta: { page_url: 'https://www.example.com/landing', referrer: 'https://google.com/' },
    ...extra,
  };
}

async function submit(values: Record<string, unknown>, extra: Partial<SubmitPayloadInput> = {}, id = formId) {
  const result = (await submitHandler?.(gatewayCtx(h.env, waits.ctx, TENANT), {
    formId: id,
    payload: payload(values, extra),
  })) as { submission_id: string };
  await waits.flush();
  return result;
}

async function addConnection(type: string, config: Record<string, unknown>, secret: string | null = null) {
  const id = `conn_${type}`;
  return db.op('forms.createConnection', {
    id,
    formId,
    type: type as 'webhook',
    name: type,
    enabled: true,
    config,
    secretCiphertext: secret === null ? null : await encryptSecret(h.services.secretBox, TENANT.id, id, secret),
    secretHint: null,
  });
}

function submissionRow(id: string) {
  return db.db.all<{ ciphertext: string; status: string; contact_id: string | null; utm_source: string | null }>(
    `SELECT * FROM form_submissions WHERE id = ?`,
    id,
  )[0];
}

function deliveries(submissionId: string) {
  return db.db.all<{ connection_id: string; status: string; attempts: number; status_code: number | null; response: string | null }>(
    `SELECT * FROM form_deliveries WHERE submission_id = ? ORDER BY connection_id`,
    submissionId,
  );
}

beforeEach(async () => {
  h = await createHarness();
  const tenants = inspectableTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  await seedTenant(h, TENANT.slug);
  db = tenants.tenant(TENANT.id);
  waits = collectWaits();
  fakes = useFormsFakes();
  db.op('customFields.create', { entity: 'contact', data: { key: 'budget', label: 'Budget', type: 'WHOLE_NUMBER' } });
  formId = db.op('forms.create', { name: 'Lead', definition: leadDefinition() }).id;
});

afterEach(() => overrideFormsRuntime(null));

describe('public submit', () => {
  it('stores only ciphertext bound to tenant and submission, then processes it inline', async () => {
    const { submission_id: id } = await submit({
      first_name: 'Ada',
      email: 'ada@example.com',
      phone: '+39 333 1234567',
      notes: 'top secret plans',
      budget: 42,
    });
    const row = submissionRow(id);
    expect(row?.status).toBe('processed');
    expect(row?.utm_source).toBe('google');
    // Plain columns must not hold any value. The ciphertext is random base64, which can contain
    // a short string like "Ada" by chance (~0.2 % of runs): it is checked for the values that
    // base64 can never produce, and through decryption below.
    const plainColumns = JSON.stringify(
      db.db.all<Record<string, unknown>>(`SELECT * FROM form_submissions`).map(({ ciphertext: _ciphertext, ...rest }) => rest),
    );
    for (const plain of ['ada@example.com', 'Ada', 'top secret plans', '1234567']) expect(plainColumns).not.toContain(plain);
    for (const plain of ['ada@example.com', 'top secret plans', '+39 333']) expect(row?.ciphertext).not.toContain(plain);
    expect(row?.ciphertext).toMatch(/^v1\.[A-Za-z0-9+/=._-]+$/);

    const box = h.services.secretBox;
    const decrypted = await decryptSubmission(box, TENANT.id, id, row?.ciphertext ?? '');
    expect(decrypted.values).toEqual({ first_name: 'Ada', email: 'ada@example.com', phone: '+39 333 1234567', notes: 'top secret plans', budget: 42 });
    expect(decrypted.meta.visitor_id).toBe('vis_cookie_12345');
    await expect(decryptSubmission(box, 't_other', id, row?.ciphertext ?? '')).rejects.toThrow();
    await expect(decryptSubmission(box, TENANT.id, 'another_submission', row?.ciphertext ?? '')).rejects.toThrow();

    const contact = db.op('contacts.get', { id: row?.contact_id ?? '' });
    expect(contact).toMatchObject({ given_name: 'Ada', custom_fields: { budget: 42 }, utm: { source: 'google', medium: 'cpc' } });
  });

  it('rejects a failed Turnstile check with 403 turnstile_failed and stores nothing', async () => {
    h.services.turnstile = createStaticTurnstile({ acceptToken: 'good-token' });
    h.services.turnstileSiteKey = 'site-key';
    db.op('forms.update', { id: formId, data: { definition: { ...leadDefinition(), settings: { turnstile_enabled: true } } } });
    const config = (await configHandler(gatewayCtx(h.env, waits.ctx, TENANT), { formId })) as { turnstile_site_key: string | null };
    expect(config.turnstile_site_key).toBe('site-key');

    const error = await submit({ first_name: 'Bot', email: 'bot@example.com' }, { turnstile_token: 'forged' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ status: 403, code: 'turnstile_failed' });
    expect(db.db.all(`SELECT id FROM form_submissions`)).toHaveLength(0);

    const ok = await submit({ first_name: 'Ada', email: 'ada@example.com' }, { turnstile_token: 'good-token' });
    expect(submissionRow(ok.submission_id)?.status).toBe('processed');
  });

  it('answers field errors with 422 details, enforces allowed domains and swallows honeypot posts', async () => {
    const invalid = await submit({ email: 'nope' }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({
      status: 422,
      code: 'validation_failed',
      details: [
        { path: 'first_name', message: 'required' },
        { path: 'email', message: 'invalid_email' },
      ],
    });
    db.op('forms.update', {
      id: formId,
      data: { definition: { ...leadDefinition(), settings: { allowed_domains: ['example.org'] } } },
    });
    const foreign = await submit({ first_name: 'Ada', email: 'ada@example.com' }).catch((e: unknown) => e);
    expect(foreign).toMatchObject({ status: 403, code: 'domain_not_allowed' });
    const fromSubdomain = await submit(
      { first_name: 'Ada', email: 'ada@example.com' },
      { meta: { page_url: 'https://shop.example.org/buy' } },
    );
    expect(fromSubdomain.submission_id).toBeTruthy();

    const before = db.db.all(`SELECT id FROM form_submissions`).length;
    const bot = await submit({ first_name: 'Bot', email: 'bot@example.org' }, { hp: 'http://spam', meta: { page_url: 'https://example.org/' } });
    expect(bot.submission_id).toBeTruthy();
    expect(db.db.all(`SELECT id FROM form_submissions`)).toHaveLength(before);
  });

  it('puts the submission on the queue when the binding exists', async () => {
    const sent: unknown[] = [];
    h.env.FORM_SUBMISSIONS = { send: (body: unknown) => Promise.resolve(void sent.push(body)) } as unknown as Queue<unknown>;
    const { submission_id: id } = await submit({ first_name: 'Ada', email: 'ada@example.com' });
    expect(sent).toEqual([{ tenantId: TENANT.id, submissionId: id }]);
    expect(submissionRow(id)?.status).toBe('pending');

    const acks: string[] = [];
    const message = {
      id: 'm1',
      body: sent[0],
      attempts: 1,
      timestamp: new Date(),
      ack: () => acks.push('ack'),
      retry: () => acks.push('retry'),
    };
    await consumeFormSubmissions({ queue: 'form-submissions', messages: [message] } as unknown as MessageBatch<unknown>, h.env);
    expect(acks).toEqual(['ack']);
    expect(submissionRow(id)?.status).toBe('processed');
  });
});

describe('connections', () => {
  it('signs outgoing webhooks so receivers can verify them', async () => {
    const secret = 'whsec_test_secret_value';
    await addConnection('webhook', { url: 'https://hooks.example.net/forms', method: 'POST', format: 'json', headers: { 'X-Team': 'growth' }, field_map: [] }, secret);
    const { submission_id: id } = await submit({ first_name: 'Ada', email: 'ada@example.com', budget: 7 });

    expect(fakes.fetch.requests).toHaveLength(1);
    const request = fakes.fetch.requests[0];
    expect(request?.url).toBe('https://hooks.example.net/forms');
    expect(request?.headers.get('x-team')).toBe('growth');
    expect(request?.headers.get('idempotency-key')).toBe(`${id}:conn_webhook`);
    const verified = await verifyWebhook({
      secrets: [secret],
      header: request?.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? null,
      rawBody: request?.body ?? '',
      nowMs: h.clock.now,
    });
    expect(verified).toEqual({ ok: true });
    expect(
      await verifyWebhook({ secrets: ['wrong'], header: request?.headers.get(WEBHOOK_SIGNATURE_HEADER) ?? null, rawBody: request?.body ?? '', nowMs: h.clock.now }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'form.submitted',
      form: { id: formId, name: 'Lead' },
      submission: { id, values: { first_name: 'Ada', email: 'ada@example.com', budget: 7 }, tracking: { utm_source: 'google' } },
    });
    expect(deliveries(id)).toMatchObject([{ status: 'success', attempts: 1, status_code: 200 }]);
  });

  it('retries transient webhook failures with attempt counters and never repeats a success', async () => {
    let status = 503;
    overrideFormsRuntime(null);
    fakes = useFormsFakes({ respond: () => new Response('busy', { status }) });
    await addConnection('webhook', { url: 'https://hooks.example.net/forms' }, 'whsec_x');
    h.env.FORM_SUBMISSIONS = { send: () => Promise.resolve() } as unknown as Queue<unknown>;
    const { submission_id: id } = await submit({ first_name: 'Ada', email: 'ada@example.com' });

    const first = await processSubmission(h.env, TENANT.id, id, { attempt: 1, final: false });
    expect(first).toMatchObject({ status: 'processed', retry: true });
    expect(deliveries(id)).toMatchObject([{ status: 'retrying', attempts: 1, status_code: 503 }]);

    status = 200;
    const second = await processSubmission(h.env, TENANT.id, id, { attempt: 2, final: false });
    expect(second.retry).toBe(false);
    expect(deliveries(id)).toMatchObject([{ status: 'success', attempts: 2 }]);

    await processSubmission(h.env, TENANT.id, id, { attempt: 3, final: false });
    expect(fakes.fetch.requests).toHaveLength(2);
    expect(db.db.all(`SELECT id FROM crm_outbox WHERE type = 'form.submitted'`)).toHaveLength(1);
  });

  it('blocks webhooks to private addresses without retrying', async () => {
    await addConnection('webhook', { url: 'http://127.0.0.1:8080/hook' }, 'whsec_x');
    const { submission_id: id } = await submit({ first_name: 'Ada', email: 'ada@example.com' });
    expect(fakes.fetch.requests).toHaveLength(0);
    expect(deliveries(id)).toMatchObject([{ status: 'failed', response: expect.stringContaining('blocked URL') }]);
  });

  it('skips Google Sheets with the dev OAuth stub and appends rows with a real token', async () => {
    await addConnection('google_sheets', { account_id: 'acc_1', spreadsheet_id: 'sheet_ABCDEFGHIJK', sheet_name: 'Leads' });
    const skipped = await submit({ first_name: 'Ada', email: 'ada@example.com' });
    expect(fakes.fetch.requests).toHaveLength(0);
    expect(deliveries(skipped.submission_id)).toMatchObject([{ status: 'skipped', response: expect.stringContaining('dev stub') }]);

    const realToken: OAuthTokenProvider = {
      available: true,
      startConnect: () => Promise.reject(new Error('unused')),
      finishConnect: () => Promise.reject(new Error('unused')),
      getAccessToken: () => Promise.resolve({ accessToken: 'ya29.token', expiresAt: h.clock.now + 60_000, scopes: [], stub: false }),
      revoke: () => Promise.resolve(),
    };
    overrideFormsRuntime(null);
    fakes = useFormsFakes({ oauth: realToken });
    const sent = await submit({ first_name: '=HYPERLINK("http://evil")', email: 'eve@example.com' });
    const request = fakes.fetch.requests[0];
    expect(request?.url).toContain('https://sheets.googleapis.com/v4/spreadsheets/sheet_ABCDEFGHIJK/values/');
    expect(request?.headers.get('authorization')).toBe('Bearer ya29.token');
    const row = (JSON.parse(request?.body ?? '{}') as { values: string[][] }).values[0];
    expect(row?.[1]).toBe(`'=HYPERLINK("http://evil")`);
    expect(row?.[2]).toBe('eve@example.com');
    expect(deliveries(sent.submission_id)).toMatchObject([{ status: 'success' }]);
  });

  it('notifies staff by email without sensitive fields', async () => {
    await addConnection('email_notification', { recipients: ['sales@acme.test', 'boss@acme.test'], subject: 'New lead: {{first_name}}' });
    await submit({ first_name: 'Ada', email: 'ada@example.com', notes: 'top secret plans' });
    expect(fakes.emails.map((e) => [e.to, e.subject])).toEqual([
      ['sales@acme.test', 'New lead: Ada'],
      ['boss@acme.test', 'New lead: Ada'],
    ]);
    expect(fakes.emails[0]?.text).toContain('ada@example.com');
    expect(fakes.emails[0]?.text).not.toContain('top secret plans');
  });

  it('creates DocuSeal signature requests with the API key and prefilled values', async () => {
    await addConnection(
      'docuseal',
      { region: 'eu', template_id: 77, prefill: [{ source: 'first_name', field: 'Name' }], subject: 'Contract for {{first_name}}' },
      'ds_api_key',
    );
    overrideFormsRuntime(null);
    fakes = useFormsFakes({ respond: () => new Response(JSON.stringify([{ submission_id: 9, status: 'sent' }]), { status: 200 }) });
    const { submission_id: id } = await submit({ first_name: 'Ada', last_name: 'L', email: 'ada@example.com' });
    const request = fakes.fetch.requests[0];
    expect(request?.url).toBe('https://api.docuseal.eu/submissions');
    expect(request?.headers.get('x-auth-token')).toBe('ds_api_key');
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      template_id: 77,
      send_email: true,
      message: { subject: 'Contract for Ada' },
      submitters: [{ email: 'ada@example.com', name: 'Ada L', external_id: `${id}:conn_docuseal`, values: { Name: 'Ada' } }],
    });
    expect(deliveries(id)).toMatchObject([{ status: 'success' }]);
  });

  it('marks a submission failed when the CRM rejects it and keeps it for reprocessing', async () => {
    db.op('customFields.create', { entity: 'contact', data: { key: 'vat', label: 'VAT', type: 'TEXT', required: true } });
    const { submission_id: id } = await submit({ first_name: 'Ada', email: 'ada@example.com' });
    expect(submissionRow(id)?.status).toBe('failed');
    expect(db.db.all<{ error: string }>(`SELECT error FROM form_submissions WHERE id = ?`, id)[0]?.error).toContain('vat');
    db.db.run(`UPDATE crm_custom_fields SET required = 0 WHERE key = 'vat'`);
    const retried = await processSubmission(h.env, TENANT.id, id, { attempt: 1, final: true });
    expect(retried.status).toBe('processed');
  });
});
