import type { FilterGroup, SearchQuery } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { compileSearchQuery } from '../../src/crm/search/query-builder';
import { ftsMatchExpression, searchTerms } from '../../src/crm/search/index-store';
import { createTestTenant, VIEWER_ACTOR, type TestTenant } from './helpers';

interface Fixture {
  t: TestTenant;
  tags: Record<'vip' | 'customer' | 'lead' | 'newsletter', string>;
  ids: Record<string, string>;
}

function fixture(mode: 'fts5' | 'trigram' = 'fts5'): Fixture {
  const t = createTestTenant(mode);
  const tag = (name: string) => t.op('tags.create', { name }).id;
  const tags = {
    vip: tag('VIP'),
    customer: tag('Customer'),
    lead: tag('Lead'),
    newsletter: tag('Newsletter'),
  };
  t.op('customFields.create', {
    entity: 'contact',
    data: {
      key: 'plan',
      label: 'Plan',
      type: 'DROPDOWN',
      options: [
        { value: 'free', label: 'Free' },
        { value: 'pro', label: 'Pro' },
        { value: 'team', label: 'Team' },
      ],
    },
  });
  t.op('customFields.create', {
    entity: 'contact',
    data: { key: 'ltv', label: 'LTV', type: 'CURRENCY' },
  });
  t.op('customFields.create', {
    entity: 'contact',
    data: {
      key: 'interests',
      label: 'Interests',
      type: 'LIST_BOX',
      options: [
        { value: 'email', label: 'Email' },
        { value: 'ads', label: 'Ads' },
      ],
    },
  });
  t.op('customFields.create', {
    entity: 'contact',
    data: { key: 'renewal', label: 'Renewal', type: 'DATE' },
  });
  t.op('customFields.create', {
    entity: 'contact',
    data: { key: 'tax', label: 'Tax', type: 'SOCIAL_SECURITY_NUMBER' },
  });
  const acme = t.op('companies.create', {
    name: 'Acme Robotics',
    website: 'https://acme.example.com',
  });

  const ids: Record<string, string> = {};
  const add = (key: string, input: Parameters<TestTenant['op']>[1] & object) => {
    ids[key] = (t.op('contacts.create', input as never) as { id: string }).id;
  };
  add('giulia', {
    given_name: 'Giulia',
    family_name: 'Rossi',
    owner_id: 'owner_a',
    company_id: acme.id,
    emails: [{ email: 'giulia.rossi@example.com' }],
    addresses: [{ locality: 'Milano', country_code: 'IT' }],
    tag_ids: [tags.vip, tags.customer],
    score_value: 90,
    custom_fields: {
      plan: 'pro',
      ltv: 1200.5,
      interests: ['email', 'ads'],
      renewal: '2026-12-01',
      tax: 'RSSGLI80A01F205X',
    },
  });
  add('marco', {
    given_name: 'Marco',
    family_name: 'Bianchi',
    owner_id: 'owner_b',
    emails: [{ email: 'marco@shop.example.org' }],
    addresses: [{ locality: 'Roma', country_code: 'IT' }],
    tag_ids: [tags.customer, tags.newsletter],
    score_value: 40,
    custom_fields: { plan: 'team', ltv: 300 },
  });
  add('lea', {
    given_name: 'Léa',
    family_name: 'Dubois',
    owner_id: 'owner_a',
    emails: [{ email: 'lea.dubois@example.fr' }],
    addresses: [{ locality: 'Paris', country_code: 'FR' }],
    tag_ids: [tags.lead],
    score_value: 10,
    custom_fields: { plan: 'free', interests: ['email'] },
  });
  add('noemail', {
    given_name: 'Zed',
    family_name: 'Nobody',
    tag_ids: [tags.lead, tags.newsletter],
  });
  add('john', {
    given_name: 'John',
    family_name: 'Smith',
    emails: [{ email: 'john@acme.example.com' }],
    job_title: 'CTO',
    tag_ids: [tags.vip],
    score_value: 75,
    custom_fields: { plan: 'pro', ltv: 5000, renewal: '2027-03-15' },
  });
  return { t, tags, ids };
}

function run(
  f: Fixture,
  query: Omit<SearchQuery, 'entity'> & { entity?: SearchQuery['entity'] },
  actor = undefined,
) {
  return f.t.op('search.query', { entity: 'contact', ...query } as SearchQuery, actor);
}

function idsOf(f: Fixture, query: Omit<SearchQuery, 'entity'>): string[] {
  const keyById = new Map(Object.entries(f.ids).map(([k, v]) => [v, k]));
  return run(f, { ...query, columns: ['id'], limit: 500 })
    .data.map((row) => keyById.get(String(row['id'])) ?? '?')
    .sort();
}

const where = (...conditions: FilterGroup['conditions']): FilterGroup => ({
  type: 'group',
  op: 'and',
  conditions,
});

describe('query builder -> SQL', () => {
  it('compiles to parameterized SQL (no user values in the SQL text)', () => {
    const f = fixture();
    const compiled = compileSearchQuery(f.t.ctx(), {
      entity: 'contact',
      q: "o'reilly",
      filter: where(
        {
          type: 'field',
          field: 'given_name',
          operator: 'starts_with',
          value: "Robert'); DROP TABLE crm_contacts;--",
        },
        { type: 'field', field: 'custom.plan', operator: 'in', value: ['pro', 'team'] },
        { type: 'tags', match: 'all', tag_ids: [f.tags.vip, f.tags.customer] },
      ),
      sort: { field: 'custom.ltv', direction: 'desc' },
    });
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.sql).not.toContain('reilly');
    expect(compiled.sql).toContain('crm_custom_field_values');
    expect(compiled.sql).toContain('crm_contact_tags');
    expect(compiled.params).toContain("Robert'); DROP TABLE crm\\_contacts;--%");
    expect(compiled.sql.split('?').length - 1).toBe(compiled.params.length);
    // Executes fine and the table still exists.
    expect(f.t.db.all(compiled.sql, ...compiled.params)).toEqual([]);
    expect(f.t.db.all(`SELECT COUNT(*) AS n FROM crm_contacts`)).toEqual([{ n: 5 }]);
  });

  it('text operators', () => {
    const f = fixture();
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'family_name', operator: 'equals', value: 'rossi' }),
      }),
    ).toEqual(['giulia']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'email',
          operator: 'contains',
          value: 'example.com',
        }),
      }),
    ).toEqual(['giulia', 'john']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'email', operator: 'ends_with', value: '.fr' }),
      }),
    ).toEqual(['lea']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'given_name', operator: 'starts_with', value: 'Ma' }),
      }),
    ).toEqual(['marco']);
    expect(
      idsOf(f, { filter: where({ type: 'field', field: 'email', operator: 'is_empty' }) }),
    ).toEqual(['noemail']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'email',
          operator: 'not_contains',
          value: 'example',
        }),
      }),
    ).toEqual(['noemail']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'country_code', operator: 'in', value: ['FR'] }),
      }),
    ).toEqual(['lea']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'company_name',
          operator: 'contains',
          value: 'robot',
        }),
      }),
    ).toEqual(['giulia']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'any_email',
          operator: 'equals',
          value: 'MARCO@shop.example.org',
        }),
      }),
    ).toEqual(['marco']);
  });

  it('number, owner and date range operators', () => {
    const f = fixture();
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'score_value', operator: 'gt', value: 50 }),
      }),
    ).toEqual(['giulia', 'john']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'score_value',
          operator: 'between',
          value: [10, 40],
        }),
      }),
    ).toEqual(['lea', 'marco']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'owner_id', operator: 'equals', value: 'owner_a' }),
      }),
    ).toEqual(['giulia', 'lea']);
    expect(
      idsOf(f, { filter: where({ type: 'field', field: 'owner_id', operator: 'is_empty' }) }),
    ).toEqual(['john', 'noemail']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'created_at', operator: 'gte', value: '2026-10-15' }),
      }),
    ).toHaveLength(5);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'created_at', operator: 'lt', value: '2026-10-15' }),
      }),
    ).toEqual([]);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'updated_at',
          operator: 'equals',
          value: '2026-10-15',
        }),
      }),
    ).toHaveLength(5);
  });

  it('tags ANY / ALL / NONE', () => {
    const f = fixture();
    const { vip, customer, lead } = f.tags;
    expect(
      idsOf(f, { filter: where({ type: 'tags', match: 'any', tag_ids: [vip, lead] }) }),
    ).toEqual(['giulia', 'john', 'lea', 'noemail']);
    expect(
      idsOf(f, { filter: where({ type: 'tags', match: 'all', tag_ids: [vip, customer] }) }),
    ).toEqual(['giulia']);
    expect(
      idsOf(f, { filter: where({ type: 'tags', match: 'none', tag_ids: [customer, lead] }) }),
    ).toEqual(['john']);
  });

  it('custom fields per type, OR groups and nesting', () => {
    const f = fixture();
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'custom.plan', operator: 'equals', value: 'pro' }),
      }),
    ).toEqual(['giulia', 'john']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'custom.plan', operator: 'not_in', value: ['pro'] }),
      }),
    ).toEqual(['lea', 'marco', 'noemail']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'custom.ltv', operator: 'gte', value: 1000 }),
      }),
    ).toEqual(['giulia', 'john']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'custom.interests',
          operator: 'contains',
          value: 'ads',
        }),
      }),
    ).toEqual(['giulia']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'custom.interests',
          operator: 'in',
          value: ['email'],
        }),
      }),
    ).toEqual(['giulia', 'lea']);
    expect(
      idsOf(f, {
        filter: where({ type: 'field', field: 'custom.interests', operator: 'is_empty' }),
      }),
    ).toEqual(['john', 'marco', 'noemail']);
    expect(
      idsOf(f, {
        filter: where({
          type: 'field',
          field: 'custom.renewal',
          operator: 'between',
          value: ['2026-11-01', '2026-12-31'],
        }),
      }),
    ).toEqual(['giulia']);
    expect(
      idsOf(f, {
        filter: {
          type: 'group',
          op: 'or',
          conditions: [
            { type: 'field', field: 'custom.plan', operator: 'equals', value: 'free' },
            {
              type: 'group',
              op: 'and',
              conditions: [
                { type: 'tags', match: 'any', tag_ids: [f.tags.newsletter] },
                { type: 'field', field: 'score_value', operator: 'lt', value: 50 },
              ],
            },
          ],
        },
      }),
    ).toEqual(['lea', 'marco', 'noemail']);
  });

  it('rejects unknown fields, invalid operators/values and sensitive fields without permission', () => {
    const f = fixture();
    expect(() =>
      run(f, { filter: where({ type: 'field', field: 'nope', operator: 'equals', value: 1 }) }),
    ).toThrow(/unknown field/);
    expect(() =>
      run(f, {
        filter: where({ type: 'field', field: 'score_value', operator: 'starts_with', value: '1' }),
      }),
    ).toThrow(/not valid/);
    expect(() =>
      run(f, {
        filter: where({ type: 'field', field: 'custom.plan', operator: 'equals', value: 'gold' }),
      }),
    ).toThrow(/not one of/);
    expect(() =>
      run(f, {
        filter: where({ type: 'field', field: 'birthday', operator: 'gt', value: 'yesterday' }),
      }),
    ).toThrow(/date/);
    expect(() =>
      run(f, {
        filter: where({ type: 'field', field: 'score_value', operator: 'between', value: [1] }),
      }),
    ).toThrow(/between/);
    expect(() =>
      f.t.op(
        'search.query',
        {
          entity: 'contact',
          filter: where({ type: 'field', field: 'custom.tax', operator: 'is_not_empty' }),
        },
        VIEWER_ACTOR,
      ),
    ).toThrow(/forbidden/);
    expect(() =>
      f.t.op('search.query', {
        entity: 'company',
        filter: where({ type: 'tags', match: 'any', tag_ids: [f.tags.vip] }),
      }),
    ).toThrow(/only apply to contacts/);
  });

  it('selects columns (custom fields, tags, masked for viewers) and paginates with a keyset cursor', () => {
    const f = fixture();
    const first = run(f, {
      columns: [
        'given_name',
        'custom.plan',
        'custom.interests',
        'tags',
        'custom.tax',
        'created_at',
      ],
      sort: { field: 'score_value', direction: 'desc' },
      limit: 2,
      include_total: true,
    });
    expect(first.columns).toEqual([
      'id',
      'given_name',
      'custom.plan',
      'custom.interests',
      'tags',
      'custom.tax',
      'created_at',
    ]);
    expect(first.total).toBe(5);
    expect(first.data.map((r) => r['given_name'])).toEqual(['Giulia', 'John']);
    expect(first.data[0]).toMatchObject({
      'custom.plan': 'pro',
      'custom.interests': ['email', 'ads'],
      'custom.tax': 'RSSGLI80A01F205X',
    });
    expect((first.data[0]?.['tags'] as string[]).sort()).toEqual(
      [f.tags.vip, f.tags.customer].sort(),
    );
    expect(String(first.data[0]?.['created_at'])).toMatch(/^2026-10-15T/);

    const second = run(f, {
      sort: { field: 'score_value', direction: 'desc' },
      limit: 2,
      cursor: first.next_cursor ?? '',
      columns: ['given_name'],
    });
    const third = run(f, {
      sort: { field: 'score_value', direction: 'desc' },
      limit: 2,
      cursor: second.next_cursor ?? '',
      columns: ['given_name'],
    });
    expect(second.data.map((r) => r['given_name'])).toEqual(['Marco', 'Léa']);
    expect(third.data.map((r) => r['given_name'])).toEqual(['Zed']);
    expect(third.next_cursor).toBeNull();

    // Sorting by a custom field with NULLs, paging through everything.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = run(f, {
        sort: { field: 'custom.ltv', direction: 'asc' },
        limit: 2,
        columns: ['given_name'],
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.data.map((r) => String(r['given_name'])));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual(['Léa', 'Zed', 'Marco', 'Giulia', 'John']);

    const masked = f.t.op(
      'search.query',
      {
        entity: 'contact',
        columns: ['custom.tax'],
        sort: { field: 'score_value', direction: 'desc' },
        limit: 1,
      },
      VIEWER_ACTOR,
    );
    expect(masked.data[0]?.['custom.tax']).toBe('************205X');
  });

  it('describes fields and operators for the filter UI', () => {
    const f = fixture();
    const fields = f.t.op('search.fields', { entity: 'contact' });
    expect(fields.find((x) => x.field === 'custom.interests')).toMatchObject({
      kind: 'multi',
      sortable: false,
    });
    expect(fields.find((x) => x.field === 'score_value')?.operators).toContain('between');
  });
});

describe.each(['fts5', 'trigram'] as const)('full-text search (%s)', (mode) => {
  it('combines q with filters, folds diacritics, matches prefixes, and follows updates/deletes', () => {
    const f = fixture(mode);
    expect(f.t.mode).toBe(mode);
    expect(idsOf(f, { q: 'ross' })).toEqual(['giulia']);
    expect(idsOf(f, { q: 'lea' })).toEqual(['lea']);
    expect(idsOf(f, { q: 'Léa Dub' })).toEqual(['lea']);
    expect(idsOf(f, { q: 'acme' })).toEqual(['giulia', 'john']); // company name + email domain
    expect(
      idsOf(f, {
        q: 'acme',
        filter: where({ type: 'tags', match: 'any', tag_ids: [f.tags.customer] }),
      }),
    ).toEqual(['giulia']);
    expect(idsOf(f, { q: 'milano' })).toEqual(['giulia']);

    f.t.op('contacts.update', { id: f.ids['marco']!, data: { family_name: 'Verdi' } });
    expect(idsOf(f, { q: 'bianchi' })).toEqual([]);
    expect(idsOf(f, { q: 'verdi' })).toEqual(['marco']);
    f.t.op('contacts.delete', { id: f.ids['john']! });
    expect(idsOf(f, { q: 'smith' })).toEqual([]);

    // Company rename re-indexes its contacts.
    const giulia = f.t.op('contacts.get', { id: f.ids['giulia']! });
    f.t.op('companies.update', { id: giulia.company_id!, data: { name: 'Zephyr Labs' } });
    expect(idsOf(f, { q: 'zephyr' })).toEqual(['giulia']);
  });

  it('global search covers contacts, companies and notes', () => {
    const f = fixture(mode);
    f.t.op('notes.create', {
      contact_id: f.ids['lea']!,
      title: 'Kick-off',
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Discussed the quarterly roadmap' }],
          },
        ],
      },
    });
    const result = f.t.op('search.global', {
      q: 'roadmap',
      types: ['contact', 'company', 'note'],
      limit: 10,
    });
    expect(result.mode).toBe(mode);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ type: 'note', title: 'Kick-off' });
    expect(result.data[0]?.snippet).toContain('roadmap');

    const acme = f.t.op('search.global', { q: 'acme', types: ['company'], limit: 10 });
    expect(acme.data.map((h) => h.title)).toEqual(['Acme Robotics']);
    expect(f.t.op('search.global', { q: '!!!', types: ['contact'], limit: 10 }).data).toEqual([]);
  });
});

describe('fts helpers', () => {
  it('builds safe prefix MATCH expressions', () => {
    expect(searchTerms('  Léa "Dubois" OR x* ')).toEqual(['lea', 'dubois', 'or', 'x']);
    expect(ftsMatchExpression(['lea', 'dubois'])).toBe('"lea"* "dubois"*');
  });
});

describe('saved searches', () => {
  it('stores a query, executes it with paging, hides private ones and resolves members', () => {
    const f = fixture();
    const saved = f.t.op('savedSearches.create', {
      name: 'Pro customers',
      query: {
        entity: 'contact',
        filter: where({
          type: 'field',
          field: 'custom.plan',
          operator: 'in',
          value: ['pro', 'team'],
        }),
        columns: ['given_name', 'custom.plan'],
        sort: { field: 'given_name', direction: 'asc' },
        limit: 1,
        cursor: 'ignored',
      },
    });
    expect(saved.query.limit).toBeUndefined();
    expect(saved.query.cursor).toBeUndefined();

    const page1 = f.t.op('savedSearches.execute', {
      id: saved.id,
      options: { limit: 2, include_total: true },
    });
    expect(page1.total).toBe(3);
    expect(page1.data.map((r) => r['given_name'])).toEqual(['Giulia', 'John']);
    const page2 = f.t.op('savedSearches.execute', {
      id: saved.id,
      options: { limit: 2, cursor: page1.next_cursor ?? '' },
    });
    expect(page2.data.map((r) => r['given_name'])).toEqual(['Marco']);

    // Segments see live data.
    f.t.op('contacts.update', { id: f.ids['lea']!, data: { custom_fields: { plan: 'pro' } } });
    expect(f.t.op('savedSearches.memberIds', { id: saved.id }).sort()).toEqual(
      [f.ids['giulia'], f.ids['john'], f.ids['marco'], f.ids['lea']].sort(),
    );

    const mine = f.t.op('savedSearches.create', {
      name: 'Private',
      shared: false,
      query: { entity: 'contact' },
    });
    expect(f.t.op('savedSearches.list', {}).map((s) => s.name)).toEqual([
      'Private',
      'Pro customers',
    ]);
    expect(f.t.op('savedSearches.list', {}, VIEWER_ACTOR).map((s) => s.name)).toEqual([
      'Pro customers',
    ]);
    expect(() => f.t.op('savedSearches.get', { id: mine.id }, VIEWER_ACTOR)).toThrow(/not_found/);

    expect(() =>
      f.t.op('savedSearches.create', {
        name: 'Bad',
        query: { entity: 'contact', sort: { field: 'tags', direction: 'asc' } },
      }),
    ).toThrow(/cannot be used for sorting/);
  });
});
