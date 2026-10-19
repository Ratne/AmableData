import { app as edgeApp, type Env as EdgeEnv } from '@amable/app-edge';
import { ESIGN_CONSENT_VERSION, type SigningView } from '@amable/esign';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/app';
import { handleEdgeGateway } from '../../src/public/gateway';
import { FINALIZE_LEASE_MS } from '../../src/esign/due';
import { runEsignDue } from '../../src/esign/runner';
import { fakeEmailQueue } from '../booking/helpers';
import { outbox, type TestTenant } from '../crm/helpers';
import { collectWaits } from '../forms/helpers';
import {
  addMember,
  createHarness,
  login,
  ORIGIN,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import {
  clockedTenantDb,
  emailText,
  fakeEngine,
  fakeSealQueue,
  memoryBucket,
  PNG_BYTES,
  PNG_DATA_URL,
  samplePdf,
  signingToken,
  systemCall,
} from './helpers';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const SECRET = 'e2e-esign-gateway-secret';
const BASE = '/api/v2/t/acme';
const DAY = 86_400_000;

let h: Harness;
let db: TestTenant;
let owner: TestClient;
let viewer: TestClient;
let edgeEnv: EdgeEnv;
let files: ReturnType<typeof memoryBucket>;
let emails: ReturnType<typeof fakeEmailQueue>;
let engine: ReturnType<typeof fakeEngine>;
let seal: ReturnType<typeof fakeSealQueue>;
let pdf: Uint8Array;
const waits = collectWaits();

const BROWSER = {
  time_zone: 'Europe/Rome',
  local_time: '2026-10-15T14:00:00+02:00',
  languages: ['it-IT', 'en'],
  platform: 'MacIntel',
  screen: '1512x982',
  viewport: '1280x800',
  pixel_ratio: 2,
  touch_points: 0,
  webdriver: false,
};

function edge(path: string, init: RequestInit = {}) {
  return edgeApp.request(`https://sign.acme.example${path}`, init, edgeEnv, waits.ctx);
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-connecting-ip': '198.51.100.9',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15',
    'accept-language': 'it-IT,it;q=0.9',
  },
  body: JSON.stringify(body),
});

/** Binary upload with the client's session (TestClient only sends JSON). */
async function upload(client: TestClient, path: string, bytes: Uint8Array, type: string) {
  const response = await app.request(
    `${ORIGIN}${path}`,
    {
      method: 'PUT',
      headers: {
        origin: ORIGIN,
        'x-amable-csrf': '1',
        'content-type': type,
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: bytes,
    },
    h.env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function runDue() {
  const result = await runEsignDue(h.env, systemCall(db), () => db.clock.now);
  await waits.flush();
  return result;
}

function invites(to: string) {
  return emails.messages.filter((m) => m.toEmail === to);
}

async function view(token: string): Promise<SigningView> {
  const response = await edge(`/sign/acme/${token}`, { headers: { 'accept-language': 'it' } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = /<script type="application\/json" id="amable-sign-view">([\s\S]*?)<\/script>/.exec(
    html,
  );
  return JSON.parse(match?.[1] ?? 'null') as SigningView;
}

async function sign(token: string, values: Record<string, string | boolean>) {
  return edge(
    `/sign/acme/${token}/complete`,
    post({
      values,
      methods: { sig: 'drawn' },
      consent: true,
      consent_version: ESIGN_CONSENT_VERSION,
      browser: BROWSER,
    }),
  );
}

async function createTemplate(input: Record<string, unknown>, fields: unknown[]): Promise<string> {
  const created = await owner.post(`${BASE}/esignTemplates`, input);
  expect(created.status).toBe(201);
  const id = String(created.body['id']);
  const doc = await upload(
    owner,
    `${BASE}/esignTemplates/${id}/document?filename=contratto.pdf`,
    pdf,
    'application/pdf',
  );
  expect(doc.status).toBe(200);
  const sha = String((doc.body['source'] as { sha256: string }).sha256);
  for (const page of [0, 1]) {
    const image = await upload(
      owner,
      `${BASE}/esignTemplates/${id}/pages/${String(page)}/image?source_sha256=${sha}`,
      PNG_BYTES,
      'image/png',
    );
    expect(image.status).toBe(200);
  }
  const active = await owner.patch(`${BASE}/esignTemplates/${id}`, { fields, status: 'active' });
  expect(active.status).toBe(200);
  expect(active.body).toMatchObject({ status: 'active', ready: true });
  return id;
}

const field = (
  id: string,
  type: string,
  party: string,
  page = 0,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type,
  party_id: party,
  page,
  x: 0.1,
  y: 0.7,
  w: 0.3,
  h: 0.06,
  ...extra,
});

beforeAll(async () => {
  h = await createHarness();
  const tenants = clockedTenantDb();
  h.env.TENANT_DB = tenants.namespace;
  h.env.EDGE_GATEWAY_SECRET = SECRET;
  h.env.EDGE_ORIGIN = 'https://sign.acme.example';
  h.env.EMAIL_TOKEN_SECRET = 'esign-test-token-secret';
  files = memoryBucket();
  h.env.FILES = files;
  emails = fakeEmailQueue();
  h.env.EMAIL_SEND = emails.queue;
  engine = fakeEngine();
  h.env.ENGINE = engine.namespace;
  seal = fakeSealQueue(h.env);
  h.env.ESIGN_SEAL = seal.queue;
  const acme = await seedTenant(h, 'acme');
  db = tenants.tenant(acme.id);
  const ownerUser = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, ownerUser.id, acme.id, 'owner');
  owner = await login(h, ownerUser.email);
  const viewerUser = await seedUser(h, { email: 'viewer@acme.test' });
  await addMember(h, viewerUser.id, acme.id, 'viewer');
  viewer = await login(h, viewerUser.email);
  pdf = await samplePdf(2);
  edgeEnv = {
    EDGE_GATEWAY_SECRET: SECRET,
    CORE: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        handleEdgeGateway(new Request(input, init), h.env, waits.ctx),
    } as unknown as Fetcher,
  } as EdgeEnv;
});

describe('signature templates over REST', () => {
  it('checks permissions, the uploaded document and the rendered pages', async () => {
    expect((await viewer.post(`${BASE}/esignTemplates`, { name: 'Nope' })).status).toBe(403);
    expect((await viewer.get(`${BASE}/esignTemplates`)).status).toBe(200);

    const created = await owner.post(`${BASE}/esignTemplates`, { name: 'Draft' });
    const id = String(created.body['id']);
    expect(
      (
        await upload(
          owner,
          `${BASE}/esignTemplates/${id}/document`,
          new TextEncoder().encode('hello'),
          'application/pdf',
        )
      ).status,
    ).toBe(415);
    const doc = await upload(
      owner,
      `${BASE}/esignTemplates/${id}/document`,
      pdf,
      'application/pdf',
    );
    expect(doc.status).toBe(200);
    expect(doc.body['pages']).toEqual([
      expect.objectContaining({ index: 0, has_image: false }),
      expect.objectContaining({ index: 1, has_image: false }),
    ]);
    const stale = await upload(
      owner,
      `${BASE}/esignTemplates/${id}/pages/0/image?source_sha256=${'0'.repeat(64)}`,
      PNG_BYTES,
      'image/png',
    );
    expect(stale.status).toBe(409);
    expect(
      (
        await upload(
          owner,
          `${BASE}/esignTemplates/${id}/pages/0/image?source_sha256=${'0'.repeat(64)}`,
          pdf,
          'image/png',
        )
      ).status,
    ).toBe(415);

    const early = await owner.patch(`${BASE}/esignTemplates/${id}`, { status: 'active' });
    expect(early.status).toBe(409);
  });
});

describe('signing flow through the edge', () => {
  let templateId = '';
  let requestId = '';
  let clientToken = '';
  let agencyToken = '';

  it('sends the invitations with personal links', async () => {
    templateId = await createTemplate(
      {
        name: 'Contratto di servizio',
        parties: [
          { id: 'client', name: 'Cliente' },
          { id: 'agency', name: 'Agenzia' },
        ],
      },
      [
        field('sig', 'signature', 'client'),
        field('company', 'text', 'client', 0, { y: 0.6, label: 'Ragione sociale' }),
        field('date', 'signed_date', 'client', 0, { y: 0.5 }),
        field('agency_sig', 'signature', 'agency', 1),
      ],
    );
    const sent = await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [
        { party_id: 'client', email: 'mario@example.com', name: 'Mario Rossi' },
        { party_id: 'agency', email: 'anna@agency.example', name: 'Anna Bianchi' },
      ],
      message: 'Ecco il contratto.',
      locale: 'it',
    });
    expect(sent.status).toBe(201);
    requestId = String(sent.body['id']);
    expect(sent.body).toMatchObject({ status: 'sent', origin: 'manual' });

    const run = await runDue();
    expect(run).toMatchObject({ changed: true, failed: false });
    const [clientMail] = invites('mario@example.com');
    const [agencyMail] = invites('anna@agency.example');
    expect(clientMail?.source).toMatchObject({
      type: 'transactional',
      purpose: 'esign',
      referenceId: requestId,
    });
    expect(emailText(clientMail!)).toContain('Ecco il contratto.');
    clientToken = signingToken(clientMail!);
    agencyToken = signingToken(agencyMail!);
    expect(clientToken).not.toBe(agencyToken);

    const detail = await owner.get(`${BASE}/esignRequests/${requestId}`);
    const signers = detail.body['signers'] as Array<{
      status: string;
      next_reminder_at: string | null;
    }>;
    expect(signers.map((s) => s.status)).toEqual(['sent', 'sent']);
    expect(signers.every((s) => s.next_reminder_at !== null)).toBe(true);
    expect((await runDue()).changed).toBe(false);
  });

  it('serves a locked-down page with only the signer’s own fields', async () => {
    const response = await edge(`/sign/acme/${clientToken}`);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const current = await view(clientToken);
    expect(current).toMatchObject({
      state: 'ready',
      locale: 'it',
      request_name: 'Contratto di servizio',
    });
    expect(current.fields.map((f) => f.id).sort()).toEqual(['company', 'date', 'sig']);
    expect(current.others.map((f) => f.id)).toEqual(['agency_sig']);
    expect(current.consent.version).toBe(ESIGN_CONSENT_VERSION);

    const page = await edge(`/sign/acme/${clientToken}/pages/0`);
    expect(page.status).toBe(200);
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(PNG_BYTES);
    expect((await edge(`/sign/acme/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await edge(`/sign/other/${clientToken}`)).status).toBe(404);
  });

  it('records consent, signature and browser facts for each party, then seals the PDF', async () => {
    expect((await edge(`/sign/acme/${clientToken}/open`, post({ browser: BROWSER }))).status).toBe(
      200,
    );

    const missing = await sign(clientToken, { sig: PNG_DATA_URL });
    expect(missing.status).toBe(422);
    const noConsent = await edge(
      `/sign/acme/${clientToken}/complete`,
      post({
        values: { sig: PNG_DATA_URL, company: 'Rossi Srl' },
        consent: false,
        consent_version: ESIGN_CONSENT_VERSION,
      }),
    );
    expect(noConsent.status).toBeGreaterThanOrEqual(400);

    const signed = await sign(clientToken, { sig: PNG_DATA_URL, company: 'Rossi Srl' });
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as SigningView).state).toBe('signed');
    expect(files.objects.size).toBeGreaterThan(0);

    const agency = await sign(agencyToken, { agency_sig: PNG_DATA_URL });
    expect(agency.status).toBe(200);
    expect(((await agency.json()) as SigningView).state).toBe('completed');
    expect(engine.kicks.length).toBeGreaterThan(0);

    const events = outbox(db).filter((e) => e.type.startsWith('esign.'));
    expect(events.filter((e) => e.type === 'esign.signer_signed')).toHaveLength(2);
    expect(
      events
        .filter((e) => e.type === 'esign.request_completed')
        .map((e) => e.payload['partyId'])
        .sort(),
    ).toEqual(['agency', 'client']);

    const detail = await owner.get(`${BASE}/esignRequests/${requestId}`);
    expect(detail.body).toMatchObject({ status: 'completed', document_ready: false });
    const trail = detail.body['events'] as Array<{
      type: string;
      ip: string | null;
      user_agent: string | null;
      country: string | null;
      meta: Record<string, unknown>;
    }>;
    const consent = trail.find((e) => e.type === 'consent_given');
    expect(consent).toMatchObject({ ip: '198.51.100.9' });
    expect(consent?.user_agent).toContain('Safari');
    expect(consent?.meta).toMatchObject({
      version: ESIGN_CONSENT_VERSION,
      time_zone: 'Europe/Rome',
      screen: '1512x982',
      accept_language: 'it-IT,it;q=0.9',
    });
    expect(String(consent?.meta['text'])).toContain('firma elettronica');
    const signedEvent = trail.find((e) => e.type === 'signed');
    expect(JSON.stringify(signedEvent?.meta)).toMatch(/[0-9a-f]{64}/);
    expect(trail.map((e) => e.type)).toEqual(
      expect.arrayContaining(['created', 'sent', 'opened', 'consent_given', 'signed', 'completed']),
    );

    expect((await runDue()).failed).toBe(false);
    expect(seal.pending).toEqual([{ tenantId: expect.any(String), requestId }]);
    expect((await owner.get(`${BASE}/esignRequests/${requestId}`)).body).toMatchObject({
      document_ready: false,
      finalize_error: null,
    });
    await runDue();
    expect(seal.pending).toHaveLength(1);
    await seal.drain();
    const sealed = await owner.get(`${BASE}/esignRequests/${requestId}`);
    expect(sealed.body).toMatchObject({ document_ready: true, finalize_error: null });
    expect(String(sealed.body['completed_sha256'])).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (sealed.body['events'] as Array<{ type: string }>).some((e) => e.type === 'document_sealed'),
    ).toBe(true);
    expect(emails.messages.filter((m) => /Firmato/.test(m.content.subject ?? ''))).toHaveLength(2);

    const download = await edge(`/sign/acme/${clientToken}/document`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/pdf');
    const doc = await PDFDocument.load(new Uint8Array(await download.arrayBuffer()));
    expect(doc.getPageCount()).toBeGreaterThan(2);
    expect(doc.getTitle()).toContain('Contratto di servizio');

    const staff = await app.request(
      `${ORIGIN}${BASE}/esignRequests/${requestId}/document?kind=completed`,
      {
        headers: {
          origin: ORIGIN,
          cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        },
      },
      h.env,
    );
    expect(staff.status).toBe(200);
    expect((await view(clientToken)).state).toBe('completed');
    expect(
      (await sign(clientToken, { sig: PNG_DATA_URL, company: 'Again' })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it('sends reminders until the request expires', async () => {
    const sent = await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [
        { party_id: 'client', email: 'late@example.com' },
        { party_id: 'agency', email: 'anna@agency.example' },
      ],
      expire_days: 10,
    });
    const id = String(sent.body['id']);
    await runDue();
    const before = emails.messages.length;

    db.clock.now += 3 * DAY + 60_000;
    await runDue();
    const reminders = emails.messages.slice(before).filter((m) => m.toEmail === 'late@example.com');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.content.subject).toMatch(/Reminder|Promemoria/);
    expect(signingToken(reminders[0]!)).toBe(signingToken(invites('late@example.com')[0]!));
    const detail = await owner.get(`${BASE}/esignRequests/${id}`);
    expect((detail.body['signers'] as Array<{ reminders_sent: number }>)[0]?.reminders_sent).toBe(
      1,
    );

    const manual = await owner.post(`${BASE}/esignRequests/${id}/remind`, {});
    expect(manual.status).toBe(200);
    await runDue();
    expect(emails.messages.filter((m) => m.toEmail === 'late@example.com')).toHaveLength(3);

    db.clock.now += 8 * DAY;
    await runDue();
    const expired = await owner.get(`${BASE}/esignRequests/${id}`);
    expect(expired.body['status']).toBe('expired');
    const late = await view(signingToken(invites('late@example.com')[0]!));
    expect(late).toMatchObject({ state: 'closed', closed_reason: 'expired' });
  });

  it('voids open requests and refuses to sign them', async () => {
    const sent = await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [
        { party_id: 'client', email: 'void@example.com' },
        { party_id: 'agency', email: 'anna@agency.example' },
      ],
    });
    const id = String(sent.body['id']);
    await runDue();
    expect((await viewer.post(`${BASE}/esignRequests/${id}/void`, {})).status).toBe(403);
    const voided = await owner.post(`${BASE}/esignRequests/${id}/void`, { reason: 'Wrong price' });
    expect(voided.body).toMatchObject({ status: 'voided', void_reason: 'Wrong price' });
    const token = signingToken(invites('void@example.com')[0]!);
    expect(await view(token)).toMatchObject({ state: 'closed', closed_reason: 'voided' });
    expect((await sign(token, { sig: PNG_DATA_URL, company: 'X' })).status).toBeGreaterThanOrEqual(
      400,
    );
  });
});

describe('sequential order, decline and email confirmation code', () => {
  it('invites the next party only after the previous one, and stops on decline', async () => {
    const templateId = await createTemplate(
      {
        name: 'NDA',
        signing_order: 'sequential',
        parties: [
          { id: 'first', name: 'Prima parte' },
          { id: 'second', name: 'Seconda parte' },
        ],
      },
      [field('a', 'signature', 'first'), field('b', 'signature', 'second', 1)],
    );
    const sent = await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [
        { party_id: 'first', email: 'first@example.com' },
        { party_id: 'second', email: 'second@example.com' },
      ],
    });
    const id = String(sent.body['id']);
    await runDue();
    expect(invites('first@example.com')).toHaveLength(1);
    expect(invites('second@example.com')).toHaveLength(0);

    const token = signingToken(invites('first@example.com')[0]!);
    const declined = await edge(
      `/sign/acme/${token}/decline`,
      post({ reason: 'Not my company', browser: BROWSER }),
    );
    expect(declined.status).toBe(200);
    expect(((await declined.json()) as SigningView).state).toBe('declined');
    await runDue();
    expect(invites('second@example.com')).toHaveLength(0);
    const detail = await owner.get(`${BASE}/esignRequests/${id}`);
    expect(detail.body).toMatchObject({ status: 'declined' });
    expect(
      (detail.body['signers'] as Array<{ decline_reason: string | null }>)[0]?.decline_reason,
    ).toBe('Not my company');
    const event = outbox(db).find(
      (e) => e.type === 'esign.request_declined' && e.payload['requestId'] === id,
    );
    expect(event?.payload).toMatchObject({
      templateId,
      partyId: 'first',
      reason: 'Not my company',
    });

    await waits.flush();
    const notice = h.emails.filter(
      (e) => e.to === 'owner@acme.test' && e.subject.includes('declined'),
    );
    expect(notice).toHaveLength(1);
    expect(notice[0]?.subject).toBe('first@example.com declined to sign "NDA"');
    expect(notice[0]?.text).toContain('Not my company');
    expect(notice[0]?.text).toContain(`/t/acme/signatures/${id}`);
  });

  it('requires the emailed code when the template asks for it', async () => {
    const created = await owner.post(`${BASE}/esignTemplates`, {
      name: 'Mandato',
      parties: [{ id: 'client', name: 'Cliente' }],
      settings: { require_otp: true },
    });
    const templateId = String(created.body['id']);
    const doc = await upload(
      owner,
      `${BASE}/esignTemplates/${templateId}/document`,
      pdf,
      'application/pdf',
    );
    const sha = String((doc.body['source'] as { sha256: string }).sha256);
    for (const page of [0, 1])
      await upload(
        owner,
        `${BASE}/esignTemplates/${templateId}/pages/${String(page)}/image?source_sha256=${sha}`,
        PNG_BYTES,
        'image/png',
      );
    await owner.patch(`${BASE}/esignTemplates/${templateId}`, {
      fields: [field('sig', 'signature', 'client')],
      status: 'active',
    });

    await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [{ party_id: 'client', email: 'otp@example.com' }],
    });
    await runDue();
    const token = signingToken(invites('otp@example.com')[0]!);
    expect((await view(token)).otp).toMatchObject({ required: true, verified: false });

    expect((await sign(token, { sig: PNG_DATA_URL })).status).toBe(403);
    const send = await edge(`/sign/acme/${token}/otp/send`, post({ browser: BROWSER }));
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ sent: true });
    const again = await edge(`/sign/acme/${token}/otp/send`, post({}));
    expect(await again.json()).toMatchObject({ sent: false });
    const codeMail = emails.messages.filter((m) => m.toEmail === 'otp@example.com').at(-1)!;
    const code = /(\d{6})/.exec(codeMail.content.subject ?? '')?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(codeMail)).toContain('notAfter');

    const wrong = await edge(
      `/sign/acme/${token}/otp/verify`,
      post({ code: code === '000000' ? '111111' : '000000' }),
    );
    expect(await wrong.json()).toMatchObject({ verified: false, attempts_left: 4 });
    const right = await edge(`/sign/acme/${token}/otp/verify`, post({ code }));
    expect(await right.json()).toMatchObject({ verified: true });
    const signed = await sign(token, { sig: PNG_DATA_URL });
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as SigningView).state).toBe('completed');
    const types = db.db
      .all<{ type: string }>(
        `SELECT type FROM esign_events WHERE signer_id IN (SELECT id FROM esign_signers WHERE email = 'otp@example.com') ORDER BY id`,
      )
      .map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['otp_sent', 'otp_failed', 'otp_verified', 'consent_given', 'signed']),
    );
  });
});

describe('signers whose contact changed after sending', () => {
  let templateId = '';

  beforeAll(async () => {
    templateId = await createTemplate(
      { name: 'Ordine', parties: [{ id: 'client', name: 'Cliente' }] },
      [field('sig', 'signature', 'client')],
    );
  });

  const sendTo = async (email: string) => {
    const sent = await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [{ party_id: 'client', email, name: 'Rita Verdi' }],
    });
    const id = String(sent.body['id']);
    const detail = await owner.get(`${BASE}/esignRequests/${id}`);
    const contactId = (detail.body['signers'] as Array<{ contact_id: string }>)[0]!.contact_id;
    return { id, contactId };
  };
  const signerContact = async (id: string) =>
    (
      (await owner.get(`${BASE}/esignRequests/${id}`)).body['signers'] as Array<{
        contact_id: string;
      }>
    )[0]!.contact_id;

  it('counts the requests on the contact Signatures tab', async () => {
    const { contactId } = await sendTo('counted@example.com');
    await sendTo('counted@example.com');
    const counts = await owner.get(`${BASE}/contacts/${contactId}/counts`);
    expect(counts.body).toMatchObject({ signatures: 2 });
  });

  it('follows a merge to the surviving contact', async () => {
    const { id, contactId } = await sendTo('merged@example.com');
    const survivor = db.op('contacts.create', {
      given_name: 'Rita',
      emails: [{ email: 'rita@example.com' }],
    });
    db.op('contacts.merge', { targetId: survivor.id, sourceIds: [contactId] });
    expect(await signerContact(id)).toBe(survivor.id);
    await runDue();
    expect(invites('merged@example.com')[0]?.contactId).toBe(survivor.id);
  });

  it('re-links a deleted contact so invitations and codes still go out', async () => {
    const { id, contactId } = await sendTo('deleted@example.com');
    db.op('contacts.delete', { id: contactId });
    await runDue();
    const [invite] = invites('deleted@example.com');
    expect(invite?.contactId).toBeDefined();
    expect(invite?.contactId).not.toBe(contactId);
    const live = db.op('contacts.get', { id: invite!.contactId });
    expect(live.emails.map((e) => e.email)).toContain('deleted@example.com');
    expect(await signerContact(id)).toBe(invite!.contactId);

    const other = await sendTo('code@example.com');
    await runDue();
    db.op('contacts.delete', { id: other.contactId });
    const token = signingToken(invites('code@example.com')[0]!);
    expect((await edge(`/sign/acme/${token}/otp/send`, post({}))).status).toBe(200);
    const code = emails.messages.filter((m) => m.toEmail === 'code@example.com').at(-1);
    expect(code?.source).toMatchObject({ purpose: 'esign' });
    expect(code?.contactId).not.toBe(other.contactId);
  });

  it('records emails the pipeline could not deliver in the audit trail', async () => {
    const { id } = await sendTo('bounce@example.com');
    await runDue();
    db.op('esign.mailUndelivered', {
      requestId: id,
      email: 'BOUNCE@example.com',
      reason: 'suppressed',
    });
    const trail = (await owner.get(`${BASE}/esignRequests/${id}`)).body['events'] as Array<{
      type: string;
      meta: Record<string, unknown>;
    }>;
    expect(trail.find((e) => e.type === 'notify_failed')?.meta).toMatchObject({
      to: 'bounce@example.com',
      error: 'suppressed',
    });
  });
});

describe('sealing jobs', () => {
  let templateId = '';

  beforeAll(async () => {
    templateId = await createTemplate(
      { name: 'Ricevuta', parties: [{ id: 'client', name: 'Cliente' }] },
      [field('sig', 'signature', 'client')],
    );
  });

  const completed = async (email: string) => {
    const sent = await owner.post(`${BASE}/esignRequests`, {
      template_id: templateId,
      signers: [{ party_id: 'client', email }],
    });
    await runDue();
    const signed = await sign(signingToken(invites(email)[0]!), { sig: PNG_DATA_URL });
    expect(signed.status).toBe(200);
    return String(sent.body['id']);
  };
  const detail = async (id: string) => (await owner.get(`${BASE}/esignRequests/${id}`)).body;

  it('hands a lost job out again after the lease, gives up, and seals on staff retry', async () => {
    const id = await completed('lost@example.com');
    let handedOut = 0;
    for (let round = 0; round < 12; round += 1) {
      await runDue();
      handedOut += seal.pending.splice(0).filter((job) => job.requestId === id).length;
      if (round === 0) expect((await detail(id))['finalize_next_attempt_at']).not.toBeNull();
      db.clock.now += FINALIZE_LEASE_MS + 1_000;
    }
    expect(handedOut).toBe(8);
    expect(await detail(id)).toMatchObject({ document_ready: false, finalize_next_attempt_at: null });
    expect(String((await detail(id))['finalize_error'])).toMatch(/not prepared/);

    const retried = await owner.post(`${BASE}/esignRequests/${id}/finalize`, {});
    expect(retried.body).toMatchObject({ finalize_error: null });
    const audited = await h.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'esign.request_finalize_retried' AND target = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(audited?.n).toBe(1);
    await runDue();
    await seal.drain();
    expect(await detail(id)).toMatchObject({ document_ready: true, finalize_error: null });
  });

  it('runs a duplicated job once', async () => {
    const id = await completed('twice@example.com');
    await runDue();
    const jobs = seal.pending.splice(0).filter((job) => job.requestId === id);
    expect(jobs).toHaveLength(1);
    seal.pending.push(...jobs, ...jobs);
    const before = files.objects.size;
    await seal.drain();
    expect(files.objects.size).toBe(before + 1);
    const sealedEvents = ((await detail(id))['events'] as Array<{ type: string }>).filter(
      (e) => e.type === 'document_sealed',
    );
    expect(sealedEvents).toHaveLength(1);
    expect(emails.messages.filter((m) => m.toEmail === 'twice@example.com')).toHaveLength(2);
  });

  it('seals in the alarm when no queue is bound', async () => {
    const id = await completed('inline@example.com');
    h.env.ESIGN_SEAL = undefined;
    try {
      expect(await runDue()).toMatchObject({ changed: true, failed: false });
    } finally {
      h.env.ESIGN_SEAL = seal.queue;
    }
    expect(seal.pending).toHaveLength(0);
    expect(await detail(id)).toMatchObject({ document_ready: true });
  });
});
