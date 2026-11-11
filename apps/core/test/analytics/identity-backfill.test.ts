import { describe, expect, it } from 'vitest';
import { emailHash, phoneHash } from '../../src/crm/identity-hashes';
import { createTestTenant } from '../crm/helpers';

describe('identity hash backfill of existing contacts', () => {
  it('indexes contacts written before the hash index, page by page, keeping newer mappings', () => {
    const t = createTestTenant();
    const ada = t.op('contacts.create', {
      given_name: 'Ada',
      emails: [{ email: 'Ada@Example.com' }],
      phones: [{ number: '+39 333 1234567' }],
    });
    const bob = t.op('contacts.create', {
      given_name: 'Bob',
      emails: [{ email: 'bob@example.com' }],
    });
    const carl = t.op('contacts.create', {
      given_name: 'Carl',
      emails: [{ email: 'bob@example.com' }],
    });
    // As before the index existed, except a mapping written live by a later contact write.
    t.db.run(`DELETE FROM crm_identity_hashes`);
    t.db.run(
      `INSERT INTO crm_identity_hashes (kind, hash, contact_id, created_at) VALUES ('email', ?, ?, 1)`,
      emailHash('bob@example.com'),
      carl.id,
    );

    const first = t.op('analytics.backfillIdentityHashes', { limit: 2 });
    expect(first).toEqual({ indexed: 2, done: false });
    const second = t.op('analytics.backfillIdentityHashes', { limit: 2 });
    expect(second).toEqual({ indexed: 1, done: true });
    expect(t.op('analytics.backfillIdentityHashes', { limit: 2 })).toEqual({
      indexed: 0,
      done: true,
    });

    const rows = t.db.all<{ kind: string; hash: string; contact_id: string }>(
      `SELECT kind, hash, contact_id FROM crm_identity_hashes ORDER BY kind, hash`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'email', hash: emailHash('ada@example.com'), contact_id: ada.id },
        { kind: 'phone', hash: phoneHash('+393331234567'), contact_id: ada.id },
        { kind: 'email', hash: emailHash('bob@example.com'), contact_id: carl.id },
      ]),
    );
    expect(rows.some((r) => r.contact_id === bob.id)).toBe(false);
  });
});
