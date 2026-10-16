import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { installationMigrations } from '../../packages/db/src/index.ts';
import {
  bootstrapOwnerSql,
  findD1Id,
  parseArgs,
  parseD1Id,
  renderTemplate,
  slugify,
  ulid,
  withoutCoreService,
} from '../self-host-setup.mjs';

const template = (name) => readFileSync(new URL(`../../deploy/self-host/${name}.wrangler.jsonc`, import.meta.url), 'utf8');
const ID = '3f2c1a9e-1b2c-4d5e-8f90-123456789abc';

function installationDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of installationMigrations) for (const statement of migration.statements) db.exec(statement);
  return db;
}

describe('self-host setup script', () => {
  it('parses options and rejects unsafe values', () => {
    expect(parseArgs(['--app-origin', 'https://crm.example.com/', '--deploy', '--owner-email', 'Me@Example.com'])).toMatchObject({
      appOrigin: 'https://crm.example.com',
      deploy: true,
      ownerEmail: 'me@example.com',
      dryRun: false,
    });
    expect(() => parseArgs(['--app-origin', 'http://crm.example.com'])).toThrow(/https origin/);
    expect(() => parseArgs(['--owner-email', 'me@example.com'])).toThrow(/needs --app-origin/);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
  });

  it('reads the D1 id from wrangler output', () => {
    expect(parseD1Id(`[[d1_databases]]\nbinding = "DB"\ndatabase_name = "amable-installation"\ndatabase_id = "${ID}"`)).toBe(ID);
    expect(parseD1Id(`{ "d1_databases": [{ "database_id": "${ID}" }] }`)).toBe(ID);
    expect(parseD1Id('already exists')).toBeNull();
    expect(findD1Id(JSON.stringify([{ name: 'other', uuid: 'x' }, { name: 'amable-installation', uuid: ID }]), 'amable-installation')).toBe(ID);
    expect(findD1Id('not json', 'amable-installation')).toBeNull();
  });

  it('renders production configs with every placeholder filled', () => {
    const core = renderTemplate(template('core'), {
      D1_DATABASE_ID: ID,
      APP_ORIGIN: 'https://crm.example.com',
      EDGE_ORIGIN: 'https://t.example.com',
    });
    expect(core).toContain(`"database_id": "${ID}"`);
    expect(core).toContain('"ENVIRONMENT": "production"');
    expect(core).not.toMatch(/"ENVIRONMENT":\s*"dev"/);
    expect(core).not.toContain('EMAIL_ALLOW_UNVERIFIED_DOMAIN');
    expect(() => renderTemplate(template('core'), { D1_DATABASE_ID: ID })).toThrow(/unrendered placeholder/);

    const edge = renderTemplate(template('edge'), { CORE_ORIGIN: 'https://crm.example.com' });
    expect(edge).toContain('"service": "amable-core"');
    const bootstrap = withoutCoreService(edge);
    expect(bootstrap).not.toContain('"service": "amable-core"');
    expect(bootstrap).toContain('"CORE_ORIGIN": "https://crm.example.com"');
  });

  it('creates the first workspace and owner invitation only on an empty installation', () => {
    const db = installationDb();
    const token = 'a-long-random-token-value-for-tests';
    const now = Date.UTC(2026, 9, 15);
    const sql = (tenantId) =>
      bootstrapOwnerSql({
        tenantId,
        slug: slugify("L'Atelier Été"),
        name: "L'Atelier Été",
        inviteId: ulid(now),
        email: 'owner@example.com',
        tokenHash: createHash('sha256').update(token).digest('hex'),
        now,
        expiresAt: now + 7 * 86_400_000,
      });
    db.exec(sql(ulid(now)));
    expect(db.prepare('SELECT slug, name FROM tenants').all()).toEqual([{ slug: 'l-atelier-ete', name: "L'Atelier Été" }]);
    const invite = db.prepare('SELECT email, role, token_hash FROM invites').get();
    expect(invite).toMatchObject({ email: 'owner@example.com', role: 'owner' });
    expect(invite.token_hash).toBe(createHash('sha256').update(token).digest('hex'));

    // A second run (or a run on a used installation) adds nothing.
    db.exec(sql(ulid(now + 1)));
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invites').get().n).toBe(1);
  });

  it('generates sortable ids and safe slugs', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(slugify('!!')).toBe('workspace');
  });
});
