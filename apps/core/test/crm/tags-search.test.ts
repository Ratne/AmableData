import { listTagsQuerySchema } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { createTestTenant } from './helpers';

function seedTags(t: ReturnType<typeof createTestTenant>, names: string[]): Map<string, string> {
  return new Map(names.map((name) => [name, t.op('tags.create', { name }).id]));
}

describe('tag search (GET /tags?q=)', () => {
  it('lists names starting with q first, then names containing it, case-insensitively', () => {
    const t = createTestTenant();
    seedTags(t, ['Newsletter', 'news-it', 'Old news', 'VIP', 'Fake_News', 'NEWBIE']);
    const names = t.op('tags.list', { limit: 50, q: 'news' }).data.map((tag) => tag.name);
    expect(names).toEqual(['news-it', 'Newsletter', 'Fake_News', 'Old news']);
    expect(t.op('tags.list', { limit: 50, q: 'NEW' }).data.map((tag) => tag.name)).toEqual([
      'NEWBIE',
      'news-it',
      'Newsletter',
      'Fake_News',
      'Old news',
    ]);
  });

  it('treats LIKE wildcards in q literally', () => {
    const t = createTestTenant();
    seedTags(t, ['50% off', '50 off', 'a_b', 'axb']);
    expect(t.op('tags.list', { limit: 50, q: '50%' }).data.map((tag) => tag.name)).toEqual(['50% off']);
    expect(t.op('tags.list', { limit: 50, q: '_' }).data.map((tag) => tag.name)).toEqual(['a_b']);
  });

  it('paginates across the prefix and contains phases without gaps or repeats', () => {
    const t = createTestTenant();
    const names = [
      ...Array.from({ length: 7 }, (_, i) => `promo ${String(i).padStart(2, '0')}`),
      ...Array.from({ length: 6 }, (_, i) => `spring promo ${String(i)}`),
      'unrelated',
    ];
    seedTags(t, names);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = t.op('tags.list', { limit: 4, q: 'promo', ...(cursor ? { cursor } : {}) });
      seen.push(...page.data.map((tag) => tag.name));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13);
    expect(seen.slice(0, 7).every((name) => name.startsWith('promo'))).toBe(true);
    expect(seen.slice(7).every((name) => name.startsWith('spring'))).toBe(true);
    expect(pages).toBe(4);
  });

  it('serves the prefix phase from the name index', () => {
    const t = createTestTenant();
    const plan = t.db.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT id FROM crm_tags t WHERE t.deleted_at IS NULL
         AND t.name >= ? COLLATE NOCASE AND t.name < ? COLLATE NOCASE
       ORDER BY t.name COLLATE NOCASE, t.id`,
      'ab',
      'ab\u{10FFFF}',
    );
    expect(plan.map((row) => row.detail).join(' | ')).toMatch(/USING INDEX crm_tags_name/);
  });

  it('respects category and deleted tags, and fetches tags by id', () => {
    const t = createTestTenant();
    const cat = t.op('tagCategories.create', { name: 'Interests' });
    const inCat = t.op('tags.create', { name: 'Golf', category_id: cat.id });
    const free = t.op('tags.create', { name: 'Golfer' });
    const gone = t.op('tags.create', { name: 'Golf club' });
    t.op('tags.delete', { id: gone.id });
    expect(t.op('tags.list', { limit: 50, q: 'golf' }).data.map((tag) => tag.id)).toEqual([
      inCat.id,
      free.id,
    ]);
    expect(
      t.op('tags.list', { limit: 50, q: 'golf', category_id: cat.id }).data.map((tag) => tag.id),
    ).toEqual([inCat.id]);
    const byIds = t.op('tags.list', { limit: 50, ids: `${free.id},${gone.id},missing,${inCat.id}` });
    expect(byIds.data.map((tag) => tag.id)).toEqual([inCat.id, free.id]);
    expect(byIds.next_cursor).toBeNull();
  });

  it('validates the query string', () => {
    expect(listTagsQuerySchema.parse({ q: '  vip ' }).q).toBe('vip');
    const many = Array.from({ length: 101 }, (_, i) => `t${String(i)}`).join(',');
    expect(listTagsQuerySchema.safeParse({ ids: many }).success).toBe(false);
    expect(listTagsQuerySchema.safeParse({ ids: 'a,b' }).success).toBe(true);
  });
});
