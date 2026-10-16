import { DurableObject } from 'cloudflare:workers';
import { createSecretBox, type SecretBox } from '@amable/auth/security';
import type { AutomationInboundEvent } from '@amable/core';
import { createDoSqliteMigrationStore, runMigrations } from '@amable/db';
import { monotonicFactory } from 'ulid';
import { AutomationEngine, type EngineActor } from '../automation/engine';
import { engineMigrations } from '../automation/migrations';
import { runAutomationOp } from '../automation/ops';
import { runAutomationReportOp } from '../automation/report-queries';
import { ENGINE_ACTOR } from '../automation/ports';
import type { BackupRow } from '../backup/format';
import {
  backupSqlFromStorage,
  createSqlBackup,
  type BackupDbInfo,
  type DumpCursor,
  type DumpPage,
} from '../backup/sql-dump';
import { seedAutomations, type AutomationSeedSummary } from '../automation/seed';
import { getMeta, setMeta } from '../automation/store';
import type { CrmResult } from '../crm/ops';
import { createDoSqlDb } from '../crm/db/do-sql';
import type { SqlDb } from '../crm/db/sql';
import type { Env } from '../env';
import { withAlarmReporting } from '../platform/telemetry';
import { createPlatformQuotaGuard } from '../platform/quota';
import { webhookService } from '../webhooks/runtime';

const nextUlid = monotonicFactory();

/**
 * Engine — the automation engine Durable Object, one per tenant (addressed by
 * tenant id, like TenantDb). Owns its own SQLite schema (automations,
 * versions, enrollments, scheduler); CRM data stays in the TenantDb and is
 * reached through its `crm()` RPC.
 *
 * Scheduler: one DO alarm, always set to the earliest row of the job table.
 * Event bus: drains the TenantDb outbox when kicked (after mutating requests)
 * and every few minutes while automations are published; other modules push
 * events with `ingest()`.
 */
export class Engine extends DurableObject<Env> {
  private readonly db: SqlDb;
  private tenantId: string | null = null;
  private engine: AutomationEngine | null = null;
  private secretBox: Promise<SecretBox | null> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDoSqlDb(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      await runMigrations(
        createDoSqliteMigrationStore(ctx.storage, { metaTable: 'engine_meta' }),
        engineMigrations,
      );
      this.tenantId = getMeta(this.db, 'tenant_id');
    });
  }

  /** The engine bound to this DO's tenant (persisted on first call). */
  private core(tenantId?: string): AutomationEngine | null {
    if (tenantId !== undefined) {
      if (this.tenantId === null) {
        setMeta(this.db, 'tenant_id', tenantId);
        this.tenantId = tenantId;
      } else if (this.tenantId !== tenantId) {
        throw new Error('engine: tenant mismatch');
      }
    }
    const bound = this.tenantId;
    if (bound === null) return null;
    this.engine ??= new AutomationEngine(this.db, {
      tenantId: bound,
      crm: {
        call: async (op, input) =>
          (await this.env.TENANT_DB.get(this.env.TENANT_DB.idFromName(bound)).crm(
            op,
            ENGINE_ACTOR,
            input,
          )) as CrmResult<unknown>,
      },
      email: {
        send: async (message) => {
          await this.env.EMAIL_SEND.send(message);
        },
      },
      quota: createPlatformQuotaGuard(this.env),
      fetch: (input, init) => fetch(input, init),
      alarm: {
        set: async (at) => {
          if (at === null) await this.ctx.storage.deleteAlarm();
          else await this.ctx.storage.setAlarm(at);
        },
      },
      secretBox: () => {
        const key = this.env.AUTH_ENCRYPTION_KEY;
        this.secretBox ??= key === undefined || key === '' ? Promise.resolve(null) : createSecretBox(key);
        return this.secretBox;
      },
      webhooks: {
        publish: (events) => webhookService(this.env).publish(bound, events),
      },
      now: () => Date.now(),
      newId: () => nextUlid(),
    });
    return this.engine;
  }

  private bound(tenantId: string): AutomationEngine {
    const engine = this.core(tenantId);
    if (engine === null) throw new Error('engine: tenant not bound');
    return engine;
  }

  /**
   * Single entry point of the automation API. Only the core worker reaches
   * this DO, through the automation routes after the auth + tenant +
   * permission guards; `actor` comes from that verified context.
   */
  automation(
    tenantId: string,
    op: string,
    actor: EngineActor,
    input: unknown,
  ): Promise<CrmResult<unknown>> {
    return runAutomationOp(this.db, this.bound(tenantId), actor, op, input);
  }

  /** Read-only report aggregates (apps/core/src/automation/report-queries.ts). */
  report(tenantId: string, op: string, input: unknown): CrmResult<unknown> {
    return runAutomationReportOp(this.db, this.bound(tenantId), op, input);
  }

  /** Requests an outbox drain (fire-and-forget after mutating requests). */
  async kick(tenantId: string): Promise<void> {
    await this.bound(tenantId).kick();
  }

  /** Events from modules outside the TenantDb (forms, email tracking, booking, analytics). */
  ingest(
    tenantId: string,
    events: AutomationInboundEvent[],
  ): Promise<{ accepted: number; matched: number }> {
    return this.bound(tenantId).ingest(events);
  }

  /** Called when the quota guard allows again (e.g. wallet top-up): paused email steps resume. */
  resumeEmailSteps(tenantId: string): Promise<number> {
    return this.bound(tenantId).resumePaused();
  }

  private readonly backup = createSqlBackup(backupSqlFromStorage(this.ctx.storage), {
    metaTable: 'engine_meta',
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
    this.tenantId = getMeta(this.db, 'tenant_id');
    this.engine = null;
    await this.core()?.arm();
  }

  /** Dev-only: two demo automations (idempotent). */
  async devSeed(tenantId: string): Promise<AutomationSeedSummary> {
    if (this.env.ENVIRONMENT !== 'dev')
      throw new Error('devSeed is only available when ENVIRONMENT=dev');
    const engine = this.bound(tenantId);
    const summary = await seedAutomations(this.db, engine);
    await engine.arm();
    return summary;
  }

  /** Dev-only: scheduler state (jobs heap, alarm, processed events) for local debugging. */
  async devInspect(): Promise<Record<string, unknown>> {
    if (this.env.ENVIRONMENT !== 'dev')
      throw new Error('devInspect is only available when ENVIRONMENT=dev');
    return {
      tenantId: this.tenantId,
      alarm: await this.ctx.storage.getAlarm(),
      jobs: this.db.all(`SELECT kind, ref, due_at FROM eng_jobs ORDER BY due_at LIMIT 20`),
      processedEvents: this.db.all(`SELECT COUNT(*) AS n FROM eng_processed_events`)[0],
      enrollments: this.db.all(
        `SELECT automation_id, status, COUNT(*) AS n FROM eng_enrollments GROUP BY 1, 2`,
      ),
    };
  }

  override async alarm(): Promise<void> {
    await withAlarmReporting(this.env, 'automation', this.ctx, async () => {
      const engine = this.core();
      if (engine === null) return;
      await engine.runDue();
    });
  }
}
