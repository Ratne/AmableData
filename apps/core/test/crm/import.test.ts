import { describe, expect, it } from 'vitest';
import { CsvParser, detectDelimiter, parseCsv } from '../../src/crm/import/csv';
import { mapRow, validateMapping } from '../../src/crm/import/mapping';
import { createTestTenant, outbox } from './helpers';

describe('CSV parser', () => {
  it('handles quotes, escaped quotes, embedded delimiters/newlines, CRLF and BOM', () => {
    const text =
      '\uFEFFname,notes\r\n"Rossi, Mario","He said ""hi""\nthen left"\r\nBianchi,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Rossi, Mario', 'He said "hi"\nthen left'],
      ['Bianchi', ''],
    ]);
  });

  it('gives the same rows however the stream is chunked', () => {
    const text = 'a;b;c\n"x;1";"q""uote";z\r\nlast;row;"end"';
    const expected = parseCsv(text, ';');
    for (let size = 1; size <= text.length; size += 1) {
      const parser = new CsvParser(';');
      const rows: string[][] = [];
      for (let i = 0; i < text.length; i += size)
        rows.push(...parser.push(text.slice(i, i + size)));
      rows.push(...parser.finish());
      expect(rows).toEqual(expected);
    }
    expect(expected).toEqual([
      ['a', 'b', 'c'],
      ['x;1', 'q"uote', 'z'],
      ['last', 'row', 'end'],
    ]);
  });

  it('detects the delimiter and enforces limits', () => {
    expect(detectDelimiter('Nome;Cognome;Email')).toBe(';');
    expect(detectDelimiter('a,b;c,d')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(() =>
      new CsvParser(',', { maxFieldLength: 5, maxColumns: 10 }).push('abcdefgh'),
    ).toThrow(/longer/);
  });
});

describe('import mapping', () => {
  const header = [
    'First',
    'Last',
    'E-mail',
    'Mobile',
    'City',
    'Country',
    'Tags',
    'Plan',
    'Company',
    'Skip',
  ];
  const mapping = {
    First: 'given_name',
    Last: 'family_name',
    'E-mail': 'email',
    Mobile: 'phone',
    City: 'address.locality',
    Country: 'address.country_code',
    Tags: 'tags',
    Plan: 'custom.plan',
    Company: 'company_name',
    Skip: 'ignore',
  };

  it('validates targets and custom field keys', () => {
    expect(validateMapping(mapping, new Set(['plan']))).toEqual([]);
    expect(validateMapping({ ...mapping, Plan: 'custom.nope' }, new Set(['plan']))).toEqual([
      'column "Plan": unknown custom field "custom.nope"',
    ]);
    expect(validateMapping({ A: 'email', B: 'email' }, new Set())).toEqual([
      'target "email" is mapped more than once',
    ]);
    expect(validateMapping({ A: 'bogus' }, new Set())).toEqual([
      'column "A": unknown target "bogus"',
    ]);
    expect(validateMapping({ A: 'ignore' }, new Set())).toEqual(['mapping has no target columns']);
  });

  it('maps a row to contact input, tags, company and custom fields', () => {
    const row = [
      'Mario',
      'Rossi',
      'MARIO@Example.com',
      '+39 333 000111',
      'Milano',
      'it',
      'VIP; Newsletter ;',
      'Pro',
      'Acme',
      'x',
    ];
    expect(mapRow(header, row, mapping, ';')).toEqual({
      contact: {
        given_name: 'Mario',
        family_name: 'Rossi',
        emails: [{ email: 'mario@example.com' }],
        phones: [{ number: '+39 333 000111' }],
        addresses: [{ type: 'billing', locality: 'Milano', country_code: 'IT' }],
        custom_fields: { plan: 'Pro' },
      },
      tagNames: ['VIP', 'Newsletter'],
      companyName: 'Acme',
      leadSourceName: null,
      primaryEmail: 'mario@example.com',
    });
  });
});

describe('contact import', () => {
  it('creates and updates contacts, applies tags, fills custom fields and reports bad rows', () => {
    const t = createTestTenant();
    t.op('customFields.create', {
      entity: 'contact',
      data: {
        key: 'plan',
        label: 'Plan',
        type: 'DROPDOWN',
        options: [
          { value: 'free', label: 'Free' },
          { value: 'pro', label: 'Pro' },
        ],
      },
    });
    t.op('customFields.create', {
      entity: 'contact',
      data: { key: 'seats', label: 'Seats', type: 'WHOLE_NUMBER' },
    });
    const existing = t.op('contacts.create', {
      given_name: 'Old',
      emails: [{ email: 'mario@example.com' }],
    });
    const imported = t.op('tags.create', { name: 'Imported' });

    const job = t.op('imports.create', {
      entity: 'contact',
      mapping: {
        Name: 'name',
        Email: 'email',
        Plan: 'custom.plan',
        Seats: 'custom.seats',
        Tags: 'tags',
        Company: 'company_name',
        Source: 'lead_source',
      },
      options: { tag_ids: [imported.id], list_delimiter: '|' },
    });
    expect(job.status).toBe('pending');
    const rows = parseCsv(
      [
        'Name,Email,Plan,Seats,Tags,Company,Source',
        'Mario Rossi,mario@example.com,Pro,5,VIP|Newsletter,Acme,Webinar',
        'Anna Neri,anna@example.com,free,,,Acme,',
        'Bad Plan,bad@example.com,Gold,1,,,',
        'No Email,not-an-email,,,,,',
        ',,,,,,',
        'Seats Wrong,seats@example.com,,many,,,',
      ].join('\n'),
    );
    const [header, ...data] = rows;
    const afterBatch = t.op('imports.rows', {
      importId: job.id,
      header: header!,
      rows: data,
      firstRowNumber: 1,
    });
    expect(afterBatch).toMatchObject({
      status: 'running',
      total_rows: 5,
      created: 1,
      updated: 1,
      failed: 3,
    });
    expect(afterBatch.errors.map((e) => e.row)).toEqual([3, 4, 6]); // blank row 5 skipped
    expect(afterBatch.errors[0]?.message).toMatch(/Gold/);
    expect(afterBatch.errors[2]?.message).toMatch(/whole number/);

    const finished = t.op('imports.finish', { importId: job.id });
    expect(finished.status).toBe('completed');
    expect(finished.finished_at).not.toBeNull();

    const mario = t.op('contacts.get', { id: existing.id });
    expect(mario).toMatchObject({
      given_name: 'Mario',
      family_name: 'Rossi',
      custom_fields: { plan: 'pro', seats: 5 },
    });
    const tagNames = t
      .op('tags.list', { limit: 50 })
      .data.filter((tag) => mario.tag_ids.includes(tag.id))
      .map((tag) => tag.name);
    expect(tagNames.sort()).toEqual(['Imported', 'Newsletter', 'VIP']);
    expect(t.op('leadSources.list', {}).map((s) => s.name)).toEqual(['Webinar']);

    const anna = t.op('contacts.list', { limit: 10, email: 'anna@example.com' }).data[0];
    expect(anna).toMatchObject({
      given_name: 'Anna',
      family_name: 'Neri',
      source_type: 'import',
      custom_fields: { plan: 'free' },
    });
    expect(anna?.company_id).toBe(mario.company_id);
    expect(t.op('companies.list', { limit: 10 }).data.map((c) => c.name)).toEqual(['Acme']);

    const types = outbox(t).map((e) => e.type);
    expect(types.filter((x) => x === 'contact.created')).toHaveLength(2); // existing + Anna
    expect(types).toContain('contact.updated');
    expect(types[types.length - 1]).toBe('import.completed');
    expect(() =>
      t.op('imports.rows', { importId: job.id, header: header!, rows: [], firstRowNumber: 99 }),
    ).toThrow(/already completed/);
  });

  it('rejects a mapping with unknown targets', () => {
    const t = createTestTenant();
    expect(() =>
      t.op('imports.create', { entity: 'contact', mapping: { A: 'custom.missing' } }),
    ).toThrow(/unknown custom field/);
  });
});
