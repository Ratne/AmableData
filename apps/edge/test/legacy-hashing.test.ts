import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createStore, siteInit, T0 } from './helpers';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('pre-registry contact data in a site', () => {
  it('replaces clear emails, phones, names and contact traits with hashes, page by page', () => {
    const { store, db } = createStore();
    store.initSite(siteInit());
    const raw = db.raw;
    const visitor = raw.prepare(
      `INSERT INTO visitors (id, first_seen, last_seen, user_id, email, name, traits) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    visitor.run(
      'v1',
      T0,
      T0,
      'crm-42',
      'Ada@Example.com',
      'Ada Lovelace',
      '{"phone":"+39 333 1234567","plan":"pro","first_name":"Ada"}',
    );
    visitor.run('v2', T0, T0, 'bob@example.com', null, null, null);
    visitor.run('v3', T0, T0, null, sha('carl@example.com'), null, '{"plan":"free"}');
    const key = raw.prepare(
      `INSERT INTO identity_keys (key_type, key_value, visitor_id, first_seen) VALUES (?, ?, ?, ?)`,
    );
    key.run('email', 'ada@example.com', 'v1', T0);
    key.run('email', sha('ada@example.com'), 'v1', T0);
    key.run('phone', '+393331234567', 'v1', T0);
    raw
      .prepare(`INSERT INTO identity_blacklist (key_type, key_value, created_at) VALUES (?, ?, ?)`)
      .run('phone', '+390612345678', T0);
    raw
      .prepare(
        `INSERT INTO payments (transaction_id, visitor_id, ts, amount_minor, currency, email) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('tx1', 'v1', T0, 1000, 'EUR', 'ada@example.com');
    raw.prepare(`INSERT INTO ingested_events (eid, ts) VALUES ('old', ?)`).run(T0);

    let passes = 0;
    while (!store.hashLegacyIdentities(1)) passes += 1;
    expect(passes).toBeGreaterThan(1);

    expect(
      raw.prepare(`SELECT id, user_id, email, name, traits FROM visitors ORDER BY id`).all(),
    ).toEqual([
      {
        id: 'v1',
        user_id: 'crm-42',
        email: sha('ada@example.com'),
        name: null,
        traits: JSON.stringify({ phone: sha('+393331234567'), plan: 'pro' }),
      },
      { id: 'v2', user_id: null, email: sha('bob@example.com'), name: null, traits: null },
      {
        id: 'v3',
        user_id: null,
        email: sha('carl@example.com'),
        name: null,
        traits: '{"plan":"free"}',
      },
    ]);
    expect(
      raw
        .prepare(`SELECT key_type, key_value FROM identity_keys ORDER BY key_type, key_value`)
        .all(),
    ).toEqual([
      { key_type: 'email', key_value: sha('ada@example.com') },
      { key_type: 'phone', key_value: sha('+393331234567') },
    ]);
    expect(raw.prepare(`SELECT key_value FROM identity_blacklist`).all()).toEqual([
      { key_value: sha('+390612345678') },
    ]);
    expect(raw.prepare(`SELECT email FROM payments`).all()).toEqual([
      { email: sha('ada@example.com') },
    ]);
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM ingested_events`).get()).toEqual({ n: 0 });
    // A visitor found by a phone hash after the conversion is the converted one.
    expect(store.findVisitorsByKey('phone', '+39 333 1234567').map((k) => k.visitor_id)).toEqual([
      'v1',
    ]);

    // Done once: rows written later in clear (none should be) are not rescanned.
    expect(store.hashLegacyIdentities(1)).toBe(true);
  });

  it('marks a new site done on its first pass', () => {
    const { store } = createStore();
    store.initSite(siteInit());
    expect(store.hashLegacyIdentities()).toBe(true);
  });
});
