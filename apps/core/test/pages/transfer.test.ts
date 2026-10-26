import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import type { MediaRow } from '../../src/pages/library';
import { countRelinkEmbeds, retargetString, streamPageExport, type PageManifest } from '../../src/pages/transfer';
import { fakeTenantDbNamespace } from '../crm/helpers';
import { fakeEditSessions } from '../helpers/edit-lock';
import { addMember, createHarness, login, ORIGIN, seedTenant, seedUser, type Harness, type TestClient } from '../helpers/harness';
import { fakeR2 } from './helpers';

const ACME = '/api/v2/t/acme';
const BETA = '/api/v2/t/beta';
const ACME_EDGE = 'https://t.acme.example';
const BETA_EDGE = 'https://edge.beta.example';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

let h: Harness;
let owner: TestClient;
let viewer: TestClient;
let r2: ReturnType<typeof fakeR2>;

async function raw(client: TestClient, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}) {
  return app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        origin: ORIGIN,
        'x-amable-csrf': '1',
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    },
    h.env,
  );
}

async function upload(base: string, name: string, bytes: Uint8Array): Promise<{ id: string; url: string }> {
  const res = await raw(owner, 'PUT', `${base}/media?filename=${name}`, bytes);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; url: string };
}

async function exportZip(base: string, id: string, client = owner): Promise<Uint8Array> {
  const res = await raw(client, 'GET', `${base}/pages/${id}/export`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  return new Uint8Array(await res.arrayBuffer());
}

async function importZip(base: string, zip: Uint8Array, client = owner) {
  const res = await raw(client, 'POST', `${base}/pages/import`, zip, { 'content-type': 'application/zip' });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const manifestOf = (zip: Uint8Array): PageManifest =>
  JSON.parse(new TextDecoder().decode(unzipSync(zip)['page.json'])) as PageManifest;

beforeAll(async () => {
  h = await createHarness();
  h.env.EDGE_ORIGIN = ACME_EDGE;
  h.env.TENANT_DB = fakeTenantDbNamespace();
  r2 = fakeR2();
  h.env.FILES = r2;
  h.env.EDIT_SESSION = fakeEditSessions().namespace;
  const acme = await seedTenant(h, 'acme');
  const beta = await seedTenant(h, 'beta');
  const user = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, user.id, acme.id, 'owner');
  await addMember(h, user.id, beta.id, 'owner');
  const reader = await seedUser(h, { email: 'viewer@acme.test' });
  await addMember(h, reader.id, acme.id, 'viewer');
  await addMember(h, reader.id, beta.id, 'viewer');
  owner = await login(h, user.email);
  viewer = await login(h, reader.email);
});

describe('landing page export / import', () => {
  let sourceId = '';
  let png = { id: '', url: '' };
  let jpeg = { id: '', url: '' };
  let zip: Uint8Array = new Uint8Array();

  it('exports the draft, SEO, settings and the library images it uses', async () => {
    h.env.EDGE_ORIGIN = ACME_EDGE;
    png = await upload(ACME, 'hero.png', PNG);
    jpeg = await upload(ACME, 'logo.jpg', JPEG);
    await upload(ACME, 'unused.png', new Uint8Array([...PNG, 1]));
    const created = await owner.post(`${ACME}/pages`, { title: 'Offer', path: '/offer' });
    sourceId = String(created.body['id']);
    const body = [
      {
        id: 'el_box',
        type: 'container',
        settings: { background: { url: png.url } },
        styles: [{ breakpoint: 'mobile', state: 'hover', props: { _padding: { top: 4, unit: 'px' } } }],
        children: [
          { id: 'el_img', type: 'image', settings: { image: { url: jpeg.url } } },
          { id: 'el_form', type: 'form', settings: { formId: 'frm_source' } },
          {
            id: 'el_html',
            type: 'html',
            settings: {
              html: `<div data-amable-form="frm_2" data-amable-tenant="acme" data-amable-page="${sourceId}"></div><script async src="${ACME_EDGE}/forms.js"></script><a href="${ACME_EDGE}/p/acme/thanks">ok</a>`,
            },
          },
        ],
      },
      { id: 'el_pop', type: 'popup', settings: { name: 'Promo' }, children: [{ id: 'el_t', type: 'heading', settings: { title: 'Hi' } }] },
    ];
    const save = await owner.request('PUT', `${ACME}/pages/${sourceId}/draft`, {
      document: { editorKind: 'canvas', body, customCss: `.promo{background:url(${png.url})}` },
      base_revision: 1,
    });
    expect(save.status).toBe(200);
    await owner.patch(`${ACME}/pages/${sourceId}`, {
      seo: { title: 'Offer SEO', og_image: png.url },
      settings: { favicon: jpeg.url, lang: 'it', analytics_site_id: 'site_1' },
    });

    zip = await exportZip(ACME, sourceId, viewer);
    const files = unzipSync(zip);
    const manifest = manifestOf(zip);
    expect(manifest).toMatchObject({
      format: 'amable-page',
      version: 1,
      source: { slug: 'acme', edge_origin: ACME_EDGE, page_id: sourceId },
      page: { title: 'Offer', path: '/offer', seo: { title: 'Offer SEO' }, settings: { lang: 'it' } },
      media_skipped: [],
    });
    expect(manifest.media.map((m) => m.filename).sort()).toEqual(['hero.png', 'logo.jpg']);
    for (const m of manifest.media) expect(files[`media/${m.file}`]?.byteLength).toBe(m.size);
    expect(JSON.stringify(manifest.page.document)).toContain('"type":"popup"');
  });

  it('imports into another installation with new media URLs, retargeted embeds and a free path', async () => {
    h.env.EDGE_ORIGIN = BETA_EDGE;
    expect((await owner.post(`${BETA}/pages`, { title: 'Taken', path: '/offer' })).status).toBe(201);
    const res = await importZip(BETA, zip);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      media_imported: 2,
      media_reused: 0,
      warnings: {
        relink: { forms: 2, bookings: 0, checkouts: 0 },
        media_missing: [],
        path_renamed: '/offer-copy',
        analytics_disconnected: true,
      },
      page: { title: 'Offer', path: '/offer-copy', host: null, status: 'draft', folder_id: null },
    });
    const page = res.body['page'];
    const text = JSON.stringify(page.draft);
    expect(text).not.toContain(ACME_EDGE);
    expect(text).not.toContain('/m/acme/');
    expect(text.match(new RegExp(`${BETA_EDGE}/m/beta/[0-9A-Z]{26}\\.(png|jpg)`, 'g'))).toHaveLength(3);
    expect(text).toContain('data-amable-tenant=\\"beta\\"');
    expect(text).toContain(`data-amable-page=\\"${page.id}\\"`);
    expect(text).toContain(`${BETA_EDGE}/forms.js`);
    expect(text).toContain(`${BETA_EDGE}/p/beta/thanks`);
    expect(text).toContain('"formId":"frm_source"');
    expect(page.draft.body[0].styles[0]).toMatchObject({ breakpoint: 'mobile', state: 'hover' });
    expect(page.seo.og_image).toMatch(new RegExp(`^${BETA_EDGE}/m/beta/[0-9A-Z]{26}\\.png$`));
    expect(page.settings).toMatchObject({ analytics_site_id: null, lang: 'it' });
    expect(page.settings.favicon).toMatch(new RegExp(`^${BETA_EDGE}/m/beta/[0-9A-Z]{26}\\.jpg$`));

    const media = await owner.get(`${BETA}/media`);
    expect((media.body['data'] as unknown[]).length).toBe(2);
  });

  it('reuses images already in the library on a second import', async () => {
    h.env.EDGE_ORIGIN = BETA_EDGE;
    const res = await importZip(BETA, zip);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ media_imported: 0, media_reused: 2, warnings: { path_renamed: '/offer-copy-2' } });
    expect(((await owner.get(`${BETA}/media`)).body['data'] as unknown[]).length).toBe(2);
  });

  it('retargets hand-written HTML pages', async () => {
    h.env.EDGE_ORIGIN = ACME_EDGE;
    const created = await owner.post(`${ACME}/pages`, {
      title: 'Raw',
      path: '/raw',
      document: {
        editorKind: 'html',
        html: `<!doctype html><img src="${png.url}"><div data-amable-booking="demo" data-amable-tenant="acme"></div><script src="${ACME_EDGE}/booking.js"></script>`,
      },
    });
    const exported = await exportZip(ACME, String(created.body['id']));
    h.env.EDGE_ORIGIN = BETA_EDGE;
    const res = await importZip(BETA, exported);
    expect(res.status).toBe(201);
    expect(res.body['warnings'].relink).toEqual({ forms: 0, bookings: 1, checkouts: 0 });
    expect(res.body['media_reused']).toBe(1);
    const html = String(res.body['page'].draft.html);
    expect(html).toContain('data-amable-tenant="beta"');
    expect(html).toContain(`${BETA_EDGE}/booking.js`);
    expect(html).toMatch(new RegExp(`<img src="${BETA_EDGE}/m/beta/[0-9A-Z]{26}\\.png">`));
    expect(res.body['page'].path).toBe('/raw');
  });

  it('reports damaged images and refuses files that are not exports', async () => {
    h.env.EDGE_ORIGIN = BETA_EDGE;
    const files = unzipSync(zip);
    const manifest = manifestOf(zip);
    const [first, second] = manifest.media;
    files[`media/${first!.file}`] = strToU8('<svg onload=alert(1)>');
    delete files[`media/${second!.file}`];
    const res = await importZip(BETA, zipSync(files));
    expect(res.status).toBe(201);
    expect([...res.body['warnings'].media_missing].sort()).toEqual([first!.filename, second!.filename].sort());

    expect((await importZip(BETA, strToU8('not a zip'))).body).toMatchObject({ error: 'invalid_archive' });
    expect((await importZip(BETA, zipSync({ 'readme.txt': strToU8('hi') }))).status).toBe(400);
    const wrong = zipSync({ 'page.json': strToU8(JSON.stringify({ ...manifest, format: 'other' })) });
    expect((await importZip(BETA, wrong)).body).toMatchObject({ error: 'invalid_archive' });
    const big = await raw(owner, 'POST', `${BETA}/pages/import`, new Uint8Array(1), {
      'content-type': 'application/zip',
      'content-length': String(60 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
  });

  it('needs pages:write to import', async () => {
    expect((await importZip(BETA, zip, viewer)).status).toBe(403);
  });
});

describe('transfer helpers', () => {
  it('skips images over the size cap or missing in R2 and lists them in the manifest', async () => {
    const bucket = fakeR2();
    await bucket.put('k/a', PNG);
    await bucket.put('k/b', JPEG);
    const row = (file: string, key: string, size: number, filename: string): MediaRow => ({
      id: file.slice(0, 26),
      r2_key: key,
      file,
      filename,
      content_type: 'image/png',
      size,
      sha256: null,
      created_at: 0,
    });
    const stream = streamPageExport({
      bucket,
      maxMediaBytes: PNG.byteLength + 1,
      manifest: {
        format: 'amable-page',
        version: 1,
        exported_at: '2026-01-01T00:00:00.000Z',
        source: { slug: 'acme', edge_origin: ACME_EDGE, page_id: 'p1' },
        page: { title: 'T', path: '/', document: { editorKind: 'canvas', body: [] }, seo: {}, settings: {} },
      },
      media: [
        row(`${'A'.repeat(26)}.png`, 'k/a', PNG.byteLength, 'a.png'),
        row(`${'B'.repeat(26)}.jpg`, 'k/b', JPEG.byteLength, 'b.jpg'),
        row(`${'C'.repeat(26)}.png`, 'k/missing', 1, 'gone.png'),
      ],
    });
    const zip = new Uint8Array(await new Response(stream).arrayBuffer());
    const manifest = manifestOf(zip);
    expect(manifest.media.map((m) => m.filename)).toEqual(['a.png']);
    expect(manifest.media_skipped).toEqual(['b.jpg', 'gone.png']);
  });

  it('leaves unknown media and foreign tenants alone', () => {
    const files = new Map([['01ARZ3NDEKTSV4RRFFQ69G5FAV.png', '01BX5ZZKBKACTAV9WEVGEMMVRZ.png']]);
    const input = { from: { edge: ACME_EDGE, slug: 'acme', pageId: 'p1' }, to: { edge: BETA_EDGE, slug: 'beta', pageId: 'p2' }, files };
    expect(retargetString(`/m/acme/01ARZ3NDEKTSV4RRFFQ69G5FAV.png`, input)).toBe(`${BETA_EDGE}/m/beta/01BX5ZZKBKACTAV9WEVGEMMVRZ.png`);
    expect(retargetString(`https://cdn.example/x.png`, input)).toBe('https://cdn.example/x.png');
    expect(retargetString(`data-amable-tenant="other"`, input)).toBe('data-amable-tenant="other"');
    expect(retargetString(`${ACME_EDGE}/p/acmecorp`, input)).toBe(`${ACME_EDGE}/p/acmecorp`);
  });

  it('counts embeds to relink', () => {
    expect(
      countRelinkEmbeds({
        editorKind: 'canvas',
        tokens: {} as never,
        body: [
          { id: 'a', type: 'booking', settings: { eventSlug: 'demo' }, styles: [], children: [], locked: false },
          { id: 'b', type: 'checkout', settings: { checkoutId: '' }, styles: [], children: [], locked: false },
          { id: 'c', type: 'checkout', settings: { checkoutId: 'co_1' }, styles: [], children: [], locked: false },
        ],
      }),
    ).toEqual({ forms: 0, bookings: 1, checkouts: 1 });
  });
});
