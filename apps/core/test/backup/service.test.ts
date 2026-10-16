import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION_MANUAL,
  BACKUP_RETENTION_SCHEDULED,
  BACKUP_STATE_KEY,
  INSTALLATION_BACKUP_PREFIX,
  tenantBackupPrefix,
} from '../../src/backup/format';
import { createR2JsonlGzipWriter, readJsonlGzip } from '../../src/backup/jsonl-gzip';
import {
  createTenantBackup,
  listBackups,
  pruneBackups,
  restoreTenantBackup,
  runScheduledBackups,
  validateTenantBackup,
  type BackupDeps,
} from '../../src/backup/service';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
} from '../helpers/harness';
import { FakeDos, FakeR2, testDeps } from './helpers';

const T0 = Date.UTC(2026, 9, 15, 3, 0, 0);

let h: Harness;
let r2: FakeR2;
let dos: FakeDos;
let clock: { now: number };
let deps: BackupDeps;
let acme: { id: string; slug: string };

function seedDos(tenantId: string, contacts = 150): void {
  const t = dos.get(tenantId);
  for (let i = 0; i < contacts; i += 1) {
    t.crm.op('contacts.create', { given_name: `Ada${i}`, family_name: 'Lovelace' });
  }
  const insert = t.mail.prepare(
    `INSERT INTO mail_templates (id, name, body, body_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < 120; i += 1) insert.run(`tpl_${i}`, `Template ${i}`, `<p>${i}</p>`, `h${i}`, i, i);
  t.mail.prepare(`INSERT INTO mail_meta (key, value) VALUES ('tenant_id', ?)`).run(tenantId);
  t.engine.prepare(`INSERT INTO engine_meta (key, value) VALUES ('tenant_id', ?)`).run(tenantId);
}

function counts(tenantId: string) {
  const t = dos.get(tenantId);
  const one = (row: unknown) => (row as { n: number }).n;
  return {
    contacts: one(t.crm.db.raw.prepare(`SELECT COUNT(*) AS n FROM crm_contacts`).get()),
    search: one(
      t.crm.db.raw
        .prepare(`SELECT COUNT(*) AS n FROM crm_search_fts WHERE crm_search_fts MATCH 'lovelace'`)
        .get(),
    ),
    templates: one(t.mail.prepare(`SELECT COUNT(*) AS n FROM mail_templates`).get()),
    engineTenant: t.engine.prepare(`SELECT value FROM engine_meta WHERE key = 'tenant_id'`).get(),
  };
}

async function lines(key: string): Promise<Record<string, unknown>[]> {
  const object = await r2.get(key);
  const out: Record<string, unknown>[] = [];
  for await (const line of readJsonlGzip(object?.body as ReadableStream<Uint8Array>)) {
    out.push(line as Record<string, unknown>);
  }
  return out;
}

beforeEach(async () => {
  h = await createHarness();
  r2 = new FakeR2();
  dos = new FakeDos();
  clock = { now: T0 };
  deps = testDeps(r2, dos, h.env.DB, clock, 16 * 1024);
  acme = await seedTenant(h, 'acme');
});

describe('tenant backups', () => {
  it('writes header, every DO row, the tenant D1 rows (no credentials) and an end line', async () => {
    seedDos(acme.id);
    const owner = await seedUser(h, { email: 'owner@acme.test' });
    await addMember(h, owner.id, acme.id, 'owner');
    const info = await createTenantBackup(deps, acme, 'manual');
    expect(info.key.startsWith(tenantBackupPrefix(acme.id))).toBe(true);
    expect(info.kind).toBe('manual');
    expect(info.createdAt).toBe(new Date(T0).toISOString());

    const all = await lines(info.key);
    const header = all[0] as Record<string, unknown>;
    expect(header).toMatchObject({
      type: 'header',
      format: 'amable-backup',
      version: 1,
      scope: 'tenant',
      tenantId: acme.id,
      tenantSlug: 'acme',
    });
    expect(Object.keys(header['schemas'] as object).sort()).toEqual([
      'd1',
      'engine',
      'mail_db',
      'tenant_db',
    ]);
    const rows = all.slice(1, -1);
    expect(all[all.length - 1]).toEqual({ type: 'end', rows: rows.length });
    const of = (db: string, table: string) => rows.filter((r) => r['db'] === db && r['table'] === table);
    expect(of('tenant_db', 'crm_contacts')).toHaveLength(150);
    expect(of('mail_db', 'mail_templates')).toHaveLength(120);
    expect(of('d1', 'tenants')).toHaveLength(1);
    expect(of('d1', 'memberships')).toHaveLength(1);
    expect(of('d1', 'users')).toHaveLength(0);
    expect(of('d1', 'sessions')).toHaveLength(0);
    expect(rows.some((r) => String(r['table']).startsWith('crm_search_fts'))).toBe(false);
    expect(rows.some((r) => r['table'] === 'do_migrations')).toBe(false);
  });

  it('keeps the newest backups of each kind (retention)', async () => {
    for (let i = 0; i < BACKUP_RETENTION_SCHEDULED + 3; i += 1) {
      clock.now += 60_000;
      await createTenantBackup(deps, acme, 'scheduled');
    }
    for (let i = 0; i < BACKUP_RETENTION_MANUAL + 2; i += 1) {
      clock.now += 60_000;
      await createTenantBackup(deps, acme, 'manual');
    }
    const kept = await listBackups(deps, tenantBackupPrefix(acme.id));
    expect(kept.filter((b) => b.kind === 'scheduled')).toHaveLength(BACKUP_RETENTION_SCHEDULED);
    expect(kept.filter((b) => b.kind === 'manual')).toHaveLength(BACKUP_RETENTION_MANUAL);
    expect(kept[0]?.createdAt).toBe(new Date(clock.now).toISOString());
    const newestScheduled = kept.find((b) => b.kind === 'scheduled');
    expect(newestScheduled?.createdAt).toBe(
      new Date(T0 + (BACKUP_RETENTION_SCHEDULED + 3) * 60_000).toISOString(),
    );
    expect(await pruneBackups(deps, tenantBackupPrefix(acme.id))).toEqual([]);
  });

  it('restores into a fresh tenant (lost DOs) and over modified data', async () => {
    seedDos(acme.id);
    const before = counts(acme.id);
    expect(before).toMatchObject({ contacts: 150, search: 150, templates: 120 });
    const backup = await createTenantBackup(deps, acme, 'manual');

    dos.tenants.delete(acme.id);
    expect(counts(acme.id)).toMatchObject({ contacts: 0, templates: 0, engineTenant: undefined });
    clock.now += 60_000;
    const summary = await restoreTenantBackup(deps, acme, backup.id);
    expect(summary.rows.tenant_db).toBeGreaterThan(150);
    expect(summary.rows.mail_db).toBe(121);
    expect(summary.skippedD1Rows).toBe(1);
    expect(counts(acme.id)).toEqual(before);
    expect(dos.get(acme.id).restoredCalls).toBe(3);

    dos.get(acme.id).crm.op('contacts.create', { given_name: 'Extra', family_name: 'Lovelace' });
    dos.get(acme.id).mail.prepare(`DELETE FROM mail_templates WHERE id = 'tpl_1'`).run();
    clock.now += 60_000;
    await restoreTenantBackup(deps, acme, backup.id);
    expect(counts(acme.id)).toEqual(before);

    const list = await listBackups(deps, tenantBackupPrefix(acme.id));
    expect(list.map((b) => b.id)).toContain(backup.id);
    expect(list.map((b) => b.id)).toContain(summary.safetyBackupId);
  });

  it('rejects foreign, mismatched and truncated backups before touching data', async () => {
    seedDos(acme.id, 5);
    const other = await seedTenant(h, 'other');
    seedDos(other.id, 3);
    const backup = await createTenantBackup(deps, acme, 'manual');

    const stored = r2.objects.get(backup.key);
    await r2.put(`${tenantBackupPrefix(other.id)}${backup.id}.jsonl.gz`, stored?.bytes);
    await expect(restoreTenantBackup(deps, other, backup.id)).rejects.toMatchObject({
      code: 'backup_wrong_tenant',
    });
    expect(counts(other.id).contacts).toBe(3);

    const truncatedId = '2026-10-15T03-00-00-000Z-manual-trunc0001';
    const writer = createR2JsonlGzipWriter(r2.asBucket(), `${tenantBackupPrefix(acme.id)}${truncatedId}.jsonl.gz`);
    const all = await lines(backup.key);
    for (const line of all.slice(0, -1)) await writer.write(line);
    await writer.close();
    await expect(validateTenantBackup(deps, acme, truncatedId)).rejects.toMatchObject({
      code: 'backup_invalid',
    });

    dos.get(acme.id).mail.prepare(`UPDATE mail_meta SET value = '999' WHERE key = 'schema_version'`).run();
    await expect(restoreTenantBackup(deps, acme, backup.id)).rejects.toMatchObject({
      code: 'backup_schema_mismatch',
    });
    await expect(restoreTenantBackup(deps, acme, 'missing')).rejects.toMatchObject({
      code: 'backup_not_found',
    });
    expect(counts(acme.id).contacts).toBe(5);
  });
});

describe('scheduled backups', () => {
  it('runs once a day per scope, oldest first, within the per-tick cap', async () => {
    const beta = await seedTenant(h, 'beta');
    seedDos(acme.id, 2);
    seedDos(beta.id, 2);

    const first = await runScheduledBackups(deps, { maxBackups: 2 });
    expect(first).toEqual({ status: 'ran', done: ['_installation', acme.id], failed: [] });
    clock.now += 5 * 60_000;
    const second = await runScheduledBackups(deps, { maxBackups: 2 });
    expect(second.done).toEqual([beta.id]);
    clock.now += 5 * 60_000;
    expect((await runScheduledBackups(deps)).status).toBe('idle');

    expect(await listBackups(deps, INSTALLATION_BACKUP_PREFIX)).toHaveLength(1);
    const install = await lines((await listBackups(deps, INSTALLATION_BACKUP_PREFIX))[0]?.key ?? '');
    expect(install.some((l) => l['table'] === 'users' || l['table'] === 'tenants')).toBe(true);
    expect((await listBackups(deps, tenantBackupPrefix(beta.id)))[0]?.kind).toBe('scheduled');

    clock.now = T0 + BACKUP_INTERVAL_MS;
    const next = await runScheduledBackups(deps);
    expect(next.done).toEqual(['_installation', acme.id]);
    clock.now += 5 * 60_000;
    expect((await runScheduledBackups(deps)).done).toEqual([beta.id]);
  });

  it('skips while another tick holds the lease and drops deleted tenants from the state', async () => {
    seedDos(acme.id, 1);
    await r2.put(
      BACKUP_STATE_KEY,
      JSON.stringify({
        version: 1,
        installation: null,
        tenants: { t_gone: T0 },
        retryAt: {},
        leaseUntil: T0 + 60_000,
      }),
    );
    expect((await runScheduledBackups(deps)).status).toBe('locked');
    clock.now += 61_000;
    expect((await runScheduledBackups(deps)).status).toBe('ran');
    const state = JSON.parse(new TextDecoder().decode(r2.objects.get(BACKUP_STATE_KEY)?.bytes)) as {
      tenants: Record<string, number>;
      leaseUntil: number | null;
    };
    expect(Object.keys(state.tenants)).toEqual([acme.id]);
    expect(state.leaseUntil).toBeNull();
  });
});

describe('backup routes', () => {
  async function setup() {
    Object.assign(h.env, { FILES: r2.asBucket(), ...dos.namespaces() });
    seedDos(acme.id, 3);
    const owner = await seedUser(h, { email: 'owner@acme.test' });
    const admin = await seedUser(h, { email: 'admin@acme.test' });
    await addMember(h, owner.id, acme.id, 'owner');
    await addMember(h, admin.id, acme.id, 'admin');
    return { owner: await login(h, owner.email), admin: await login(h, admin.email) };
  }

  it('is owner only and requires a step-up for create, download and restore', async () => {
    const { owner, admin } = await setup();
    expect((await admin.get('/api/t/acme/backups')).status).toBe(403);
    await stepUp(h, admin);
    expect((await admin.post('/api/t/acme/backups')).status).toBe(403);

    const empty = await owner.get('/api/t/acme/backups');
    expect(empty.status).toBe(200);
    expect(empty.body['backups']).toEqual([]);

    const noStepUp = await owner.post('/api/t/acme/backups');
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body['error']).toBe('step_up_required');

    await stepUp(h, owner);
    const created = await owner.post('/api/t/acme/backups');
    expect(created.status).toBe(201);
    const backup = created.body['backup'] as { id: string; kind: string; size: number };
    expect(backup.kind).toBe('manual');
    expect(backup.size).toBeGreaterThan(0);
    expect((await owner.post('/api/t/acme/backups')).status).toBe(429);

    const listed = await owner.get('/api/t/acme/backups');
    expect((listed.body['backups'] as { id: string }[]).map((b) => b.id)).toEqual([backup.id]);

    const download = await owner.get(`/api/t/acme/backups/${backup.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/gzip');
    expect(download.headers.get('content-disposition')).toContain('amable-backup-acme-');
    expect((await owner.get('/api/t/acme/backups/..%2F..%2Fx/download')).status).toBe(404);

    const wrong = await owner.post(`/api/t/acme/backups/${backup.id}/restore`, { confirm: 'nope' });
    expect(wrong.status).toBe(422);
    dos.get(acme.id).crm.op('contacts.create', { given_name: 'Later', family_name: 'Lovelace' });
    const restored = await owner.post(`/api/t/acme/backups/${backup.id}/restore`, { confirm: 'acme' });
    expect(restored.status).toBe(200);
    expect(counts(acme.id).contacts).toBe(3);

    h.clock.advance(6 * 60_000);
    const stale = await owner.get(`/api/t/acme/backups/${backup.id}/download`);
    expect(stale.body['error']).toBe('step_up_required');

    const { results } = await h.env.DB.prepare(
      `SELECT action FROM audit_log WHERE action LIKE 'tenant.backup_%' ORDER BY created_at, action`,
    ).all<{ action: string }>();
    expect(results.map((r) => r.action).sort()).toEqual([
      'tenant.backup_created',
      'tenant.backup_downloaded',
      'tenant.backup_restored',
    ]);
  });
});
