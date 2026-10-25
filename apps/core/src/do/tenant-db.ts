import { DurableObject } from 'cloudflare:workers';
import { createDoSqliteMigrationStore, runMigrations, tenantMigrations } from '@amable/db';
import { TENANT_ARCHIVE_STREAMS } from '../archive/model';
import { runArchiveOp, type ArchiveHost, type ArchiveOpResult } from '../archive/store';
import type { BackupRow } from '../backup/format';
import {
  backupSqlFromStorage,
  createSqlBackup,
  type BackupDbInfo,
  type DumpCursor,
  type DumpPage,
} from '../backup/sql-dump';
import { affectsChargeSchedule } from '../checkout/ops';
import { runRenewalCharges } from '../checkout/renewals';
import { nextSessionCleanup } from '../checkout/sessions';
import { affectsBillingSchedule } from '../commerce/ops';
import { seedCommerce, type CommerceSeedSummary } from '../commerce/seed';
import { nextBillingDue, nextChargeDue } from '../commerce/subscriptions';
import { SYSTEM_ACTOR, type CrmActor, type SearchMode } from '../crm/context';
import { createDoSqlDb } from '../crm/db/do-sql';
import type { SqlDb } from '../crm/db/sql';
import { runCrmOp, type CrmResult } from '../crm/ops';
import { ensureSearchIndex } from '../crm/search/index-store';
import { seedCrm, type CrmSeedSummary } from '../crm/seed';
import type { Env } from '../env';
import { nextEsignDue } from '../esign/due';
import { runEsignDue } from '../esign/runner';
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
/** Ops after which signature timers may have moved (automation steps create requests through `automation.once`). */
function affectsEsignSchedule(op: string): boolean {
  return op.startsWith('esign.') || op === 'automation.once';
}

const ESIGN_RETRY_MS = 60_000;

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
    if (result.ok && (affectsBillingSchedule(op) || affectsEsignSchedule(op) || affectsChargeSchedule(op))) {
      this.armAlarm();
    }
    return result;
  }

  /**
   * Timers of the tenant: the DO alarm fires at the earliest billing due date
   * or signature timer (invitation, reminder, expiry, sealing), runs both jobs
   * and re-arms itself. Modules needing timers share this alarm through the
   * next-wake computation in `armAlarm` rather than calling setAlarm.
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
        await reportAlarmFailure(
          this.env,
          'billing',
          this.ctx,
          new AlarmStepError(`billing.run ${result.error.code}: ${result.error.message}`),
        );
      }
      const cleanup = runCrmOp({ db: this.crmDb, searchMode: this.searchMode }, SYSTEM_ACTOR, 'checkout.expireSessions', {});
      if (!cleanup.ok) console.error('[checkout] session cleanup failed:', cleanup.error);
      try {
        await runRenewalCharges(this.env, (op, input) => {
          const out = runCrmOp({ db: this.crmDb, searchMode: this.searchMode }, SYSTEM_ACTOR, op, input);
          if (!out.ok) throw new AlarmStepError(`${op} ${out.error.code}: ${out.error.message}`);
          return out.value as never;
        });
      } catch (error) {
        console.error('[renewals] charge run failed:', error);
        await reportAlarmFailure(
          this.env,
          'renewals',
          this.ctx,
          error instanceof Error ? error : new AlarmStepError(String(error)),
        );
      }
      let esignFailed = false;
      try {
        const run = await runEsignDue(this.env, (op, input) => {
          const out = runCrmOp(
            { db: this.crmDb, searchMode: this.searchMode },
            SYSTEM_ACTOR,
            op,
            input,
          );
          if (!out.ok) throw new AlarmStepError(`${op} ${out.error.code}: ${out.error.message}`);
          return out.value as never;
        });
        esignFailed = run.failed;
        if (run.changed && run.tenantId !== null) {
          await this.env.ENGINE.get(this.env.ENGINE.idFromName(run.tenantId))
            .kick(run.tenantId)
            .catch(() => undefined);
        }
      } catch (error) {
        esignFailed = true;
        console.error('[esign] run failed:', error);
        await reportAlarmFailure(
          this.env,
          'esign',
          this.ctx,
          error instanceof Error ? error : new AlarmStepError(String(error)),
        );
      }
      this.armAlarm(esignFailed ? ESIGN_RETRY_MS : 0);
    });
  }

  /** `esignDelay`: after a failed signature run, wait before retrying what is still due. */
  private armAlarm(esignDelay = 0): void {
    const now = Date.now();
    const billing = nextBillingDue(this.crmDb);
    const charge = nextChargeDue(this.crmDb);
    const sessions = nextSessionCleanup(this.crmDb);
    const esign = nextEsignDue(this.crmDb);
    const candidates = [billing, charge, sessions, esign === null ? null : Math.max(esign, now + esignDelay)].filter(
      (t): t is number => t !== null,
    );
    if (candidates.length === 0) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), now));
  }

  /** Event archive (apps/core/src/archive): the retention cron and the archive read routes only. */
  archive(op: string, input: unknown): ArchiveOpResult<unknown> {
    const host: ArchiveHost = {
      db: this.crmDb,
      streams: TENANT_ARCHIVE_STREAMS,
      outbox: 'crm_outbox',
      settingsTable: 'tenant_meta',
      now: () => Date.now(),
    };
    return runArchiveOp(host, op, input);
  }

  /** Size of this object's SQLite database (bytes), for the owner diagnostics. */
  storageInfo(): { bytes: number } {
    return { bytes: this.ctx.storage.sql.databaseSize };
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
    this.armAlarm();
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
    this.armAlarm();
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
