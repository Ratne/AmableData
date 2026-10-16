import { DurableObject } from 'cloudflare:workers';
import { createDoSqliteMigrationStore, runMigrations, tenantMigrations } from '@amable/db';
import type { BackupRow } from '../backup/format';
import {
  backupSqlFromStorage,
  createSqlBackup,
  type BackupDbInfo,
  type DumpCursor,
  type DumpPage,
} from '../backup/sql-dump';
import { affectsBillingSchedule } from '../commerce/ops';
import { seedCommerce, type CommerceSeedSummary } from '../commerce/seed';
import { nextBillingDue } from '../commerce/subscriptions';
import { SYSTEM_ACTOR, type CrmActor, type SearchMode } from '../crm/context';
import { createDoSqlDb } from '../crm/db/do-sql';
import type { SqlDb } from '../crm/db/sql';
import { runCrmOp, type CrmResult } from '../crm/ops';
import { ensureSearchIndex } from '../crm/search/index-store';
import { seedCrm, type CrmSeedSummary } from '../crm/seed';
import type { Env } from '../env';
import { AlarmStepError, reportAlarmFailure, withAlarmReporting } from '../platform/telemetry';
import { armPointInTime } from './point-in-time';

/**
 * TenantDb — one SQLite-backed Durable Object per tenant (addressed by tenant id).
 * Holds all CRM data of that tenant; total isolation, no noisy neighbors.
 *
 * Migrations run at first access: the constructor executes every pending tenant
 * migration inside blockConcurrencyWhile, so no request or RPC can ever observe a
 * stale schema — including the first wake after a fleet-wide deploy.
 */
export class TenantDb extends DurableObject<Env> {
  private schemaVersion = 0;
  private readonly crmDb: SqlDb;
  private searchMode: SearchMode = 'fts5';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.crmDb = createDoSqlDb(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = await runMigrations(
        createDoSqliteMigrationStore(ctx.storage, { metaTable: 'tenant_meta' }),
        tenantMigrations,
      );
      // FTS5 index over crm_search_documents (falls back to trigram + LIKE).
      this.searchMode = ensureSearchIndex(this.crmDb);
    });
  }

  /** Highest applied tenant migration id. */
  getSchemaVersion(): number {
    return this.schemaVersion;
  }

  /**
   * Single entry point of the CRM domain (apps/core/src/crm/ops.ts). Only the
   * core worker can reach this DO, and only through `tenantDb(c)` after the
   * auth + tenant + permission guards; `actor` comes from that verified context.
   */
  crm(op: string, actor: CrmActor, input: unknown): CrmResult<unknown> {
    const result = runCrmOp({ db: this.crmDb, searchMode: this.searchMode }, actor, op, input);
    if (result.ok && affectsBillingSchedule(op)) this.armBillingAlarm();
    return result;
  }

  /**
   * Billing automation: the DO alarm fires at the earliest subscription due
   * date, runs the billing job (renewal orders, invoices, events) and re-arms
   * itself. The alarm is owned by billing; another module needing timers must
   * share it through a next-wake computation rather than calling setAlarm.
   */
  override async alarm(): Promise<void> {
    await withAlarmReporting(this.env, 'tenant-db', this.ctx, async () => {
      const result = runCrmOp(
        { db: this.crmDb, searchMode: this.searchMode },
        SYSTEM_ACTOR,
        'billing.run',
        {},
      );
      if (!result.ok) {
        console.error('[billing] run failed:', result.error);
        await reportAlarmFailure(this.env, 'billing', this.ctx, new AlarmStepError(`billing.run ${result.error.code}: ${result.error.message}`));
      }
      this.armBillingAlarm();
    });
  }

  private armBillingAlarm(): void {
    const due = nextBillingDue(this.crmDb);
    if (due === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(Math.max(due, Date.now()));
  }

  private readonly backup = createSqlBackup(backupSqlFromStorage(this.ctx.storage), {
    metaTable: 'tenant_meta',
  });

  /** Backup RPCs (apps/core/src/backup), reached only by the owner-guarded backup routes and the cron. */
  backupInfo(): BackupDbInfo {
    return this.backup.info();
  }

  backupDump(cursor: DumpCursor | null): DumpPage {
    return this.backup.dump(cursor);
  }

  /** Point-in-time recovery (apps/core/src/platform/restore.ts), signed control plane call only. */
  pointInTimeArm(atMs: number): Promise<string> {
    return armPointInTime(this.ctx.storage, atMs);
  }

  pointInTimeApply(): void {
    this.ctx.abort('point-in-time restore');
  }

  backupWipe(): void {
    this.backup.wipe();
  }

  backupRestore(table: string, rows: BackupRow[]): number {
    return this.backup.restore(table, rows);
  }

  backupRestored(): void {
    this.armBillingAlarm();
  }

  /** Dev-only: fills the tenant with fake CRM data (idempotent). */
  crmDevSeed(): CrmSeedSummary {
    if (this.env.ENVIRONMENT !== 'dev') {
      throw new Error('crmDevSeed is only available when ENVIRONMENT=dev');
    }
    return seedCrm(this.crmDb, this.searchMode);
  }

  /** Dev-only: a year of e-commerce history on top of the CRM seed (idempotent). */
  commerceDevSeed(): CommerceSeedSummary {
    if (this.env.ENVIRONMENT !== 'dev') {
      throw new Error('commerceDevSeed is only available when ENVIRONMENT=dev');
    }
    const summary = seedCommerce(this.crmDb, this.searchMode);
    this.armBillingAlarm();
    return summary;
  }

  /**
   * Dev-only seeding helper (local `pnpm seed`). Upserts key/value placeholder
   * rows into tenant_meta.
   */
  devSeed(entries: Record<string, string>): number {
    if (this.env.ENVIRONMENT !== 'dev') {
      throw new Error('devSeed is only available when ENVIRONMENT=dev');
    }
    let written = 0;
    for (const [key, value] of Object.entries(entries)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO tenant_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
      written += 1;
    }
    return written;
  }

  /** Reads back tenant_meta rows — used by the seed flow to verify DO state. */
  listMeta(): { key: string; value: string }[] {
    return this.ctx.storage.sql
      .exec<{ key: string; value: string }>(`SELECT key, value FROM tenant_meta ORDER BY key`)
      .toArray();
  }
}
