import { isHtmlDocument, type BuilderDocumentInput, type ElementNode, type PageDocument } from '@amable/builder';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestTenant, type TestTenant } from '../crm/helpers';

let t: TestTenant;

beforeEach(() => {
  t = createTestTenant();
});

function doc(title = 'Hello'): BuilderDocumentInput {
  return {
    editorKind: 'canvas',
    body: [
      {
        id: 'root',
        type: 'container',
        children: [
          { id: 'h', type: 'heading', settings: { title } },
          { id: 't', type: 'text', settings: { editor: '<p>Hi</p><script>alert(1)</script><img src=x onerror=alert(1)>' } },
        ],
      },
    ],
  };
}

function body(document: PageDocument | undefined): ElementNode[] {
  if (document === undefined) return [];
  if (isHtmlDocument(document)) throw new Error('expected a canvas document');
  return document.body;
}

function outbox(type: string): Array<Record<string, unknown>> {
  return t.db
    .all<{ payload: string }>(`SELECT payload FROM crm_outbox WHERE type = ? ORDER BY occurred_at`, type)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { shape?: { code: string } }).shape?.code ?? 'thrown';
  }
  return 'none';
}

describe('pages ops', () => {
  it('creates pages with a normalized path, unique per host', () => {
    const page = t.op('pages.create', { title: 'Launch', path: 'Promo//Spring/' });
    expect(page).toMatchObject({ path: '/promo/spring', host: null, status: 'draft', draft_revision: 1 });
    expect(body(page.draft)).toHaveLength(1);
    expect(errorCode(() => t.op('pages.create', { title: 'Dup', path: '/promo/spring' }))).toBe('conflict');
    expect(t.op('pages.create', { title: 'Other host', path: '/promo/spring', host: 'www.acme.test' }).host).toBe('www.acme.test');
    expect(errorCode(() => t.op('pages.create', { title: 'Bad', path: '/../x' }))).toBe('validation_failed');
    expect(errorCode(() => t.op('pages.create', { title: 'Reserved', path: '/m/file' }))).toBe('validation_failed');
  });

  it('saves drafts with optimistic revisions and sanitizes rich text', () => {
    const page = t.op('pages.create', { title: 'P', path: '/p1' });
    expect(t.op('pages.saveDraft', { id: page.id, document: doc(), base_revision: 1 })).toEqual({ ok: true, draft_revision: 2 });
    expect(t.op('pages.saveDraft', { id: page.id, document: doc(), base_revision: 1 })).toEqual({
      ok: false,
      error: 'stale_draft',
      draft_revision: 2,
    });
    const stored = t.op('pages.get', { id: page.id });
    const text = body(stored.draft)[0]?.children[1]?.settings['editor'];
    expect(text).toContain('<p>Hi</p>');
    expect(String(text)).not.toMatch(/script|onerror/);
    expect(
      errorCode(() =>
        t.op('pages.saveDraft', { id: page.id, document: { body: [{ id: 'x', type: 'nope' }] }, base_revision: 2 }),
      ),
    ).toBe('validation_failed');
  });

  it('publishes versions, emits page.published / page.unpublished and restores versions', () => {
    const page = t.op('pages.create', { title: 'P', path: '/launch', document: doc('First') });
    const first = t.op('pages.publish', { id: page.id, note: 'v1' });
    expect(first.version).toMatchObject({ version: 1, note: 'v1', published_by: 'user_1' });
    expect(first.page).toMatchObject({ status: 'published', published_version_id: first.version.id });
    t.op('pages.saveDraft', { id: page.id, document: doc('Second'), base_revision: 1 });
    const second = t.op('pages.publish', { id: page.id });
    expect(second.version.version).toBe(2);
    expect(outbox('page.published')).toEqual([
      { pageId: page.id, versionId: first.version.id, version: 1, path: '/launch', host: null },
      { pageId: page.id, versionId: second.version.id, version: 2, path: '/launch', host: null },
    ]);
    expect(t.op('pages.versions', { id: page.id }).data.map((v) => v.version)).toEqual([2, 1]);

    const resolved = t.op('pages.resolve', { host: null, path: '/launch/' });
    expect(resolved?.version.id).toBe(second.version.id);
    expect(body(resolved?.document)[0]?.children[0]?.settings['title']).toBe('Second');

    const restored = t.op('pages.restoreVersion', { id: page.id, versionId: first.version.id });
    expect(restored.draft_revision).toBe(3);
    expect(body(restored.draft)[0]?.children[0]?.settings['title']).toBe('First');
    // The live page is unchanged until the next publish.
    expect(t.op('pages.resolve', { host: null, path: '/launch' })?.version.version).toBe(2);

    t.op('pages.unpublish', { id: page.id });
    expect(outbox('page.unpublished')).toEqual([{ pageId: page.id, path: '/launch', host: null }]);
    expect(t.op('pages.resolve', { host: null, path: '/launch' })).toBeNull();
  });

  it('serves pages per host, and the sitemap skips noindex pages', () => {
    const a = t.op('pages.create', { title: 'A', path: '/', host: 'www.acme.test' });
    const b = t.op('pages.create', { title: 'B', path: '/hidden', host: 'www.acme.test' });
    t.op('pages.update', { id: b.id, data: { seo: { noindex: true, title: 'Hidden' } } });
    t.op('pages.publish', { id: a.id });
    t.op('pages.publish', { id: b.id });
    expect(t.op('pages.resolve', { host: 'www.acme.test', path: '/' })?.page.id).toBe(a.id);
    expect(t.op('pages.resolve', { host: 'other.test', path: '/' })).toBeNull();
    expect(t.op('pages.resolve', { host: 'www.acme.test', path: '/hidden' })?.seo).toMatchObject({ noindex: true, title: 'Hidden' });
    expect(t.op('pages.sitemap', { host: 'www.acme.test' }).data.map((p) => p.path)).toEqual(['/']);
  });

  it('duplicates, soft-deletes and restores pages', () => {
    const page = t.op('pages.create', { title: 'Offer', path: '/offer', document: doc() });
    t.op('pages.publish', { id: page.id });
    const copy = t.op('pages.duplicate', { id: page.id });
    expect(copy).toMatchObject({ title: 'Offer (copy)', path: '/offer-copy', status: 'draft' });
    expect(t.op('pages.duplicate', { id: page.id }).path).toBe('/offer-copy-2');

    t.op('pages.delete', { id: page.id });
    expect(outbox('page.unpublished')).toHaveLength(1);
    expect(t.op('pages.resolve', { host: null, path: '/offer' })).toBeNull();
    expect(t.op('pages.list', { limit: 50, status: 'deleted' }).data.map((p) => p.id)).toEqual([page.id]);
    t.op('pages.create', { title: 'Taken', path: '/offer' });
    expect(errorCode(() => t.op('pages.restore', { id: page.id }))).toBe('conflict');
  });

  it('lists with search and cursor pagination', () => {
    for (let i = 0; i < 5; i++) t.op('pages.create', { title: `Page ${i}`, path: `/p${i}` });
    const first = t.op('pages.list', { limit: 2 });
    expect(first.data).toHaveLength(2);
    const second = t.op('pages.list', { limit: 2, cursor: first.next_cursor ?? '' });
    expect(second.data.map((p) => p.id)).not.toContain(first.data[0]?.id);
    expect(t.op('pages.list', { limit: 50, q: 'Page 3' }).data).toHaveLength(1);
  });

  it('stores saved sections with fresh ids and media metadata', () => {
    const section = t.op('pages.createSavedSection', {
      name: 'Hero',
      category: 'headers',
      node: { id: 'root', type: 'container', children: [{ id: 'h', type: 'heading' }] },
    });
    expect(section.node['id']).not.toBe('root');
    expect(t.op('pages.listSavedSections', {} as never).data).toHaveLength(1);
    expect(t.op('pages.updateSavedSection', { id: section.id, data: { name: 'Hero 2' } }).name).toBe('Hero 2');
    expect(errorCode(() => t.op('pages.createSavedSection', { name: 'Bad', node: { id: 'x', type: 'nope' } }))).toBe(
      'validation_failed',
    );
    t.op('pages.deleteSavedSection', { id: section.id });
    expect(t.op('pages.listSavedSections', {} as never).data).toHaveLength(0);

    const media = t.op('pages.createMedia', {
      id: '01HXMEDIA00000000000000000',
      r2_key: 'tenants/t/media/01HXMEDIA00000000000000000.png',
      file: '01HXMEDIA00000000000000000.png',
      filename: 'logo.png',
      content_type: 'image/png',
      size: 10,
      sha256: 'abc',
    });
    expect(t.op('pages.mediaByFile', { file: media.file })?.id).toBe(media.id);
    expect(t.op('pages.listMedia', { limit: 10 }).rows).toHaveLength(1);
    t.op('pages.deleteMedia', { id: media.id });
    expect(t.op('pages.mediaByFile', { file: media.file })).toBeNull();
  });
});
