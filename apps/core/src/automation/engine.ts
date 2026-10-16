import type {
  Automation,
  AutomationDetail,
  AutomationGraph,
  AutomationSettings,
  AutomationStats,
  AutomationVersion,
  AutomationVersionSummary,
  Contact,
  ContactEnrollment,
  CreateAutomationInput,
  EngineSettings,
  Enrollment,
  EnrollmentDetail,
  EnrollContactInput,
  ExecutionLogEntry,
  GoalNode,
  ListAutomationsQuery,
  ListContactEnrollmentsQuery,
  ListEnrollmentsQuery,
  NodeStats,
  Page,
  PublishResult,
  SaveDraftInput,
  SearchQuery,
  Step,
  TriggerApiGoalInput,
  TriggerApiGoalResult,
  UpdateAutomationInput,
  ValidationResult,
} from '@amable/api-types';
import { EMPTY_GRAPH, LOG_KINDS } from '@amable/api-types';
import type { AutomationInboundEvent } from '@amable/core';
import { first, placeholders, type SqlDb, type SqlValue } from '../crm/db/sql';
import { CrmError, invalidMany, notFound } from '../crm/errors';
import { decodeCursor, encodeCursor, parseJson } from '../crm/util';
import { createFolderStore, type FolderStore } from '../folders/store';
import { countContactEnrollments, listContactEnrollments } from './contact-enrollments';
import { compileGraph, edgesFrom, isDecision, isSequence, type CompiledGraph } from './graph';
import { eventContactId, triggerMatches, type EngineEvent } from './goals';
import { CrmCallError, crmCall, type EnginePorts } from './ports';
import {
  EMAIL_PAUSE_RECHECK_MS,
  StepFailure,
  TIMER_STEPS,
  executeStep,
  type StepContext,
  type StepHost,
  type StepOutcome,
  type StepState,
} from './steps';
import {
  LIVE_SQL,
  activeEnrollment,
  bumpStat,
  deleteJob,
  deleteTokenJobs,
  earliestJob,
  getAutomationRow,
  getEnrollmentRow,
  getMeta,
  getTokenRow,
  getVersionRow,
  parseGraph,
  parseSettings,
  scheduleNoLaterThan,
  setJob,
  setMeta,
  type AutomationRow,
  type EnrollmentRow,
  type JobRow,
  type TokenRow,
  type TokenStatus,
} from './store';
import { addDays, formatDate, isLeap, isValidTimeZone, parseTimeOfDay, wallClock } from './time';
import { validateGraph } from './validate';

/** Who performs an engine API operation (user id from the verified context). */
export interface EngineActor {
  readonly userId: string | null;
}

type LogKind = (typeof LOG_KINDS)[number];

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 5 * 60_000;
export const POLL_INTERVAL_MS = 5 * 60_000;
/** Durable Object SQLite binds at most 100 parameters per statement (pending/ack use one per id). */
const OUTBOX_BATCH = 90;
const JOBS_PER_ROUND = 100;
const STEPS_PER_RUN = 25;
const CONCURRENCY = 8;
const PROCESSED_EVENTS_TTL_MS = 7 * 24 * 60 * 60_000;
/** Execution logs older than this are deleted by the daily prune job. */
export const LOG_RETENTION_MS = 90 * 24 * 60 * 60_000;
const LOG_PRUNE_BATCH_SIZE = 2_000;
const LOG_PRUNE_BATCHES = 10;

/** Retry delay after the n-th failed attempt: 30 s, 2 min, 8 min, 32 min (capped at 6 h). */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** Math.max(attempt - 1, 0), 6 * 60 * 60_000);
}

function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** SecretBox ciphertext format (`v1.<iv>.<ciphertext>`); plaintext secrets are hex. */
const SEALED_PREFIX = 'v1.';

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface VersionInfo {
  id: string;
  compiled: CompiledGraph;
  settings: AutomationSettings;
}

/**
 * The automation engine of one tenant. Pure domain logic over the Engine DO
 * SQLite (via the `SqlDb` port) and the outside world (via `EnginePorts`):
 * the DO class only wires storage, RPC, alarm and bindings.
 *
 * Concurrency: the DO may interleave requests while an async step is in
 * flight, so every read-modify-write is one synchronous transaction and a
 * running token holds a lease (its job moved to `now + LEASE_MS`).
 */
export class AutomationEngine implements StepHost {
  private readonly versions = new Map<string, VersionInfo>();
  private activeCache: AutomationRow[] | null = null;
  private draining = false;
  private drainAgain = false;
  private armedAt: number | null | undefined = undefined;
  /** Folders of the automations (`eng_folders`). */
  readonly folders: FolderStore;

  constructor(
    private readonly db: SqlDb,
    readonly ports: EnginePorts,
  ) {
    this.folders = createFolderStore(
      db,
      {
        kind: 'automation',
        foldersTable: 'eng_folders',
        itemsTable: 'eng_automations',
        liveItems: 'deleted_at IS NULL',
      },
      { now: () => ports.now(), newId: () => ports.newId() },
    );
  }

  private now(): number {
    return this.ports.now();
  }

  // =================================================================== API

  listAutomations(input: ListAutomationsQuery): Page<Automation> {
    const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
    const folder = this.folders.filter(input);
    const q = input.q === undefined || input.q === '' ? null : input.q;
    const rows = this.db.all<AutomationRow>(
      `SELECT * FROM eng_automations WHERE deleted_at IS NULL
         AND (? IS NULL OR status = ?) AND (? IS NULL OR id < ?)
         AND (? IS NULL OR name LIKE ? ESCAPE '\\')
         ${folder === null ? '' : `AND ${folder.sql}`}
       ORDER BY id DESC LIMIT ?`,
      input.status ?? null,
      input.status ?? null,
      before,
      before,
      q,
      q === null ? null : `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`,
      ...(folder?.params ?? []),
      input.limit + 1,
    );
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      data: page.map((row) => this.toAutomation(row)),
      next_cursor:
        rows.length > input.limit && last !== undefined
          ? encodeCursor({ v: null, id: last.id })
          : null,
    };
  }

  getAutomation(input: { id: string }): AutomationDetail {
    const row = this.automationOrThrow(input.id);
    return { ...this.toAutomation(row), draft_graph: parseGraph(row.draft_graph) };
  }

  createAutomation(actor: EngineActor, input: CreateAutomationInput): AutomationDetail {
    const folderId = this.folders.assertTarget(input.folder_id);
    const id = this.ports.newId();
    const now = this.now();
    this.db.run(
      `INSERT INTO eng_automations
         (id, name, description, status, settings, draft_graph, draft_revision, signing_secret, created_by, created_at, updated_at, folder_id)
       VALUES (?, ?, ?, 'draft', ?, ?, 1, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.settings ?? {}),
      JSON.stringify(input.graph ?? EMPTY_GRAPH),
      // Generated and sealed on first use (encryption is async, this insert is not).
      '',
      actor.userId,
      now,
      now,
      folderId,
    );
    return this.getAutomation({ id });
  }

  updateAutomation(input: { id: string; data: UpdateAutomationInput }): AutomationDetail {
    const row = this.automationOrThrow(input.id);
    const data = input.data;
    if (data.settings?.time_zone !== undefined && !isValidTimeZone(data.settings.time_zone)) {
      throw invalidMany([{ path: 'settings.time_zone', message: 'unknown time zone' }]);
    }
    this.db.run(
      `UPDATE eng_automations SET name = ?, description = ?, settings = ?, updated_at = ? WHERE id = ?`,
      data.name ?? row.name,
      data.description === undefined ? row.description : data.description,
      data.settings === undefined ? row.settings : JSON.stringify(data.settings),
      this.now(),
      row.id,
    );
    return this.getAutomation({ id: row.id });
  }

  deleteAutomation(input: { id: string }): { id: string; deleted: true } {
    const row = this.automationOrThrow(input.id);
    if (row.status === 'active') {
      throw new CrmError('conflict', 'unpublish the automation before deleting it');
    }
    const now = this.now();
    const enrollments = this.db.all<{ id: string }>(
      `SELECT id FROM eng_enrollments WHERE automation_id = ? AND status = 'active'`,
      row.id,
    );
    for (const e of enrollments) this.endEnrollment(e.id, 'removed', 'automation deleted');
    this.db.run(
      `UPDATE eng_automations SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      row.id,
    );
    this.invalidate();
    return { id: row.id, deleted: true };
  }

  saveDraft(input: { id: string; data: SaveDraftInput }): AutomationDetail {
    const row = this.automationOrThrow(input.id);
    if (row.draft_revision !== input.data.revision) {
      throw new CrmError(
        'conflict',
        `draft revision is ${row.draft_revision}, not ${input.data.revision}: reload before saving`,
      );
    }
    this.db.run(
      `UPDATE eng_automations SET draft_graph = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?`,
      JSON.stringify(input.data.graph),
      this.now(),
      row.id,
    );
    return this.getAutomation({ id: row.id });
  }

  validateDraft(input: { id: string }): ValidationResult {
    const row = this.automationOrThrow(input.id);
    return this.validate(row, parseGraph(row.draft_graph));
  }

  private validate(row: AutomationRow, graph: AutomationGraph): ValidationResult {
    return validateGraph(graph, parseSettings(row.settings), {
      automationId: row.id,
      lookup: (automationId) => {
        if (automationId === row.id) return { graph };
        const target = getAutomationRow(this.db, automationId);
        if (target === undefined) return null;
        const published =
          target.published_version_id === null
            ? undefined
            : getVersionRow(this.db, target.published_version_id);
        return { graph: parseGraph(published?.graph ?? target.draft_graph) };
      },
    });
  }

  publish(actor: EngineActor, input: { id: string }): PublishResult {
    const row = this.automationOrThrow(input.id);
    const graph = parseGraph(row.draft_graph);
    const result = this.validate(row, graph);
    if (!result.valid) {
      throw invalidMany(
        result.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => ({ path: issue.path, message: `${issue.code}: ${issue.message}` })),
      );
    }
    const now = this.now();
    const current =
      row.published_version_id === null
        ? undefined
        : getVersionRow(this.db, row.published_version_id);
    let versionId: string;
    if (
      current !== undefined &&
      current.graph === row.draft_graph &&
      current.settings === row.settings
    ) {
      versionId = current.id;
    } else {
      versionId = this.ports.newId();
      const number =
        (first<{ n: number | null }>(
          this.db,
          `SELECT MAX(number) AS n FROM eng_versions WHERE automation_id = ?`,
          row.id,
        )?.n ?? 0) + 1;
      this.db.run(
        `INSERT INTO eng_versions (id, automation_id, number, graph, settings, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        versionId,
        row.id,
        number,
        row.draft_graph,
        row.settings,
        actor.userId,
        now,
      );
    }
    this.db.run(
      `UPDATE eng_automations SET status = 'active', published_version_id = ?, updated_at = ? WHERE id = ?`,
      versionId,
      now,
      row.id,
    );
    // Resume positions frozen by a previous unpublish (they keep their pinned version).
    const suspended = this.db.all<{ id: string }>(
      `SELECT id FROM eng_tokens WHERE automation_id = ? AND status = 'suspended'`,
      row.id,
    );
    for (const token of suspended) {
      this.db.run(
        `UPDATE eng_tokens SET status = 'scheduled', updated_at = ? WHERE id = ?`,
        now,
        token.id,
      );
      setJob(this.db, this.ports.newId(), 'token', token.id, now);
    }
    this.invalidate();
    this.ensurePeriodicJobs();
    const version = getVersionRow(this.db, versionId);
    if (version === undefined)
      throw new CrmError('internal_error', 'version missing after publish');
    return {
      automation: this.toAutomation(this.automationOrThrow(row.id)),
      version: this.toVersionSummary(version),
      issues: result.issues,
    };
  }

  unpublish(input: { id: string }): Automation {
    const row = this.automationOrThrow(input.id);
    if (row.status !== 'active') throw new CrmError('conflict', 'the automation is not published');
    const now = this.now();
    this.db.run(
      `UPDATE eng_automations SET status = 'inactive', updated_at = ? WHERE id = ?`,
      now,
      row.id,
    );
    const frozen = this.db.all<{ id: string }>(
      `SELECT id FROM eng_tokens WHERE automation_id = ? AND status IN ('scheduled', 'paused')`,
      row.id,
    );
    deleteTokenJobs(
      this.db,
      frozen.map((t) => t.id),
    );
    this.db.run(
      `UPDATE eng_tokens SET status = 'suspended', updated_at = ? WHERE automation_id = ? AND status IN ('scheduled', 'paused')`,
      now,
      row.id,
    );
    this.invalidate();
    return this.toAutomation(this.automationOrThrow(row.id));
  }

  listVersions(input: { id: string }): AutomationVersionSummary[] {
    this.automationOrThrow(input.id);
    return this.db
      .all<VersionRowLike>(
        `SELECT * FROM eng_versions WHERE automation_id = ? ORDER BY number DESC`,
        input.id,
      )
      .map((v) => this.toVersionSummary(v));
  }

  getVersion(input: { id: string; versionId: string }): AutomationVersion {
    const version = getVersionRow(this.db, input.versionId);
    if (version === undefined || version.automation_id !== input.id)
      throw notFound('version', input.versionId);
    return { ...this.toVersionSummary(version), graph: parseGraph(version.graph) };
  }

  restoreVersion(input: { id: string; versionId: string }): AutomationDetail {
    const version = this.getVersion(input);
    this.db.run(
      `UPDATE eng_automations SET draft_graph = ?, settings = ?, draft_revision = draft_revision + 1, updated_at = ? WHERE id = ?`,
      JSON.stringify(version.graph),
      JSON.stringify(version.settings),
      this.now(),
      input.id,
    );
    return this.getAutomation({ id: input.id });
  }

  // ----------------------------------------------------------- enrollments

  listEnrollments(input: { id: string; query: ListEnrollmentsQuery }): Page<Enrollment> {
    this.automationOrThrow(input.id);
    const q = input.query;
    const before = q.cursor === undefined ? null : decodeCursor(q.cursor).id;
    const current = q.scope === 'visited' ? null : (q.node_id ?? null);
    const visited = q.scope === 'visited' ? (q.node_id ?? null) : null;
    const rows = this.db.all<EnrollmentRow>(
      `SELECT e.* FROM eng_enrollments e
       WHERE e.automation_id = ?
         AND (? IS NULL OR e.status = ?)
         AND (? IS NULL OR e.contact_id = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM eng_tokens t WHERE t.enrollment_id = e.id
                                   AND t.node_id = ? AND t.status IN ${LIVE_SQL}))
         AND (? IS NULL OR EXISTS (SELECT 1 FROM eng_tokens t WHERE t.enrollment_id = e.id AND t.node_id = ?)
                        OR EXISTS (SELECT 1 FROM eng_goal_hits g WHERE g.enrollment_id = e.id AND g.node_id = ?)
                        OR EXISTS (SELECT 1 FROM eng_logs l WHERE l.enrollment_id = e.id AND l.node_id = ?
                                   AND l.kind IN ('node_entered', 'goal_achieved', 'enrolled')))
         AND (? IS NULL OR e.id < ?)
       ORDER BY e.id DESC LIMIT ?`,
      input.id,
      q.status ?? null,
      q.status ?? null,
      q.contact_id ?? null,
      q.contact_id ?? null,
      current,
      current,
      visited,
      visited,
      visited,
      visited,
      before,
      before,
      q.limit + 1,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      data: this.toEnrollments(page),
      next_cursor:
        rows.length > q.limit && last !== undefined ? encodeCursor({ v: null, id: last.id }) : null,
    };
  }

  getEnrollment(input: { id: string; enrollmentId: string }): EnrollmentDetail {
    const row = getEnrollmentRow(this.db, input.enrollmentId);
    if (row === undefined || row.automation_id !== input.id)
      throw notFound('enrollment', input.enrollmentId);
    const [enrollment] = this.toEnrollments([row]);
    if (enrollment === undefined) throw notFound('enrollment', input.enrollmentId);
    const log = this.db
      .all<LogRow>(
        `SELECT * FROM eng_logs WHERE enrollment_id = ? ORDER BY id DESC LIMIT 500`,
        row.id,
      )
      .reverse()
      .map(toLogEntry);
    return { ...enrollment, log };
  }

  /** Enrollments of one contact in every automation: `current` (active) or `history`. */
  contactEnrollments(input: {
    contactId: string;
    query: ListContactEnrollmentsQuery;
  }): Page<ContactEnrollment> {
    return listContactEnrollments(this.db, (id) => this.versionOrNull(id)?.compiled ?? null, input);
  }

  contactEnrollmentCounts(input: { contactId: string }): { active: number; total: number } {
    return countContactEnrollments(this.db, input);
  }

  /** Manual enrollment (ignores the re-entry rule, not an already active enrollment). */
  async enrollContact(input: { id: string; data: EnrollContactInput }): Promise<Enrollment> {
    await this.assertContact(input.data.contact_id);
    const enrollmentId = this.db.transaction(() => {
      const row = this.automationOrThrow(input.id);
      if (row.status !== 'active' || row.published_version_id === null) {
        throw new CrmError('conflict', 'only published automations accept contacts');
      }
      if (activeEnrollment(this.db, row.id, input.data.contact_id) !== undefined) {
        throw new CrmError('conflict', 'the contact is already in this automation');
      }
      const version = this.version(row.published_version_id);
      const nodeId = input.data.node_id ?? version.compiled.entryGoals[0]?.id;
      const node = nodeId === undefined ? undefined : version.compiled.nodes.get(nodeId);
      if (node === undefined || (node.type !== 'goal' && node.type !== 'sequence')) {
        throw invalidMany([
          { path: 'node_id', message: 'expected a goal or sequence of the published version' },
        ]);
      }
      const enrollment = this.createEnrollment(
        row,
        version,
        input.data.contact_id,
        'manual',
        node.id,
      );
      this.log(enrollment, 'enrolled', null, null, 'enrolled manually', {});
      if (node.type === 'goal') this.hitGoal(enrollment, version, node, 'manual enrollment');
      else this.spawn(enrollment, version, node.id);
      this.checkEnrollment(enrollment.id);
      return enrollment.id;
    });
    await this.arm();
    const enrollment = getEnrollmentRow(this.db, enrollmentId);
    if (enrollment === undefined) throw notFound('enrollment', enrollmentId);
    return this.toEnrollments([enrollment])[0] as Enrollment;
  }

  removeContact(input: { id: string; contactId: string }): {
    contact_id: string;
    removed: boolean;
  } {
    this.automationOrThrow(input.id);
    const enrollment = activeEnrollment(this.db, input.id, input.contactId);
    if (enrollment !== undefined) this.endEnrollment(enrollment.id, 'removed', 'removed manually');
    return { contact_id: input.contactId, removed: enrollment !== undefined };
  }

  stats(input: { id: string }): AutomationStats {
    const row = this.automationOrThrow(input.id);
    const counters = this.db.all<{
      node_id: string;
      step_id: string;
      entered: number;
      completed: number;
      errors: number;
    }>(
      `SELECT node_id, step_id, entered, completed, errors FROM eng_node_stats WHERE automation_id = ?`,
      row.id,
    );
    const active = new Map<string, number>();
    const bump = (key: string, by: number): void => {
      active.set(key, (active.get(key) ?? 0) + by);
    };
    const live = this.db.all<{
      version_id: string;
      node_id: string;
      step_index: number;
      status: TokenStatus;
      n: number;
    }>(
      `SELECT version_id, node_id, step_index, status, COUNT(*) AS n FROM eng_tokens
       WHERE automation_id = ? AND status IN ${LIVE_SQL} GROUP BY version_id, node_id, step_index, status`,
      row.id,
    );
    for (const group of live) {
      const version = this.versionOrNull(group.version_id);
      if (group.status === 'waiting') {
        for (const goalId of version?.compiled.goalTargetsOf(group.node_id) ?? [])
          bump(`${goalId}#`, group.n);
        continue;
      }
      bump(`${group.node_id}#`, group.n);
      const node = version?.compiled.nodes.get(group.node_id);
      const step = isSequence(node) ? node.steps[group.step_index] : undefined;
      if (step !== undefined) bump(`${group.node_id}#${step.id}`, group.n);
    }
    const graphVersion =
      row.published_version_id === null ? null : this.versionOrNull(row.published_version_id);
    const graph = graphVersion?.compiled.graph ?? parseGraph(row.draft_graph);
    const byKey = new Map<string, NodeStats>();
    const entry = (nodeId: string, stepId: string | null): NodeStats => {
      const key = `${nodeId}#${stepId ?? ''}`;
      let stat = byKey.get(key);
      if (stat === undefined) {
        stat = {
          node_id: nodeId,
          step_id: stepId,
          entered: 0,
          active: active.get(key) ?? 0,
          completed: 0,
          errors: 0,
        };
        byKey.set(key, stat);
      }
      return stat;
    };
    for (const node of graph.nodes) {
      if (node.type === 'note') continue;
      entry(node.id, null);
      if (node.type === 'sequence') for (const step of node.steps) entry(node.id, step.id);
    }
    for (const c of counters) {
      const stat = entry(c.node_id, c.step_id === '' ? null : c.step_id);
      stat.entered = c.entered;
      stat.completed = c.completed;
      stat.errors = c.errors;
    }
    const totals = { active: 0, completed: 0, removed: 0, failed: 0 };
    for (const t of this.db.all<{ status: keyof typeof totals; n: number }>(
      `SELECT status, COUNT(*) AS n FROM eng_enrollments WHERE automation_id = ? GROUP BY status`,
      row.id,
    )) {
      totals[t.status] = t.n;
    }
    return { automation_id: row.id, enrollments: totals, nodes: [...byKey.values()] };
  }

  async triggerApiGoal(input: {
    callName: string;
    data: TriggerApiGoalInput;
  }): Promise<TriggerApiGoalResult> {
    await this.assertContact(input.data.contact_id);
    const eventId = `api:${input.data.event_id ?? this.ports.newId()}`;
    const result = this.db.transaction(() =>
      this.handleEvent({
        id: eventId,
        type: 'automation.api_goal',
        occurredAt: iso(this.now()),
        payload: { contactId: input.data.contact_id, callName: input.callName },
      }),
    );
    await this.arm();
    return {
      call_name: input.callName,
      contact_id: input.data.contact_id,
      matched: result.matched.map((m) => ({ automation_id: m.automationId, node_id: m.nodeId })),
      duplicate: result.duplicate,
    };
  }

  getSettings(): EngineSettings {
    return { time_zone: this.tenantTimeZone() };
  }

  updateSettings(input: { time_zone: string }): EngineSettings {
    if (!isValidTimeZone(input.time_zone)) {
      throw invalidMany([{ path: 'time_zone', message: 'unknown time zone' }]);
    }
    setMeta(this.db, 'time_zone', input.time_zone);
    return this.getSettings();
  }

  async getSigningSecret(input: {
    id: string;
  }): Promise<{ automation_id: string; secret: string }> {
    this.automationOrThrow(input.id);
    return { automation_id: input.id, secret: await this.signingSecret(input.id) };
  }

  async rotateSigningSecret(input: {
    id: string;
  }): Promise<{ automation_id: string; secret: string }> {
    this.automationOrThrow(input.id);
    const secret = randomSecret();
    this.db.run(
      `UPDATE eng_automations SET signing_secret = ?, updated_at = ? WHERE id = ?`,
      await this.sealSecret(input.id, secret),
      this.now(),
      input.id,
    );
    return { automation_id: input.id, secret };
  }

  /** Stored form of a signing secret: AES-GCM ciphertext bound to the automation id. */
  private async sealSecret(automationId: string, secret: string): Promise<string> {
    const box = (await this.ports.secretBox?.()) ?? null;
    return box === null ? secret : box.encrypt(secret, `automation:${automationId}`);
  }

  /**
   * Plaintext signing secret of an automation. New automations store an empty
   * value until first use; secrets saved before encryption existed (plaintext)
   * are sealed on first read.
   */
  async signingSecret(automationId: string): Promise<string> {
    const stored = getAutomationRow(this.db, automationId)?.signing_secret;
    if (stored === undefined) return '';
    const box = (await this.ports.secretBox?.()) ?? null;
    if (stored.startsWith(SEALED_PREFIX)) {
      if (box === null) throw new Error('signing secret is encrypted but no encryption key is set');
      return box.decrypt(stored, `automation:${automationId}`);
    }
    if (stored !== '' && box === null) return stored;
    const secret = stored === '' ? randomSecret() : stored;
    const sealed = await this.sealSecret(automationId, secret);
    // Compare-and-set: a concurrent first use may have stored its own secret meanwhile.
    this.db.run(
      `UPDATE eng_automations SET signing_secret = ? WHERE id = ? AND signing_secret = ?`,
      sealed,
      automationId,
      stored,
    );
    const current = getAutomationRow(this.db, automationId)?.signing_secret ?? sealed;
    if (current === sealed) return secret;
    return current.startsWith(SEALED_PREFIX) && box !== null
      ? box.decrypt(current, `automation:${automationId}`)
      : current;
  }

  // ============================================================ event bus

  /** Events pushed by other modules (forms, email tracking, booking, analytics). */
  async ingest(
    events: readonly AutomationInboundEvent[],
  ): Promise<{ accepted: number; matched: number }> {
    let matched = 0;
    for (const event of events) {
      const result = this.db.transaction(() => this.handleEvent(event));
      matched += result.matched.length;
    }
    await this.arm();
    await this.ports.webhooks?.publish(
      events.map((event) => ({
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        payload: event.payload as unknown as Readonly<Record<string, unknown>>,
      })),
    );
    return { accepted: events.length, matched };
  }

  /** Asks for an outbox drain as soon as possible (called after mutating requests). */
  async kick(): Promise<void> {
    scheduleNoLaterThan(this.db, this.ports.newId(), 'poll', '', this.now());
    await this.arm();
  }

  /**
   * Pulls the TenantDb outbox (at-least-once): handle every event (deduped by
   * id in the same transaction as its effects), then ack the batch.
   */
  async drainOutbox(): Promise<number> {
    if (this.draining) {
      this.drainAgain = true;
      return 0;
    }
    this.draining = true;
    let handled = 0;
    try {
      for (let round = 0; round < 40; round += 1) {
        const events = await crmCall(this.ports.crm, 'events.pending', { limit: OUTBOX_BATCH });
        if (events.length === 0) break;
        for (const event of events) {
          this.db.transaction(() =>
            this.handleEvent({
              id: event.id,
              type: event.type,
              occurredAt: event.occurredAt,
              payload: event.payload as unknown as Readonly<Record<string, unknown>>,
            }),
          );
          handled += 1;
        }
        await this.ports.webhooks?.publish(
          events.map((event) => ({
            id: event.id,
            type: event.type,
            occurredAt: event.occurredAt,
            payload: event.payload as unknown as Readonly<Record<string, unknown>>,
          })),
        );
        await crmCall(this.ports.crm, 'events.ack', { ids: events.map((e) => e.id) });
        if (events.length < OUTBOX_BATCH) break;
      }
    } finally {
      this.draining = false;
    }
    if (this.drainAgain) {
      this.drainAgain = false;
      scheduleNoLaterThan(this.db, this.ports.newId(), 'poll', '', this.now());
    }
    return handled;
  }

  /** Matches one event against the goals of every published automation. Runs inside a transaction. */
  handleEvent(event: EngineEvent): {
    duplicate: boolean;
    matched: Array<{ automationId: string; nodeId: string }>;
  } {
    const seen = first(
      this.db,
      `SELECT 1 AS x FROM eng_processed_events WHERE event_id = ?`,
      event.id,
    );
    if (seen !== undefined) return { duplicate: true, matched: [] };
    this.db.run(
      `INSERT INTO eng_processed_events (event_id, processed_at) VALUES (?, ?)`,
      event.id,
      this.now(),
    );

    if (event.type === 'contact.deleted' || event.type === 'contact.merged') {
      const removed =
        event.type === 'contact.deleted'
          ? [eventContactId(event)]
          : Array.isArray(event.payload['mergedContactIds'])
            ? event.payload['mergedContactIds']
            : [];
      for (const contactId of removed) {
        if (typeof contactId === 'string')
          this.removeEverywhere(contactId, `contact ${event.type.split('.')[1] ?? ''}`);
      }
      return { duplicate: false, matched: [] };
    }

    const contactId = eventContactId(event);
    if (contactId === null) return { duplicate: false, matched: [] };
    const targetAutomation =
      typeof event.payload['automationId'] === 'string' ? event.payload['automationId'] : null;
    const targetNode = typeof event.payload['nodeId'] === 'string' ? event.payload['nodeId'] : null;
    const matched: Array<{ automationId: string; nodeId: string }> = [];

    for (const automation of this.activeAutomations()) {
      if (targetAutomation !== null && automation.id !== targetAutomation) continue;
      const enrollment = activeEnrollment(this.db, automation.id, contactId);
      const versionId = enrollment?.version_id ?? automation.published_version_id;
      if (versionId === null) continue;
      const version = this.version(versionId);
      const candidates = version.compiled.goalsByEvent.get(event.type) ?? [];
      const nodes = new Map<string, GoalNode>();
      for (const ref of candidates) {
        if (targetNode !== null && ref.node.id !== targetNode) continue;
        if (triggerMatches(ref.trigger, event)) nodes.set(ref.node.id, ref.node);
      }
      for (const node of nodes.values()) {
        if (this.achieveGoal(automation, node.id, contactId, `${event.type} (${event.id})`)) {
          matched.push({ automationId: automation.id, nodeId: node.id });
        }
      }
    }
    return { duplicate: false, matched };
  }

  /**
   * A contact reached a goal: pulls it out of every node upstream of the goal
   * and continues from the goal; contacts outside the automation enter here
   * (unless the goal only accepts enrolled contacts or re-entry forbids it).
   */
  private achieveGoal(
    automation: AutomationRow,
    nodeId: string,
    contactId: string,
    reason: string,
  ): boolean {
    let enrollment = activeEnrollment(this.db, automation.id, contactId);
    let version: VersionInfo;
    if (enrollment !== undefined) {
      version = this.version(enrollment.version_id);
      const hit = first(
        this.db,
        `SELECT 1 AS x FROM eng_goal_hits WHERE enrollment_id = ? AND node_id = ?`,
        enrollment.id,
        nodeId,
      );
      if (hit !== undefined) return false;
    } else {
      if (automation.published_version_id === null) return false;
      version = this.version(automation.published_version_id);
      const goal = version.compiled.nodes.get(nodeId);
      if (goal?.type !== 'goal' || goal.accept === 'enrolled_only') return false;
      if (version.settings.reentry !== 'multiple') {
        const before = first(
          this.db,
          `SELECT 1 AS x FROM eng_enrollments WHERE automation_id = ? AND contact_id = ?`,
          automation.id,
          contactId,
        );
        if (before !== undefined) return false;
      }
      enrollment = this.createEnrollment(automation, version, contactId, 'goal', nodeId);
      this.log(enrollment, 'enrolled', nodeId, null, `entered via goal ${nodeId}`, {});
    }
    const node = version.compiled.nodes.get(nodeId);
    if (node?.type !== 'goal') return false;
    this.hitGoal(enrollment, version, node, reason);
    this.checkEnrollment(enrollment.id);
    return true;
  }

  private hitGoal(
    enrollment: EnrollmentRow,
    version: VersionInfo,
    goal: GoalNode,
    reason: string,
  ): void {
    const now = this.now();
    this.db.run(
      `INSERT OR IGNORE INTO eng_goal_hits (enrollment_id, node_id, at) VALUES (?, ?, ?)`,
      enrollment.id,
      goal.id,
      now,
    );
    const upstream = version.compiled.upstreamOf(goal.id);
    if (upstream.size > 0) {
      const pulled = this.db
        .all<{ id: string; node_id: string }>(
          `SELECT id, node_id FROM eng_tokens WHERE enrollment_id = ? AND status IN ${LIVE_SQL}`,
          enrollment.id,
        )
        .filter((t) => upstream.has(t.node_id));
      this.cancelTokens(pulled.map((t) => t.id));
      for (const t of pulled) {
        this.log(enrollment, 'cancelled', t.node_id, null, `pulled forward by goal ${goal.id}`, {});
      }
    }
    bumpStat(this.db, enrollment.automation_id, goal.id, null, 'entered');
    bumpStat(this.db, enrollment.automation_id, goal.id, null, 'completed');
    this.log(enrollment, 'goal_achieved', goal.id, null, `goal achieved: ${reason}`, {});
    this.leave(enrollment, version, goal.id, null, null);
  }

  /** Follows the outgoing edges of a node: new positions for sequences/decisions, waiting for goals. */
  private leave(
    enrollment: EnrollmentRow,
    version: VersionInfo,
    nodeId: string,
    handle: string | null,
    token: TokenRow | null,
  ): void {
    const now = this.now();
    const edges = edgesFrom(version.compiled, nodeId, handle);
    let waits = false;
    for (const edge of edges) {
      const target = version.compiled.nodes.get(edge.target);
      if (target === undefined || target.type === 'note') continue;
      if (target.type === 'goal') waits = true;
      else this.spawn(enrollment, version, target.id);
    }
    if (token !== null) {
      this.db.run(
        `UPDATE eng_tokens SET status = ?, step_state = NULL, updated_at = ? WHERE id = ?`,
        waits ? 'waiting' : 'done',
        now,
        token.id,
      );
      deleteJob(this.db, 'token', token.id);
    } else if (waits) {
      this.insertToken(enrollment, nodeId, 'waiting');
    }
  }

  private spawn(enrollment: EnrollmentRow, version: VersionInfo, nodeId: string): void {
    const id = this.insertToken(enrollment, nodeId, 'scheduled');
    setJob(this.db, this.ports.newId(), 'token', id, this.now());
    bumpStat(this.db, enrollment.automation_id, nodeId, null, 'entered');
    const node = version.compiled.nodes.get(nodeId);
    const label = node !== undefined && node.type !== 'note' ? (node.label ?? nodeId) : nodeId;
    this.log(
      enrollment,
      'node_entered',
      nodeId,
      null,
      `entered ${node?.type ?? 'node'} ${label}`,
      {},
    );
  }

  private insertToken(enrollment: EnrollmentRow, nodeId: string, status: TokenStatus): string {
    const id = this.ports.newId();
    const now = this.now();
    this.db.run(
      `INSERT INTO eng_tokens (id, enrollment_id, automation_id, version_id, contact_id, node_id, step_index, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
      id,
      enrollment.id,
      enrollment.automation_id,
      enrollment.version_id,
      enrollment.contact_id,
      nodeId,
      status,
      now,
      now,
    );
    return id;
  }

  private createEnrollment(
    automation: AutomationRow,
    version: VersionInfo,
    contactId: string,
    source: EnrollmentRow['source'],
    entryNodeId: string | null,
  ): EnrollmentRow {
    const id = this.ports.newId();
    const now = this.now();
    this.db.run(
      `INSERT INTO eng_enrollments (id, automation_id, version_id, contact_id, status, source, entry_node_id, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      id,
      automation.id,
      version.id,
      contactId,
      source,
      entryNodeId,
      now,
      now,
    );
    const row = getEnrollmentRow(this.db, id);
    if (row === undefined) throw new CrmError('internal_error', 'enrollment missing after insert');
    return row;
  }

  private cancelTokens(ids: readonly string[]): void {
    for (const chunk of chunks(ids)) {
      this.db.run(
        `UPDATE eng_tokens SET status = 'cancelled', updated_at = ? WHERE id IN (${placeholders(chunk.length)})`,
        this.now(),
        ...chunk,
      );
      deleteTokenJobs(this.db, chunk);
    }
  }

  /** Completes an enrollment once no live position is left. */
  private checkEnrollment(enrollmentId: string): void {
    const enrollment = getEnrollmentRow(this.db, enrollmentId);
    if (enrollment?.status !== 'active') return;
    const live = first(
      this.db,
      `SELECT 1 AS x FROM eng_tokens WHERE enrollment_id = ? AND status IN ${LIVE_SQL}`,
      enrollmentId,
    );
    if (live !== undefined) return;
    const failed = first(
      this.db,
      `SELECT 1 AS x FROM eng_tokens WHERE enrollment_id = ? AND status = 'failed'`,
      enrollmentId,
    );
    const status = failed === undefined ? 'completed' : 'failed';
    const now = this.now();
    this.db.run(
      `UPDATE eng_enrollments SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
      status,
      now,
      now,
      enrollmentId,
    );
    this.log(
      enrollment,
      'completed',
      null,
      null,
      status === 'completed' ? 'automation completed' : 'automation ended with errors',
      {},
    );
  }

  private endEnrollment(
    enrollmentId: string,
    status: 'removed' | 'completed',
    message: string,
  ): void {
    const enrollment = getEnrollmentRow(this.db, enrollmentId);
    if (enrollment?.status !== 'active') return;
    const live = this.db.all<{ id: string }>(
      `SELECT id FROM eng_tokens WHERE enrollment_id = ? AND status IN ${LIVE_SQL}`,
      enrollmentId,
    );
    this.cancelTokens(live.map((t) => t.id));
    const now = this.now();
    this.db.run(
      `UPDATE eng_enrollments SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
      status,
      now,
      now,
      enrollmentId,
    );
    this.log(enrollment, status === 'removed' ? 'removed' : 'completed', null, null, message, {});
  }

  private removeEverywhere(contactId: string, message: string): void {
    for (const e of this.db.all<{ id: string }>(
      `SELECT id FROM eng_enrollments WHERE contact_id = ? AND status = 'active'`,
      contactId,
    )) {
      this.endEnrollment(e.id, 'removed', message);
    }
  }

  // ======================================================= StepHost (sync)

  nextRoundRobin(key: string, size: number): number {
    const current = Number(getMeta(this.db, key) ?? '0');
    setMeta(this.db, key, String(current + 1));
    return current % Math.max(size, 1);
  }

  addToSequence(contactId: string, automationId: string, nodeId: string): string {
    return this.db.transaction(() => {
      const automation = getAutomationRow(this.db, automationId);
      if (automation?.status !== 'active' || automation.published_version_id === null) {
        return `automation ${automationId} is not published: skipped`;
      }
      let enrollment = activeEnrollment(this.db, automationId, contactId);
      const version = this.version(enrollment?.version_id ?? automation.published_version_id);
      if (!isSequence(version.compiled.nodes.get(nodeId)))
        return `sequence ${nodeId} not found: skipped`;
      if (enrollment === undefined) {
        enrollment = this.createEnrollment(automation, version, contactId, 'sequence', nodeId);
        this.log(
          enrollment,
          'enrolled',
          nodeId,
          null,
          'added to sequence by another automation',
          {},
        );
      } else {
        const there = first(
          this.db,
          `SELECT 1 AS x FROM eng_tokens WHERE enrollment_id = ? AND node_id = ? AND status IN ${LIVE_SQL}`,
          enrollment.id,
          nodeId,
        );
        if (there !== undefined) return 'already in the sequence';
      }
      this.spawn(enrollment, version, nodeId);
      return `added to ${automationId}/${nodeId}`;
    });
  }

  removeFromSequence(
    contactId: string,
    automationId: string,
    nodeId: string | undefined,
    selfTokenId: string,
  ): string {
    return this.db.transaction(() => {
      const enrollment = activeEnrollment(this.db, automationId, contactId);
      if (enrollment === undefined) return 'not in the automation';
      if (nodeId === undefined) {
        const self = getTokenRow(this.db, selfTokenId);
        if (self?.enrollment_id === enrollment.id) {
          // Removing the contact from its own automation: let this step finish first.
          const others = this.db.all<{ id: string }>(
            `SELECT id FROM eng_tokens WHERE enrollment_id = ? AND id != ? AND status IN ${LIVE_SQL}`,
            enrollment.id,
            selfTokenId,
          );
          this.cancelTokens(others.map((t) => t.id));
          this.db.run(
            `UPDATE eng_tokens SET status = 'cancelled', updated_at = ? WHERE id = ?`,
            this.now(),
            selfTokenId,
          );
        }
        this.endEnrollment(enrollment.id, 'removed', 'removed by an automation step');
        return `removed from ${automationId}`;
      }
      const tokens = this.db.all<{ id: string }>(
        `SELECT id FROM eng_tokens WHERE enrollment_id = ? AND node_id = ? AND id != ? AND status IN ${LIVE_SQL}`,
        enrollment.id,
        nodeId,
        selfTokenId,
      );
      this.cancelTokens(tokens.map((t) => t.id));
      this.checkEnrollment(enrollment.id);
      return `removed from ${automationId}/${nodeId}`;
    });
  }

  // ============================================================ scheduler

  /** Points the DO alarm at the earliest job (the job table is the min-heap). */
  async arm(): Promise<void> {
    const at = earliestJob(this.db);
    const target = at === null ? null : Math.max(at, this.now());
    if (target === this.armedAt) return;
    this.armedAt = target;
    await this.ports.alarm.set(target);
  }

  /** Alarm handler: runs every due job, re-arms. Loops while work keeps becoming due now. */
  async runDue(maxRounds = 10): Promise<number> {
    this.armedAt = undefined;
    let processed = 0;
    for (let round = 0; round < maxRounds; round += 1) {
      const now = this.now();
      const jobs = this.db.all<JobRow>(
        `SELECT * FROM eng_jobs WHERE due_at <= ? ORDER BY due_at, id LIMIT ?`,
        now,
        JOBS_PER_ROUND,
      );
      if (jobs.length === 0) break;
      const tokens: string[] = [];
      for (const job of jobs) {
        if (job.kind === 'token') {
          tokens.push(job.ref);
          continue;
        }
        deleteJob(this.db, job.kind, job.ref);
        try {
          if (job.kind === 'poll') {
            await this.drainOutbox();
            if (this.activeAutomations().length > 0) {
              scheduleNoLaterThan(
                this.db,
                this.ports.newId(),
                'poll',
                '',
                this.now() + POLL_INTERVAL_MS,
              );
            }
          } else if (job.kind === 'anniversary') {
            await this.anniversaryScan();
          } else if (job.kind === 'prune') {
            this.prune();
          }
        } catch (error) {
          console.error(`[engine] ${job.kind} job failed: ${describe(error)}`);
          scheduleNoLaterThan(this.db, this.ports.newId(), job.kind, job.ref, this.now() + 30_000);
        }
      }
      for (let i = 0; i < tokens.length; i += CONCURRENCY) {
        await Promise.all(tokens.slice(i, i + CONCURRENCY).map((id) => this.runToken(id)));
      }
      processed += jobs.length;
    }
    await this.arm();
    return processed;
  }

  /** Re-checks every email step paused by the quota guard right away. */
  async resumePaused(): Promise<number> {
    const paused = this.db.all<{ id: string }>(`SELECT id FROM eng_tokens WHERE status = 'paused'`);
    const now = this.now();
    for (const t of paused) setJob(this.db, this.ports.newId(), 'token', t.id, now);
    await this.arm();
    return paused.length;
  }

  private ensurePeriodicJobs(): void {
    const now = this.now();
    scheduleNoLaterThan(this.db, this.ports.newId(), 'poll', '', now);
    scheduleNoLaterThan(this.db, this.ports.newId(), 'prune', '', now + 24 * 60 * 60_000);
    const hasAnniversary = this.activeAutomations().some((a) => {
      const v = a.published_version_id === null ? null : this.versionOrNull(a.published_version_id);
      return (v?.compiled.goalsByEvent.get('automation.date_anniversary') ?? []).length > 0;
    });
    if (hasAnniversary) scheduleNoLaterThan(this.db, this.ports.newId(), 'anniversary', '', now);
  }

  private prune(): void {
    const now = this.now();
    this.db.run(
      `DELETE FROM eng_processed_events WHERE processed_at < ?`,
      now - PROCESSED_EVENTS_TTL_MS,
    );
    this.db.run(
      `DELETE FROM eng_step_runs WHERE at < ? AND key NOT IN (
         SELECT t.id || ':' || t.step_index FROM eng_tokens t WHERE t.status IN ${LIVE_SQL})`,
      now - PROCESSED_EVENTS_TTL_MS,
    );
    // Execution logs: bounded batches so one alarm never runs a huge delete.
    let more = false;
    for (let batch = 0; batch < LOG_PRUNE_BATCHES; batch += 1) {
      this.db.run(
        `DELETE FROM eng_logs WHERE id IN (SELECT id FROM eng_logs WHERE at < ? LIMIT ?)`,
        now - LOG_RETENTION_MS,
        LOG_PRUNE_BATCH_SIZE,
      );
      more =
        this.db.all(`SELECT 1 FROM eng_logs WHERE at < ? LIMIT 1`, now - LOG_RETENTION_MS).length >
        0;
      if (!more) break;
    }
    const next = more ? now + 60_000 : now + 24 * 60 * 60_000;
    scheduleNoLaterThan(this.db, this.ports.newId(), 'prune', '', next);
  }

  /**
   * Hourly scan for date-anniversary goals: once the local time of the goal is
   * reached, every contact whose date field (shifted by the offset) is today
   * achieves it. The synthetic event id carries the date, so it fires once a day.
   */
  async anniversaryScan(): Promise<number> {
    const now = this.now();
    let fired = 0;
    for (const automation of this.activeAutomations()) {
      if (automation.published_version_id === null) continue;
      const version = this.version(automation.published_version_id);
      for (const ref of version.compiled.goalsByEvent.get('automation.date_anniversary') ?? []) {
        if (ref.trigger.type !== 'date_anniversary') continue;
        const trigger = ref.trigger;
        const zone =
          trigger.time_zone === undefined || trigger.time_zone === 'tenant'
            ? (version.settings.time_zone ?? this.tenantTimeZone())
            : trigger.time_zone;
        const local = wallClock(now, zone);
        const [h, m] = parseTimeOfDay(trigger.time, '09:00');
        if (local.hour * 60 + local.minute < h * 60 + m) continue;
        const today = { year: local.year, month: local.month, day: local.day };
        const target = addDays(today, -(trigger.offset_days ?? 0));
        const monthDay = formatDate(target).slice(5);
        const ids = await crmCall(this.ports.crm, 'automation.contactIdsByMonthDay', {
          field: trigger.field,
          monthDay,
          includeLeapDay: monthDay === '02-28' && !isLeap(target.year),
        });
        this.db.transaction(() => {
          for (const contactId of ids) {
            const result = this.handleEvent({
              id: `anniv:${automation.id}:${ref.node.id}:${ref.triggerIndex}:${contactId}:${formatDate(today)}`,
              type: 'automation.date_anniversary',
              occurredAt: iso(now),
              payload: { contactId, automationId: automation.id, nodeId: ref.node.id },
            });
            fired += result.matched.length;
          }
        });
      }
    }
    const next = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
    if (this.activeAutomations().length > 0) {
      scheduleNoLaterThan(this.db, this.ports.newId(), 'anniversary', '', next);
    }
    return fired;
  }

  // ================================================================ runner

  /** Leases a due token and advances it as far as it can go now. */
  async runToken(tokenId: string): Promise<void> {
    const leased = this.db.transaction((): TokenRow | null => {
      const token = getTokenRow(this.db, tokenId);
      const now = this.now();
      if (token === undefined || !['scheduled', 'paused', 'running'].includes(token.status)) {
        deleteJob(this.db, 'token', tokenId);
        return null;
      }
      const automation = getAutomationRow(this.db, token.automation_id);
      if (automation?.status !== 'active') {
        this.db.run(
          `UPDATE eng_tokens SET status = 'suspended', updated_at = ? WHERE id = ?`,
          now,
          tokenId,
        );
        deleteJob(this.db, 'token', tokenId);
        return null;
      }
      setJob(this.db, this.ports.newId(), 'token', tokenId, now + LEASE_MS);
      this.db.run(
        `UPDATE eng_tokens SET status = 'running', updated_at = ? WHERE id = ?`,
        now,
        tokenId,
      );
      return { ...token, status: 'running' };
    });
    if (leased === null) return;
    try {
      await this.advance(leased);
    } catch (error) {
      // Unexpected error outside a step: retry the whole token later.
      this.db.transaction(() =>
        this.fail(leased, null, error instanceof Error ? error.message : String(error), false),
      );
    }
  }

  private async advance(start: TokenRow): Promise<void> {
    let token: TokenRow | undefined = start;
    let contact: Promise<Contact> | null = null;
    const loadContact = (): Promise<Contact> => {
      contact ??= crmCall(this.ports.crm, 'contacts.get', { id: start.contact_id }).catch(
        (error: unknown) => {
          contact = null;
          if (error instanceof CrmCallError) throw new StepFailure(error.message, true);
          throw new StepFailure(error instanceof Error ? error.message : String(error), false);
        },
      );
      return contact;
    };

    for (let i = 0; i < STEPS_PER_RUN; i += 1) {
      token = getTokenRow(this.db, start.id);
      if (token?.status !== 'running') return;
      const enrollment = getEnrollmentRow(this.db, token.enrollment_id);
      if (enrollment?.status !== 'active') {
        this.db.transaction(() => this.cancelTokens([start.id]));
        return;
      }
      const version = this.version(token.version_id);
      const node = version.compiled.nodes.get(token.node_id);

      if (isDecision(node)) {
        let handle = 'default';
        try {
          for (const branch of node.branches) {
            if (await this.contactMatches(token.contact_id, branch.filter)) {
              handle = branch.id;
              break;
            }
          }
        } catch (error) {
          this.db.transaction(() =>
            this.fail(token as TokenRow, null, describe(error), isPermanent(error)),
          );
          return;
        }
        const current = token;
        this.db.transaction(() => {
          if (getTokenRow(this.db, current.id)?.status !== 'running') return;
          bumpStat(this.db, current.automation_id, node.id, null, 'completed');
          this.log(enrollment, 'decision', node.id, null, `branch ${handle}`, { branch: handle });
          this.leave(enrollment, version, node.id, handle, current);
          this.checkEnrollment(enrollment.id);
        });
        return;
      }

      if (!isSequence(node)) {
        this.db.transaction(() =>
          this.fail(
            token as TokenRow,
            null,
            `node ${token?.node_id ?? ''} missing from version`,
            true,
          ),
        );
        return;
      }

      const step = node.steps[token.step_index];
      if (step === undefined) {
        const current = token;
        this.db.transaction(() => {
          if (getTokenRow(this.db, current.id)?.status !== 'running') return;
          bumpStat(this.db, current.automation_id, node.id, null, 'completed');
          this.leave(enrollment, version, node.id, null, current);
          this.checkEnrollment(enrollment.id);
        });
        return;
      }

      const key = `${token.id}:${token.step_index}`;
      const state = parseJson<StepState>(token.step_state, {});
      if (token.step_state === null && token.attempts === 0) {
        bumpStat(this.db, token.automation_id, node.id, step.id, 'entered');
      }
      const alreadyDone =
        first(this.db, `SELECT 1 AS x FROM eng_step_runs WHERE key = ?`, key) !== undefined;
      let outcome: StepOutcome;
      if (alreadyDone) {
        outcome = { kind: 'done', message: 'already executed' };
      } else {
        const ctx: StepContext = {
          host: this,
          tokenId: token.id,
          enrollmentId: enrollment.id,
          automationId: token.automation_id,
          versionId: token.version_id,
          contactId: token.contact_id,
          settings: version.settings,
          node,
          step,
          key,
          state,
          now: this.now(),
          contact: loadContact,
          timeZone: async (explicit) => {
            if (explicit === 'tenant') return version.settings.time_zone ?? this.tenantTimeZone();
            if (explicit !== undefined && isValidTimeZone(explicit)) return explicit;
            const own = (await loadContact()).time_zone;
            if (own !== null && isValidTimeZone(own)) return own;
            return version.settings.time_zone ?? this.tenantTimeZone();
          },
        };
        try {
          outcome = await executeStep(ctx);
        } catch (error) {
          this.db.transaction(() =>
            this.fail(token as TokenRow, step, describe(error), isPermanent(error)),
          );
          return;
        }
      }

      const current = token;
      const proceed = this.db.transaction(() =>
        this.applyOutcome(current, enrollment, node.id, step, key, state, outcome),
      );
      if (!proceed) return;
    }
    // Step budget exhausted: continue in the next alarm.
    this.db.transaction(() => {
      if (getTokenRow(this.db, start.id)?.status !== 'running') return;
      this.db.run(
        `UPDATE eng_tokens SET status = 'scheduled', updated_at = ? WHERE id = ?`,
        this.now(),
        start.id,
      );
      setJob(this.db, this.ports.newId(), 'token', start.id, this.now());
    });
  }

  /** Persists a step outcome; returns true when the token should run its next step now. */
  private applyOutcome(
    token: TokenRow,
    enrollment: EnrollmentRow,
    nodeId: string,
    step: Step,
    key: string,
    state: StepState,
    outcome: StepOutcome,
  ): boolean {
    const now = this.now();
    // Cancelled (pulled forward, removed) while the step was in flight: the effect stays, the position does not.
    if (getTokenRow(this.db, token.id)?.status !== 'running') {
      if (outcome.kind === 'done') this.recordRun(key, outcome);
      return false;
    }
    switch (outcome.kind) {
      case 'done':
      case 'skip': {
        this.recordRun(key, outcome);
        bumpStat(this.db, token.automation_id, nodeId, step.id, 'completed');
        if (outcome.kind === 'skip' || !TIMER_STEPS.has(step.type) || state.until !== undefined) {
          this.log(
            enrollment,
            outcome.kind === 'skip'
              ? 'step_skipped'
              : state.paused === true
                ? 'resumed'
                : 'step_done',
            nodeId,
            step.id,
            outcome.message,
            outcome.kind === 'done' ? (outcome.result ?? {}) : {},
          );
        }
        this.db.run(
          `UPDATE eng_tokens SET step_index = step_index + 1, step_state = NULL, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
          now,
          token.id,
        );
        return true;
      }
      case 'wait': {
        const firstWait = state.until === undefined;
        this.db.run(
          `UPDATE eng_tokens SET status = 'scheduled', step_state = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify({ ...state, until: outcome.until }),
          now,
          token.id,
        );
        setJob(this.db, this.ports.newId(), 'token', token.id, outcome.until);
        if (firstWait) {
          this.log(enrollment, 'step_waiting', nodeId, step.id, outcome.message, {
            until: iso(outcome.until),
          });
        }
        return false;
      }
      case 'pause': {
        const wasPaused = state.paused === true;
        this.db.run(
          `UPDATE eng_tokens SET status = 'paused', step_state = ?, updated_at = ? WHERE id = ?`,
          JSON.stringify({ ...state, paused: true }),
          now,
          token.id,
        );
        setJob(this.db, this.ports.newId(), 'token', token.id, outcome.until);
        if (!wasPaused)
          this.log(enrollment, 'paused', nodeId, step.id, outcome.message, {
            retry_at: iso(outcome.until),
          });
        return false;
      }
      case 'stop': {
        this.recordRun(key, outcome);
        this.log(enrollment, 'step_done', nodeId, step.id, outcome.message, {});
        this.db.run(
          `UPDATE eng_tokens SET status = 'done', step_state = NULL, updated_at = ? WHERE id = ?`,
          now,
          token.id,
        );
        deleteJob(this.db, 'token', token.id);
        this.checkEnrollment(enrollment.id);
        return false;
      }
      case 'end': {
        this.recordRun(key, outcome);
        bumpStat(this.db, token.automation_id, nodeId, step.id, 'completed');
        this.db.run(
          `UPDATE eng_tokens SET status = 'done', step_state = NULL, updated_at = ? WHERE id = ?`,
          now,
          token.id,
        );
        deleteJob(this.db, 'token', token.id);
        this.endEnrollment(enrollment.id, 'completed', outcome.message);
        return false;
      }
    }
  }

  private recordRun(key: string, outcome: StepOutcome): void {
    this.db.run(
      `INSERT OR IGNORE INTO eng_step_runs (key, result, at) VALUES (?, ?, ?)`,
      key,
      JSON.stringify(outcome),
      this.now(),
    );
  }

  /** Step failure: retry with backoff, then stop the position (or continue when configured). */
  private fail(token: TokenRow, step: Step | null, message: string, permanent: boolean): void {
    const current = getTokenRow(this.db, token.id);
    if (current === undefined || current.status !== 'running') return;
    const enrollment = getEnrollmentRow(this.db, token.enrollment_id);
    if (enrollment === undefined) return;
    const now = this.now();
    const attempts = current.attempts + 1;
    if (!permanent && attempts < MAX_ATTEMPTS) {
      const retryAt = now + backoffMs(attempts);
      this.db.run(
        `UPDATE eng_tokens SET status = 'scheduled', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        attempts,
        message,
        now,
        token.id,
      );
      setJob(this.db, this.ports.newId(), 'token', token.id, retryAt);
      this.log(
        enrollment,
        'step_retry',
        token.node_id,
        step?.id ?? null,
        `attempt ${attempts} failed: ${message}`,
        { retry_at: iso(retryAt) },
      );
      return;
    }
    bumpStat(this.db, token.automation_id, token.node_id, null, 'errors');
    if (step !== null) bumpStat(this.db, token.automation_id, token.node_id, step.id, 'errors');
    this.log(enrollment, 'step_failed', token.node_id, step?.id ?? null, message, {
      attempts,
      permanent,
    });
    if (step?.continue_on_error === true) {
      this.db.run(
        `UPDATE eng_tokens SET status = 'scheduled', step_index = step_index + 1, step_state = NULL, attempts = 0, last_error = ?, updated_at = ? WHERE id = ?`,
        message,
        now,
        token.id,
      );
      setJob(this.db, this.ports.newId(), 'token', token.id, now);
      return;
    }
    this.db.run(
      `UPDATE eng_tokens SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      attempts,
      message,
      now,
      token.id,
    );
    deleteJob(this.db, 'token', token.id);
    this.checkEnrollment(enrollment.id);
  }

  /** Decision branch: the query-builder filter scoped to one contact. */
  private async contactMatches(contactId: string, filter: SearchQuery['filter']): Promise<boolean> {
    const scoped = {
      type: 'group',
      op: 'and',
      conditions: [
        { type: 'field', field: 'id', operator: 'equals', value: contactId },
        ...(filter === undefined ? [] : [filter]),
      ],
    } as const;
    const result = await crmCall(this.ports.crm, 'search.query', {
      entity: 'contact',
      filter: scoped as unknown as SearchQuery['filter'],
      columns: ['id'],
      limit: 1,
    });
    return result.data.length > 0;
  }

  // =============================================================== helpers

  tenantTimeZone(): string {
    return getMeta(this.db, 'time_zone') ?? 'UTC';
  }

  private async assertContact(contactId: string): Promise<void> {
    try {
      await crmCall(this.ports.crm, 'contacts.get', { id: contactId });
    } catch (error) {
      if (error instanceof CrmCallError) throw notFound('contact', contactId);
      throw error;
    }
  }

  private automationOrThrow(id: string): AutomationRow {
    const row = getAutomationRow(this.db, id);
    if (row === undefined) throw notFound('automation', id);
    return row;
  }

  private activeAutomations(): AutomationRow[] {
    this.activeCache ??= this.db.all<AutomationRow>(
      `SELECT * FROM eng_automations WHERE status = 'active' AND deleted_at IS NULL ORDER BY id`,
    );
    return this.activeCache;
  }

  private invalidate(): void {
    this.activeCache = null;
  }

  private version(id: string): VersionInfo {
    const info = this.versionOrNull(id);
    if (info === null) throw new CrmError('internal_error', `version ${id} missing`);
    return info;
  }

  private versionOrNull(id: string): VersionInfo | null {
    const cached = this.versions.get(id);
    if (cached !== undefined) return cached;
    const row = getVersionRow(this.db, id);
    if (row === undefined) return null;
    const info: VersionInfo = {
      id,
      compiled: compileGraph(parseGraph(row.graph)),
      settings: parseSettings(row.settings),
    };
    this.versions.set(id, info);
    return info;
  }

  private log(
    enrollment: Pick<EnrollmentRow, 'id' | 'automation_id' | 'contact_id'>,
    kind: LogKind,
    nodeId: string | null,
    stepId: string | null,
    message: string,
    data: Record<string, unknown>,
  ): void {
    this.db.run(
      `INSERT INTO eng_logs (id, automation_id, enrollment_id, contact_id, node_id, step_id, kind, message, data, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.ports.newId(),
      enrollment.automation_id,
      enrollment.id,
      enrollment.contact_id,
      nodeId,
      stepId,
      kind,
      message.slice(0, 1000),
      JSON.stringify(data),
      this.now(),
    );
  }

  private toAutomation(row: AutomationRow): Automation {
    const version =
      row.published_version_id === null
        ? undefined
        : getVersionRow(this.db, row.published_version_id);
    const active =
      first<{ n: number }>(
        this.db,
        `SELECT COUNT(*) AS n FROM eng_enrollments WHERE automation_id = ? AND status = 'active'`,
        row.id,
      )?.n ?? 0;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      folder_id: row.folder_id,
      settings: parseSettings(row.settings),
      draft_revision: row.draft_revision,
      has_unpublished_changes:
        version === undefined ||
        version.graph !== row.draft_graph ||
        version.settings !== row.settings,
      published_version:
        version === undefined
          ? null
          : { id: version.id, number: version.number, published_at: iso(version.published_at) },
      active_enrollments: active,
      created_by: row.created_by,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    };
  }

  private toVersionSummary(row: VersionRowLike): AutomationVersionSummary {
    return {
      id: row.id,
      automation_id: row.automation_id,
      number: row.number,
      settings: parseSettings(row.settings),
      published_by: row.published_by,
      published_at: iso(row.published_at),
    };
  }

  private toEnrollments(rows: readonly EnrollmentRow[]): Enrollment[] {
    if (rows.length === 0) return [];
    const tokens = chunks(rows.map((r) => r.id)).flatMap((ids) =>
      this.db.all<TokenRow & { due_at: number | null }>(
        `SELECT t.*, j.due_at FROM eng_tokens t LEFT JOIN eng_jobs j ON j.kind = 'token' AND j.ref = t.id
         WHERE t.enrollment_id IN (${placeholders(ids.length)}) AND t.status NOT IN ('done', 'cancelled')
         ORDER BY t.id`,
        ...ids,
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      automation_id: row.automation_id,
      version_id: row.version_id,
      contact_id: row.contact_id,
      status: row.status,
      source: row.source,
      entry_node_id: row.entry_node_id,
      started_at: iso(row.started_at),
      ended_at: iso(row.ended_at),
      positions: tokens
        .filter((t) => t.enrollment_id === row.id)
        .map((t) => {
          const node = this.versionOrNull(t.version_id)?.compiled.nodes.get(t.node_id);
          return {
            id: t.id,
            node_id: t.node_id,
            step_id: isSequence(node) ? (node.steps[t.step_index]?.id ?? null) : null,
            step_index: t.step_index,
            status: t.status,
            due_at: iso(t.due_at),
            attempts: t.attempts,
            last_error: t.last_error,
          };
        }),
    }));
  }
}

type VersionRowLike = NonNullable<ReturnType<typeof getVersionRow>>;

interface LogRow {
  id: string;
  kind: LogKind;
  node_id: string | null;
  step_id: string | null;
  message: string;
  data: string;
  at: number;
}

function toLogEntry(row: LogRow): ExecutionLogEntry {
  return {
    id: row.id,
    kind: row.kind,
    node_id: row.node_id,
    step_id: row.step_id,
    message: row.message,
    data: parseJson<Record<string, unknown>>(row.data, {}),
    at: new Date(row.at).toISOString(),
  };
}

/** Splits ids for `IN (…)` lists: Durable Object SQLite binds at most 100 parameters. */
function chunks<T>(items: readonly T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPermanent(error: unknown): boolean {
  if (error instanceof StepFailure) return error.permanent;
  return error instanceof CrmCallError;
}

export type { SqlValue };
export { EMAIL_PAUSE_RECHECK_MS };
