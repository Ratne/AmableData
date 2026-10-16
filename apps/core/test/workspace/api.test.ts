import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { fakeMailDbNamespace } from '../email/helpers';
import {
  addMember,
  createHarness,
  login,
  ORIGIN,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { fakeR2 } from '../pages/helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

let h: Harness;
let files: ReturnType<typeof fakeR2>;
let owner: TestClient;
let viewer: TestClient;

async function upload(client: TestClient, slug: string, bytes: Uint8Array) {
  const response = await app.request(
    `${ORIGIN}/api/v2/t/${slug}/settings/general/logo`,
    {
      method: 'PUT',
      headers: {
        origin: ORIGIN,
        'x-amable-csrf': '1',
        'content-type': 'application/octet-stream',
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: bytes,
    },
    h.env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  h = await createHarness();
  h.env.TENANT_DB = fakeTenantDbNamespace(() => h.clock.now);
  h.env.MAIL_DB = fakeMailDbNamespace().namespace;
  files = fakeR2();
  h.env.FILES = files;
  const tenant = await seedTenant(h, 'acme');
  await seedTenant(h, 'taken');
  const o = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, o.id, tenant.id, 'owner');
  owner = await login(h, o.email);
  const v = await seedUser(h, { email: 'viewer@acme.test' });
  await addMember(h, v.id, tenant.id, 'viewer');
  viewer = await login(h, v.email);
});

describe('general settings API', () => {
  it('lets every member read the profile and only managers the settings', async () => {
    const profile = await viewer.get('/api/v2/t/acme/workspace');
    expect(profile.status).toBe(200);
    expect(profile.body).toEqual({
      name: 'Tenant acme',
      slug: 'acme',
      logo_url: null,
      primary_color: null,
      timezone: 'UTC',
      language: null,
      country_code: null,
      currency: 'EUR',
    });
    expect((await viewer.get('/api/v2/t/acme/settings/general')).status).toBe(403);
    expect((await viewer.patch('/api/v2/t/acme/settings/general', { name: 'X' })).status).toBe(403);
    const settings = await owner.get('/api/v2/t/acme/settings/general');
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({
      previous_slugs: [],
      company: { legal_name: null, sdi_code: null },
    });
  });

  it('saves branding, regional defaults and the company profile in their shared homes', async () => {
    const res = await owner.patch('/api/v2/t/acme/settings/general', {
      name: 'Acme Italia',
      primary_color: '#1E40AF',
      timezone: 'Europe/Rome',
      language: 'it',
      country_code: 'IT',
      currency: 'CHF',
      company: {
        legal_name: 'Acme Srl',
        vat_number: 'IT01234567890',
        sdi_code: 'M5UXCR1',
        city: 'Roma',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Acme Italia',
      primary_color: '#1e40af',
      timezone: 'Europe/Rome',
      language: 'it',
      country_code: 'IT',
      currency: 'CHF',
      company: {
        legal_name: 'Acme Srl',
        vat_number: 'IT01234567890',
        sdi_code: 'M5UXCR1',
        city: 'Roma',
        pec: null,
      },
    });
    // the same values the email and e-commerce settings read
    expect((await owner.get('/api/v2/t/acme/commerce/settings')).body).toMatchObject({
      default_currency: 'CHF',
    });
    expect((await owner.get('/api/v2/t/acme/workspace')).body).toMatchObject({
      name: 'Acme Italia',
      timezone: 'Europe/Rome',
    });

    const cleared = await owner.patch('/api/v2/t/acme/settings/general', {
      company: { city: null },
      primary_color: null,
    });
    expect(cleared.body).toMatchObject({
      primary_color: null,
      company: { city: null, legal_name: 'Acme Srl' },
    });
  });

  it('rejects invalid values', async () => {
    const tz = await owner.patch('/api/v2/t/acme/settings/general', { timezone: 'Mars/Olympus' });
    expect(tz.status).toBe(422);
    expect(
      (await owner.patch('/api/v2/t/acme/settings/general', { primary_color: 'red' })).status,
    ).toBe(422);
    expect(
      (await owner.patch('/api/v2/t/acme/settings/general', { company: { sdi_code: 'bad' } }))
        .status,
    ).toBe(422);
  });

  it('renames the slug with step-up and keeps the old one resolving', async () => {
    const blocked = await owner.patch('/api/v2/t/acme/settings/general', { slug: 'acme-italia' });
    expect(blocked.status).toBe(403);
    await stepUp(h, owner);
    expect((await owner.patch('/api/v2/t/acme/settings/general', { slug: 'taken' })).status).toBe(
      409,
    );
    const renamed = await owner.patch('/api/v2/t/acme/settings/general', { slug: 'acme-italia' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ slug: 'acme-italia', previous_slugs: ['acme'] });

    // old URLs (app, API, public links) still reach the workspace, which reports its new slug
    const viaAlias = await owner.get('/api/v2/t/acme/workspace');
    expect(viaAlias.status).toBe(200);
    expect(viaAlias.body).toMatchObject({ slug: 'acme-italia' });

    // nobody else can claim the former slug
    const creator = await seedUser(h, { email: 'creator@other.test' });
    await addMember(h, creator.id, 't_taken', 'owner');
    const other = await login(h, creator.email);
    await stepUp(h, other);
    expect((await other.post('/api/tenants', { name: 'Other', slug: 'acme' })).status).toBe(409);
    expect((await other.patch('/api/v2/t/taken/settings/general', { slug: 'acme' })).status).toBe(
      409,
    );

    // renaming back reclaims the alias
    const back = await owner.patch('/api/v2/t/acme-italia/settings/general', { slug: 'acme' });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ slug: 'acme', previous_slugs: ['acme-italia'] });
  });

  it('uploads, serves and removes the logo', async () => {
    expect((await upload(owner, 'acme', new TextEncoder().encode('<svg/>'))).status).toBe(415);
    const first = await upload(owner, 'acme', PNG);
    expect(first.status).toBe(200);
    const url = first.body['logo_url'];
    expect(url).toMatch(/^\/api\/v2\/t\/acme\/workspace\/logo\?v=/);
    const served = await viewer.get(String(url));
    expect(served.status).toBe(200);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');

    const second = await upload(owner, 'acme', PNG);
    expect(second.body['logo_url']).not.toBe(url);
    expect([...files.objects.keys()].filter((key) => key.includes('/branding/'))).toHaveLength(1);

    const removed = await owner.delete('/api/v2/t/acme/settings/general/logo');
    expect(removed.body).toMatchObject({ logo_url: null });
    expect([...files.objects.keys()].filter((key) => key.includes('/branding/'))).toHaveLength(0);
    expect((await viewer.get('/api/v2/t/acme/workspace/logo')).status).toBe(404);
  });

  it('sends invitations in the workspace language', async () => {
    await stepUp(h, owner);
    const sent = h.emails.length;
    expect(
      (await owner.post('/api/t/acme/invites', { email: 'new@acme.test', role: 'viewer' })).status,
    ).toBe(201);
    const invite = await h.env.DB.prepare(`SELECT locale FROM invites WHERE email = ?`)
      .bind('new@acme.test')
      .first<{ locale: string }>();
    expect(invite?.locale).toBe('it');
    expect(h.emails.length).toBe(sent + 1);
  });
});
