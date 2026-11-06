import { beforeEach, describe, expect, it } from 'vitest';
import { randomKey } from '../../src/shortlinks/ops';
import { createTestTenant, type TestTenant } from '../crm/helpers';

let t: TestTenant;

beforeEach(() => {
  t = createTestTenant();
});

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { shape?: { code: string } }).shape?.code ?? 'thrown';
  }
  return 'none';
}

const click = (linkId: string, extra: Partial<{ country: string; bot: boolean; browser: string; referrerHost: string }> = {}) =>
  t.op('shortlinks.click', {
    linkId,
    country: extra.country ?? 'IT',
    referrerHost: extra.referrerHost ?? null,
    device: 'desktop',
    browser: extra.browser ?? 'Chrome',
    os: 'macOS',
    bot: extra.bot ?? false,
  });

describe('shortlinks ops', () => {
  it('creates links with an explicit or random key, unique per domain', () => {
    const link = t.op('shortlinks.create', {
      domain_id: 'dom_a',
      key: 'promo',
      url: 'https://example.com/offer',
      utm_source: ' news ',
      utm_campaign: '',
    });
    expect(link).toMatchObject({ key: 'promo', utm_source: 'news', utm_campaign: null, clicks: 0, archived: false });
    expect(errorCode(() => t.op('shortlinks.create', { domain_id: 'dom_a', key: 'promo', url: 'https://x.test' }))).toBe(
      'conflict',
    );
    expect(t.op('shortlinks.create', { domain_id: 'dom_b', key: 'promo', url: 'https://x.test' }).key).toBe('promo');
    const random = t.op('shortlinks.create', { domain_id: 'dom_a', url: 'https://x.test' });
    expect(random.key).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(t.op('shortlinks.create', { domain_id: 'dom_a', key: '', url: 'https://x.test' }).key).toHaveLength(7);
    expect(randomKey()).toMatch(/^[0-9A-Za-z]{7}$/);
  });

  it('updates links, rechecking the key on its domain', () => {
    const a = t.op('shortlinks.create', { domain_id: 'dom_a', key: 'a', url: 'https://a.test' });
    t.op('shortlinks.create', { domain_id: 'dom_a', key: 'b', url: 'https://b.test' });
    expect(errorCode(() => t.op('shortlinks.update', { id: a.id, data: { key: 'b' } }))).toBe('conflict');
    const updated = t.op('shortlinks.update', {
      id: a.id,
      data: { key: 'a2', title: 'Spring', pass_query: true, expires_at: '2030-01-01T00:00:00Z', archived: true },
    });
    expect(updated).toMatchObject({
      key: 'a2',
      url: 'https://a.test',
      title: 'Spring',
      pass_query: true,
      expires_at: '2030-01-01T00:00:00.000Z',
      archived: true,
    });
    expect(t.op('shortlinks.update', { id: a.id, data: { title: null, expires_at: null } })).toMatchObject({
      title: null,
      expires_at: null,
      key: 'a2',
    });
    expect(errorCode(() => t.op('shortlinks.update', { id: 'nope', data: { title: 'x' } }))).toBe('not_found');
  });

  it('lists with folder, domain, search and archived filters', () => {
    const folder = t.op('shortlinks.folders.create', { name: 'Spring' });
    t.op('shortlinks.create', { domain_id: 'dom_a', key: 'one', url: 'https://one.test', folder_id: folder.id });
    t.op('shortlinks.create', { domain_id: 'dom_b', key: 'two', url: 'https://two.test', title: '50% off' });
    t.op('shortlinks.create', { domain_id: 'dom_a', key: 'old', url: 'https://old.test', archived: true });
    const keys = (input: Parameters<typeof t.op<'shortlinks.list'>>[1]) =>
      t.op('shortlinks.list', input).data.map((l) => l.key).sort();
    expect(keys({})).toEqual(['one', 'two']);
    expect(keys({ include_archived: 'true' })).toEqual(['old', 'one', 'two']);
    expect(keys({ folder_id: folder.id })).toEqual(['one']);
    expect(keys({ folder_id: 'none' })).toEqual(['two']);
    expect(keys({ domain_id: 'dom_a', include_archived: 'true' })).toEqual(['old', 'one']);
    expect(keys({ q: '50%' })).toEqual(['two']);
    expect(keys({ q: 'one.test' })).toEqual(['one']);
  });

  it('keeps folders with bound domains and restricts their links', () => {
    const folder = t.op('shortlinks.folders.create', { name: 'Promo', domain_ids: ['dom_a', 'dom_a'] });
    expect(folder).toMatchObject({ name: 'Promo', domain_ids: ['dom_a'], link_count: 0 });
    expect(
      errorCode(() => t.op('shortlinks.create', { domain_id: 'dom_b', url: 'https://x.test', folder_id: folder.id })),
    ).toBe('validation_failed');
    expect(
      errorCode(() => t.op('shortlinks.create', { domain_id: 'dom_a', url: 'https://x.test', folder_id: 'missing' })),
    ).toBe('validation_failed');
    const link = t.op('shortlinks.create', { domain_id: 'dom_a', url: 'https://x.test', folder_id: folder.id });
    expect(errorCode(() => t.op('shortlinks.update', { id: link.id, data: { domain_id: 'dom_b' } }))).toBe(
      'validation_failed',
    );
    expect(t.op('shortlinks.folders.update', { id: folder.id, data: { name: 'Promo 2', domain_ids: [] } })).toMatchObject({
      name: 'Promo 2',
      domain_ids: [],
      link_count: 1,
    });
    expect(t.op('shortlinks.update', { id: link.id, data: { domain_id: 'dom_b' } }).domain_id).toBe('dom_b');
    expect(t.op('shortlinks.folders.delete', { id: folder.id })).toEqual({ id: folder.id, deleted: true, moved_links: 1 });
    expect(t.op('shortlinks.list', {}).data[0]?.folder_id).toBeNull();
    expect(t.op('shortlinks.folders.list', {} as never).data).toHaveLength(0);
  });

  it('resolves active links for the edge and ignores archived ones', () => {
    const link = t.op('shortlinks.create', {
      domain_id: 'dom_a',
      key: 'go',
      url: 'https://example.com/?a=1',
      utm_source: 'news',
      utm_medium: 'email',
      pass_query: true,
      expires_at: '2030-01-01T00:00:00Z',
      expired_url: 'https://example.com/over',
      og_title: 'Hello',
    });
    expect(t.op('shortlinks.resolve', { domainId: 'dom_a', key: 'go' })).toEqual({
      id: link.id,
      url: 'https://example.com/?a=1',
      utm: { utm_source: 'news', utm_medium: 'email' },
      passQuery: true,
      expiresAt: Date.parse('2030-01-01T00:00:00Z'),
      expiredUrl: 'https://example.com/over',
      ogTitle: 'Hello',
      ogDescription: null,
      ogImage: null,
    });
    expect(t.op('shortlinks.resolve', { domainId: 'dom_b', key: 'go' })).toBeNull();
    t.op('shortlinks.update', { id: link.id, data: { archived: true } });
    expect(t.op('shortlinks.resolve', { domainId: 'dom_a', key: 'go' })).toBeNull();
  });

  it('counts clicks and aggregates daily statistics', () => {
    const link = t.op('shortlinks.create', { domain_id: 'dom_a', key: 'go', url: 'https://x.test' });
    click(link.id);
    click(link.id, { referrerHost: 'Instagram.com' });
    click(link.id, { country: 'DE', browser: 'Firefox' });
    click(link.id, { bot: true, browser: 'Unknown' });
    t.clock.now += 86_400_000;
    click(link.id, { country: 'IT' });
    expect(t.op('shortlinks.click', { linkId: 'gone', country: null, referrerHost: null, device: null, browser: null, os: null, bot: false })).toEqual({
      ok: true,
    });

    const stats = t.op('shortlinks.stats', { id: link.id, days: 7 });
    expect(stats).toMatchObject({ days: 7, total_clicks: 5, human_clicks: 4, bot_clicks: 1 });
    expect(stats.series).toHaveLength(7);
    expect(stats.series.slice(-2).map((p) => [p.humans, p.bots])).toEqual([
      [3, 1],
      [1, 0],
    ]);
    expect(stats.countries).toEqual([
      { value: 'IT', clicks: 3 },
      { value: 'DE', clicks: 1 },
    ]);
    expect(stats.referrers).toEqual([
      { value: '', clicks: 3 },
      { value: 'instagram.com', clicks: 1 },
    ]);
    expect(stats.browsers).toEqual([
      { value: 'Chrome', clicks: 3 },
      { value: 'Firefox', clicks: 1 },
    ]);
    expect(stats.devices).toEqual([{ value: 'desktop', clicks: 4 }]);
    expect(t.op('shortlinks.stats', { id: link.id, days: 1 })).toMatchObject({ human_clicks: 1, bot_clicks: 0, total_clicks: 5 });
    expect(t.op('shortlinks.list', {}).data[0]?.clicks).toBe(5);
  });

  it('deletes links with their statistics and cascades a removed domain', () => {
    const a = t.op('shortlinks.create', { domain_id: 'dom_a', key: 'a', url: 'https://a.test' });
    const b = t.op('shortlinks.create', { domain_id: 'dom_b', key: 'b', url: 'https://b.test' });
    const folder = t.op('shortlinks.folders.create', { name: 'F', domain_ids: ['dom_a', 'dom_b'] });
    click(a.id);
    click(b.id);
    expect(t.op('shortlinks.delete', { id: b.id }).key).toBe('b');
    expect(t.db.all(`SELECT * FROM short_link_clicks_daily WHERE link_id = ?`, b.id)).toHaveLength(0);
    expect(t.op('shortlinks.domain_deleted', { domainId: 'dom_a' })).toEqual({ deleted_links: 1 });
    expect(t.op('shortlinks.list', { include_archived: 'true' }).data).toHaveLength(0);
    expect(t.db.all(`SELECT * FROM short_link_clicks_daily`)).toHaveLength(0);
    expect(t.op('shortlinks.folders.list', {} as never).data.find((f) => f.id === folder.id)?.domain_ids).toEqual(['dom_b']);
  });
});
