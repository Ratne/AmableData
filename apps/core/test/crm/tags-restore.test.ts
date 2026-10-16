import { describe, expect, it } from 'vitest';
import { createTestTenant } from './helpers';

describe('tag delete and restore', () => {
  it('hides a deleted tag everywhere and brings its contact links back on restore', () => {
    const t = createTestTenant();
    const vip = t.op('tags.create', { name: 'VIP' });
    const lead = t.op('tags.create', { name: 'Lead' });
    const ada = t.op('contacts.create', { given_name: 'Ada', tag_ids: [vip.id, lead.id] });
    const bob = t.op('contacts.create', { given_name: 'Bob', tag_ids: [vip.id] });
    const vipSearch = (match: 'any' | 'all' | 'none') =>
      t
        .op('search.query', {
          entity: 'contact',
          filter: {
            type: 'group',
            op: 'and',
            conditions: [{ type: 'tags', match, tag_ids: [vip.id] }],
          },
          columns: ['tags'],
        })
        .data.map((row) => row['id'])
        .sort();

    expect(vipSearch('any')).toEqual([ada.id, bob.id].sort());

    t.op('tags.delete', { id: vip.id });
    expect(t.op('contacts.get', { id: ada.id }).tag_ids).toEqual([lead.id]);
    expect(t.op('contacts.get', { id: bob.id }).tag_ids).toEqual([]);
    expect(t.op('tags.list', { limit: 50 }).data.map((tag) => tag.id)).toEqual([lead.id]);
    // Saved searches still referencing the deleted tag match nobody (any/all) / everybody (none).
    expect(vipSearch('any')).toEqual([]);
    expect(vipSearch('all')).toEqual([]);
    expect(vipSearch('none')).toEqual([ada.id, bob.id].sort());
    expect(() => t.op('tags.get', { id: vip.id })).toThrow();

    const restored = t.op('tags.restore', { id: vip.id });
    expect(restored).toMatchObject({ id: vip.id, name: 'VIP', contact_count: 2 });
    expect(t.op('contacts.get', { id: ada.id }).tag_ids.sort()).toEqual([vip.id, lead.id].sort());
    expect(vipSearch('all')).toEqual([ada.id, bob.id].sort());
    // Restoring an active tag is a no-op.
    expect(t.op('tags.restore', { id: vip.id }).id).toBe(vip.id);
  });

  it('refuses to restore when a live tag took the same name, and 404s unknown ids', () => {
    const t = createTestTenant();
    const old = t.op('tags.create', { name: 'Customer' });
    t.op('tags.delete', { id: old.id });
    t.op('tags.create', { name: 'customer' });
    expect(() => t.op('tags.restore', { id: old.id })).toThrow(/already exists/);
    expect(() => t.op('tags.restore', { id: 'missing' })).toThrow(/not found|missing/i);
  });
});
