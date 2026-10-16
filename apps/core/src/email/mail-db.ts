import { DurableObject } from 'cloudflare:workers';
import { createDoSqliteMigrationStore, runMigrations } from '@amable/db';
import { monotonicFactory } from 'ulid';
import type { BackupRow } from '../backup/format';
import {
  backupSqlFromStorage,
  createSqlBackup,
  type BackupDbInfo,
  type DumpCursor,
  type DumpPage,
} from '../backup/sql-dump';
import { createDoSqlDb } from '../crm/db/do-sql';
import type { SqlDb } from '../crm/db/sql';
import type { Env } from '../env';
import { AlarmStepError, reportAlarmFailure, withAlarmReporting } from '../platform/telemetry';
import { BRIDGE_DELAY_MS, BRIDGE_RETRY_MS, bridgeEmailEvents, hasPendingEmailEvents } from './bridge';
import type { MailDeps } from './context';
import { mailMigrations } from './db/migrations';
import { runMailOp, type MailResult } from './ops';
import {
  automationSink,
  crmReader,
  emailQueue,
  marketingProvider,
  quotaGuard,
  sendingState,
  tokenSecrets,
  userDirectory,
} from './runtime';

/**
 * MailDb — one SQLite-backed Durable Object per tenant (addressed by tenant id)
 * holding templates, snippets, messages, clicks, suppressions, broadcasts and
 * the email outbox. Separate from the TenantDb so mail volume never slows the
 * CRM; contacts and segments are read through TenantDb RPC ops.
 * The alarm drives the broadcast scheduler and the outbox bridge to the CRM
 * event bus (armed shortly after any op that left events pending).
 */
const nextUlid = monotonicFactory();

export class MailDb extends DurableObject<Env> {
  private readonly db: SqlDb;
  private tenantId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDoSqlDb(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await runMigrations(createDoSqliteMigrationStore(ctx.storage, { metaTable: 'mail_meta' }), mailMigrations);
      this.tenantId = this.db.all<{ value: string }>(`SELECT value FROM mail_meta WHERE key = 'tenant_id'`)[0]?.value ?? null;
    });
  }

  private bind(tenantId: string): MailDeps {
    if (this.tenantId === null) {
      this.db.run(`INSERT OR IGNORE INTO mail_meta (key, value) VALUES ('tenant_id', ?)`, tenantId);
      this.tenantId = tenantId;
    } else if (this.tenantId !== tenantId) {
      throw new Error('MailDb tenant mismatch');
    }
    const env = this.env;
    return {
      db: this.db,
      tenantId,
      now: () => Date.now(),
      newId: () => nextUlid(),
      crm: crmReader(env, tenantId),
      users: userDirectory(env, tenantId),
      provider: marketingProvider(env),
      queue: emailQueue(env),
      quota: quotaGuard(env),
      sending: sendingState(env, tenantId),
      tokenSecrets: tokenSecrets(env),
      automation: automationSink(env, tenantId),
      scheduleAlarm: async (at: number) => {
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
      },
    };
  }

  /**
   * Single entry point of the email domain (apps/core/src/email/ops.ts). Reached
   * only from the core worker: REST routes after the auth + tenant + permission
   * guards, the queue consumer, and public endpoints that verify signed tokens
   * or webhook signatures first.
   */
  async mail(tenantId: string, op: string, input: unknown): Promise<MailResult<unknown>> {
    const deps = this.bind(tenantId);
    const result = await runMailOp(deps, op, input);
    if (hasPendingEmailEvents(deps)) await deps.scheduleAlarm(Date.now() + BRIDGE_DELAY_MS);
    return result;
  }

  private readonly backup = createSqlBackup(backupSqlFromStorage(this.ctx.storage), {
    metaTable: 'mail_meta',
  });

  /** Backup RPCs (apps/core/src/backup), reached only by the owner-guarded backup routes and the cron. */
  backupInfo(): BackupDbInfo {
    return this.backup.info();
  }

  backupDump(cursor: DumpCursor | null): DumpPage {
    return this.backup.dump(cursor);
  }

  backupWipe(): void {
    this.backup.wipe();
  }

  backupRestore(table: string, rows: BackupRow[]): number {
    return this.backup.restore(table, rows);
  }

  async backupRestored(): Promise<void> {
    this.tenantId =
      this.db.all<{ value: string }>(`SELECT value FROM mail_meta WHERE key = 'tenant_id'`)[0]
        ?.value ?? null;
    if (this.tenantId !== null) await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    await withAlarmReporting(this.env, 'email', this.ctx, async () => {
      if (this.tenantId === null) return;
      const deps = this.bind(this.tenantId);
      const result = await runMailOp(deps, 'broadcasts.tick', {});
      if (!result.ok) {
        console.error(`[email] broadcast tick failed: ${result.error.message}`);
        await reportAlarmFailure(this.env, 'email', this.ctx, new AlarmStepError(`broadcasts.tick ${result.error.code}: ${result.error.message}`));
      }
      try {
        await bridgeEmailEvents(deps);
      } catch (error) {
        console.error(`[email] event bridge failed: ${error instanceof Error ? error.message : String(error)}`);
        await reportAlarmFailure(this.env, 'email', this.ctx, error);
      }
      if (hasPendingEmailEvents(deps)) await deps.scheduleAlarm(Date.now() + BRIDGE_RETRY_MS);
    });
  }
}
