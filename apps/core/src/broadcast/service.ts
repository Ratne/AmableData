import type {
  Broadcast,
  BroadcastEstimate,
  BroadcastSchedule,
  BroadcastSegment,
  BroadcastStats,
  BroadcastSummary,
  CreateBroadcastInput,
  ListBroadcastsQuery,
  Page,
  ScheduleBucket,
  UpdateBroadcastInput,
} from '@amable/api-types';
import type { EmailSendContent, EmailSendRequest, QuotaDecision } from '@amable/core';
import type { MailRecipientFacts } from '../crm/mail-reads';
import {
  chunked,
  decodeCursor,
  encodeCursor,
  isoOf,
  MailError,
  normalizeEmail,
  parseJson,
  toIso,
  type MailDeps,
  type TenantUser,
} from '../email/context';
import { loadTemplateContent } from '../email/library';
import {
  compileContent,
  recipientContext,
  renderSnippets,
  sampleContext,
  type CompiledContent,
} from '../email/render';
import { fromAddress, getSetting, sendGate, suspension, tenantTimeZone, warmupState, sentToday } from '../email/settings';
import { suppressedSet } from '../email/suppressions';
import { frozenStats, liveLinks, liveTotals } from './frozen';
import { getBroadcastRow, type BroadcastRow } from './store';
import { bucketize, scheduleRecipients } from './tz';

/**
 * Broadcasts: one email to a segment (saved search or tag filter), sent now,
 * at a time, or at the same local time in each contact's timezone, with
 * throttling, pause/resume/cancel, a pre-send estimate + QuotaGuard check and
 * per-link statistics. Recipients are materialized at schedule time; the
 * MailDb alarm enqueues due recipients on the email-send queue.
 */

const UNMARKETABLE = new Set(['unsubscribed', 'bounced', 'complained', 'non_marketable']);
const UNTHROTTLED_PER_TICK = 1_000;
const QUEUE_BATCH = 100;

// ------------------------------------------------------------------ shapes

type Progress = Broadcast['progress'];
const NO_PROGRESS: Progress = { recipients: 0, pending: 0, enqueued: 0, cancelled: 0 };

/** Recipient counters of the broadcasts in `ids` (one grouped query per chunk). */
function progressOf(deps: MailDeps, ids: readonly string[]): Map<string, Progress> {
  const progress = new Map<string, Progress>();
  for (const chunk of chunked([...ids])) {
    for (const row of deps.db.all<{
      broadcast_id: string;
      total: number;
      pending: number;
      enqueued: number;
      cancelled: number;
    }>(
      `SELECT broadcast_id,
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'enqueued' THEN 1 ELSE 0 END), 0) AS enqueued,
              COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
         FROM mail_broadcast_recipients WHERE broadcast_id IN (${chunk.map(() => '?').join(', ')})
        GROUP BY broadcast_id`,
      ...chunk,
    )) {
      progress.set(row.broadcast_id, {
        recipients: row.total,
        pending: row.pending,
        enqueued: row.enqueued,
        cancelled: row.cancelled,
      });
    }
  }
  for (const [id, frozen] of frozenStats(deps.db, ids)) progress.set(id, frozen.progress);
  return progress;
}

function progressOfOne(deps: MailDeps, id: string): Progress {
  return progressOf(deps, [id]).get(id) ?? NO_PROGRESS;
}

function toSummaryFields(row: BroadcastRow, progress: Progress): Omit<Broadcast, 'body'> {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    segment: parseJson<BroadcastSegment | null>(row.segment, null),
    template_id: row.template_id,
    subject: row.subject,
    from_name: row.from_name,
    reply_to: row.reply_to,
    throttle_per_hour: row.throttle_per_hour,
    schedule: parseJson<BroadcastSchedule | null>(row.schedule, null),
    progress,
    next_send_at: toIso(row.next_send_at),
    created_by: row.created_by,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
    started_at: toIso(row.started_at),
    completed_at: toIso(row.completed_at),
  };
}

function toBroadcast(deps: MailDeps, row: BroadcastRow): Broadcast {
  return {
    ...toSummaryFields(row, progressOfOne(deps, row.id)),
    body: row.body === null ? null : parseJson(row.body, { type: 'doc' as const }),
  };
}

export function getBroadcast(deps: MailDeps, input: { id: string }): Broadcast {
  return toBroadcast(deps, getBroadcastRow(deps, input.id));
}

export function listBroadcasts(deps: MailDeps, input: ListBroadcastsQuery): Page<BroadcastSummary> {
  const cursor = decodeCursor(input.cursor);
  const where = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];
  if (input.status !== undefined) {
    where.push('status = ?');
    params.push(input.status);
  }
  if (cursor !== null) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(Number(cursor[0]), Number(cursor[0]), String(cursor[1]));
  }
  const rows = deps.db.all<BroadcastRow>(
    `SELECT * FROM mail_broadcasts WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const ids = page.map((r) => r.id);
  const stats = new Map<string, { sent: number; opened: number; clicked: number }>();
  for (const chunk of chunked(ids)) {
    for (const s of deps.db.all<{ broadcast_id: string; sent: number; opened: number; clicked: number }>(
      `SELECT broadcast_id,
              COALESCE(SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent,
              COALESCE(SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS opened,
              COALESCE(SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS clicked
         FROM mail_messages WHERE broadcast_id IN (${chunk.map(() => '?').join(', ')})
        GROUP BY broadcast_id`,
      ...chunk,
    )) {
      stats.set(s.broadcast_id, { sent: s.sent, opened: s.opened, clicked: s.clicked });
    }
  }
  for (const [id, frozen] of frozenStats(deps.db, ids)) {
    stats.set(id, { sent: frozen.totals.sent, opened: frozen.totals.opened, clicked: frozen.totals.clicked });
  }
  const progress = progressOf(deps, ids);
  const last = page.at(-1);
  return {
    data: page.map((row) => ({
      ...toSummaryFields(row, progress.get(row.id) ?? NO_PROGRESS),
      stats: stats.get(row.id) ?? { sent: 0, opened: 0, clicked: 0 },
    })),
    next_cursor:
      rows.length > input.limit && last !== undefined ? encodeCursor([last.created_at, last.id]) : null,
  };
}

// --------------------------------------------------------------------- CRUD

function bodyJson(body: CreateBroadcastInput['body']): string | null {
  if (body === null || body === undefined) return null;
  const json = JSON.stringify(body);
  if (json.length > 512 * 1024) throw new MailError('payload_too_large', 413, 'email body exceeds 512 KB');
  return json;
}

export function createBroadcast(
  deps: MailDeps,
  input: CreateBroadcastInput & { createdBy: string | null },
): Broadcast {
  const id = deps.newId();
  const now = deps.now();
  deps.db.run(
    `INSERT INTO mail_broadcasts (id, name, status, segment, template_id, subject, body, from_name, reply_to,
                                  throttle_per_hour, created_by, created_at, updated_at)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.segment === undefined || input.segment === null ? null : JSON.stringify(input.segment),
    input.template_id ?? null,
    input.subject ?? '',
    bodyJson(input.body),
    input.from_name ?? null,
    input.reply_to ?? null,
    input.throttle_per_hour ?? null,
    input.createdBy,
    now,
    now,
  );
  return getBroadcast(deps, { id });
}

export function updateBroadcast(
  deps: MailDeps,
  input: { id: string; data: UpdateBroadcastInput },
): Broadcast {
  const row = getBroadcastRow(deps, input.id);
  if (row.status !== 'draft') {
    throw new MailError('conflict', 409, `only draft broadcasts can be edited (status: ${row.status})`);
  }
  const d = input.data;
  deps.db.run(
    `UPDATE mail_broadcasts SET name = ?, segment = ?, template_id = ?, subject = ?, body = ?, from_name = ?,
            reply_to = ?, throttle_per_hour = ?, updated_at = ? WHERE id = ?`,
    d.name ?? row.name,
    d.segment === undefined ? row.segment : d.segment === null ? null : JSON.stringify(d.segment),
    d.template_id === undefined ? row.template_id : d.template_id,
    d.subject ?? row.subject,
    d.body === undefined ? row.body : bodyJson(d.body),
    d.from_name === undefined ? row.from_name : d.from_name,
    d.reply_to === undefined ? row.reply_to : d.reply_to,
    d.throttle_per_hour === undefined ? row.throttle_per_hour : d.throttle_per_hour,
    deps.now(),
    input.id,
  );
  return getBroadcast(deps, { id: input.id });
}

export function deleteBroadcast(deps: MailDeps, input: { id: string }): { id: string; deleted: true } {
  const row = getBroadcastRow(deps, input.id);
  if (row.status === 'scheduled' || row.status === 'sending' || row.status === 'paused') {
    throw new MailError('conflict', 409, 'cancel the broadcast before deleting it');
  }
  deps.db.run(`UPDATE mail_broadcasts SET deleted_at = ? WHERE id = ?`, deps.now(), input.id);
  return { id: input.id, deleted: true };
}

// ---------------------------------------------------------------- content

export interface BroadcastContent {
  readonly subject: string;
  readonly fromName: string | null;
  readonly replyTo: string | null;
  readonly content: CompiledContent;
}

export async function broadcastContent(deps: MailDeps, row: BroadcastRow): Promise<BroadcastContent> {
  const footerAddress = getSetting(deps, 'physical_address');
  if (row.body !== null) {
    return {
      subject: row.subject,
      fromName: row.from_name,
      replyTo: row.reply_to,
      content: await compileContent({
        body: parseJson<Record<string, unknown>>(row.body, {}),
        subject: row.subject,
        footerAddress,
        timezone: tenantTimeZone(deps),
      }),
    };
  }
  if (row.template_id !== null) {
    const tpl = await loadTemplateContent(deps, row.template_id, row.subject === '' ? null : row.subject);
    return {
      subject: tpl.subject,
      fromName: row.from_name ?? tpl.fromName,
      replyTo: row.reply_to ?? tpl.replyTo,
      content: tpl.content,
    };
  }
  throw new MailError('no_content', 422, 'the broadcast has no content (template or body)');
}

// --------------------------------------------------------------- estimate

interface Audience {
  readonly segmentSize: number;
  readonly eligible: MailRecipientFacts[];
  readonly excluded: BroadcastEstimate['excluded'];
}

async function audience(deps: MailDeps, segment: BroadcastSegment): Promise<Audience> {
  const ids = await deps.crm.segmentMemberIds(segment);
  const candidates: MailRecipientFacts[] = [];
  const excluded = { no_email: 0, suppressed: 0, unmarketable: 0 };
  for (let i = 0; i < ids.length; i += 500) {
    for (const facts of await deps.crm.recipientFacts(ids.slice(i, i + 500))) {
      if (facts.email === null || facts.email === '') excluded.no_email += 1;
      else if (UNMARKETABLE.has(facts.marketable_status)) excluded.unmarketable += 1;
      else candidates.push(facts);
    }
  }
  const suppressed = suppressedSet(
    deps,
    candidates.map((c) => c.email ?? ''),
  );
  const eligible = candidates.filter((c) => !suppressed.has(normalizeEmail(c.email ?? '')));
  excluded.suppressed = candidates.length - eligible.length;
  return { segmentSize: ids.length, eligible, excluded };
}

function quotaBlock(decision: QuotaDecision): string | null {
  return decision.action === 'allow' ? null : decision.action === 'deny' ? 'quota_denied' : 'quota_paused';
}

interface Readiness {
  readonly estimate: BroadcastEstimate;
  readonly audience: Audience | null;
}

async function readiness(deps: MailDeps, row: BroadcastRow): Promise<Readiness> {
  const sending = await deps.sending();
  const gate = sendGate(deps, sending);
  const segment = parseJson<BroadcastSegment | null>(row.segment, null);
  const aud = segment === null ? null : await audience(deps, segment);
  const eligible = aud?.eligible.length ?? 0;
  const decision: QuotaDecision =
    eligible === 0
      ? { action: 'allow' }
      : await deps.quota.check({
          tenantId: deps.tenantId,
          channel: 'email',
          count: eligible,
          source: { type: 'broadcast', broadcastId: row.id },
        });
  let contentError: string | null = null;
  try {
    await broadcastContent(deps, row);
  } catch (error) {
    contentError = error instanceof MailError ? error.code : 'invalid_content';
  }
  const warmup = warmupState(deps);
  const blockReason =
    gate.blockReason ??
    (getSetting(deps, 'physical_address') === null ? 'missing_physical_address' : null) ??
    contentError ??
    (segment === null ? 'no_segment' : null) ??
    (eligible === 0 ? 'empty_segment' : null) ??
    quotaBlock(decision);
  return {
    audience: aud,
    estimate: {
      segment_size: aud?.segmentSize ?? 0,
      eligible,
      excluded: aud?.excluded ?? { no_email: 0, suppressed: 0, unmarketable: 0 },
      warmup: {
        daily_cap: warmup.dailyCap,
        remaining_today: warmup.dailyCap === null ? null : Math.max(warmup.dailyCap - sentToday(deps), 0),
      },
      quota: {
        action: decision.action,
        reason: decision.action === 'allow' ? null : decision.reason,
      },
      can_send: blockReason === null,
      block_reason: blockReason,
    },
  };
}

export async function estimateBroadcast(deps: MailDeps, input: { id: string }): Promise<BroadcastEstimate> {
  return (await readiness(deps, getBroadcastRow(deps, input.id))).estimate;
}

// --------------------------------------------------------------- schedule

const BLOCK_MESSAGES: Record<string, string> = {
  domain_not_verified: 'Sending is blocked until the tenant sending domain is verified.',
  from_domain_not_verified: 'The sender address is not on a verified sending domain.',
  missing_from_email: 'Set a sender address in the email settings first.',
  sending_suspended: 'Sending is suspended for this tenant (bounce or complaint rate too high).',
  missing_physical_address: 'Broadcasts need the sender physical address in the email settings.',
  no_segment: 'Choose a segment first.',
  empty_segment: 'The segment has no contact that can receive this email.',
  no_content: 'The broadcast has no content.',
  invalid_content: 'The email content does not compile.',
};

export async function scheduleBroadcast(
  deps: MailDeps,
  input: { id: string; schedule: BroadcastSchedule },
): Promise<{ broadcast: Broadcast; buckets: ScheduleBucket[] }> {
  const row = getBroadcastRow(deps, input.id);
  if (row.status !== 'draft') {
    throw new MailError('conflict', 409, `only draft broadcasts can be scheduled (status: ${row.status})`);
  }
  const ready = await readiness(deps, row);
  const block = ready.estimate.block_reason;
  if (block !== null || ready.audience === null) {
    const reason = block ?? 'no_segment';
    if (reason === 'quota_denied' || reason === 'quota_paused') {
      throw new MailError(reason, 402, `Sending quota check failed: ${ready.estimate.quota.reason ?? reason}`, {
        quota: ready.estimate.quota,
        eligible: ready.estimate.eligible,
      });
    }
    throw new MailError(reason, reason === 'invalid_content' || reason === 'no_content' ? 422 : 409, BLOCK_MESSAGES[reason] ?? reason);
  }
  const now = deps.now();
  const scheduled = scheduleRecipients(ready.audience.eligible, input.schedule, tenantTimeZone(deps), now);
  const nextAt = scheduled.reduce((min, r) => Math.min(min, r.sendAt), Number.POSITIVE_INFINITY);
  deps.db.transaction(() => {
    for (const r of scheduled) {
      deps.db.run(
        `INSERT OR IGNORE INTO mail_broadcast_recipients (broadcast_id, contact_id, time_zone, send_at, status, request_id)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        row.id,
        r.contactId,
        r.timeZone,
        r.sendAt,
        `bc:${row.id}:${r.contactId}`,
      );
    }
    deps.db.run(
      `UPDATE mail_broadcasts SET status = 'scheduled', schedule = ?, next_send_at = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify(input.schedule),
      nextAt,
      now,
      row.id,
    );
  });
  await deps.scheduleAlarm(nextAt);
  return { broadcast: getBroadcast(deps, { id: row.id }), buckets: bucketize(scheduled) };
}

export async function pauseBroadcast(deps: MailDeps, input: { id: string }): Promise<Broadcast> {
  const row = getBroadcastRow(deps, input.id);
  if (row.status !== 'scheduled' && row.status !== 'sending') {
    throw new MailError('conflict', 409, `cannot pause a ${row.status} broadcast`);
  }
  deps.db.run(`UPDATE mail_broadcasts SET status = 'paused', updated_at = ? WHERE id = ?`, deps.now(), row.id);
  return getBroadcast(deps, { id: row.id });
}

export async function resumeBroadcast(deps: MailDeps, input: { id: string }): Promise<Broadcast> {
  const row = getBroadcastRow(deps, input.id);
  if (row.status !== 'paused') throw new MailError('conflict', 409, `cannot resume a ${row.status} broadcast`);
  const gate = sendGate(deps, await deps.sending());
  if (!gate.canSend) {
    throw new MailError(gate.blockReason ?? 'blocked', 409, BLOCK_MESSAGES[gate.blockReason ?? ''] ?? 'sending is blocked');
  }
  const now = deps.now();
  const next = deps.db.all<{ at: number | null }>(
    `SELECT MIN(send_at) AS at FROM mail_broadcast_recipients WHERE broadcast_id = ? AND status = 'pending'`,
    row.id,
  )[0]?.at;
  const nextAt = next === null || next === undefined ? now : Math.max(next, now);
  deps.db.run(
    `UPDATE mail_broadcasts SET status = ?, next_send_at = ?, updated_at = ? WHERE id = ?`,
    row.started_at === null ? 'scheduled' : 'sending',
    nextAt,
    now,
    row.id,
  );
  await deps.scheduleAlarm(nextAt);
  return getBroadcast(deps, { id: row.id });
}

export function cancelBroadcast(deps: MailDeps, input: { id: string }): Broadcast {
  const row = getBroadcastRow(deps, input.id);
  if (row.status === 'sent' || row.status === 'cancelled') {
    throw new MailError('conflict', 409, `cannot cancel a ${row.status} broadcast`);
  }
  const now = deps.now();
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE mail_broadcast_recipients SET status = 'cancelled' WHERE broadcast_id = ? AND status = 'pending'`,
      row.id,
    );
    deps.db.run(
      `UPDATE mail_broadcasts SET status = 'cancelled', next_send_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      row.id,
    );
  });
  return getBroadcast(deps, { id: row.id });
}

// ------------------------------------------------------------- scheduler

const EMPTY_CONTENT: EmailSendContent = {
  templateId: null,
  subject: null,
  preheader: null,
  body: null,
  fromName: null,
  replyTo: null,
};

/**
 * Alarm handler: enqueues due recipients of every running broadcast, honoring
 * the throttle (per-minute share of `throttle_per_hour`), and re-arms the
 * alarm for the next due time. A broadcast becomes `sent` once every recipient
 * is on the queue (delivery is tracked per message).
 */
export async function broadcastTick(deps: MailDeps): Promise<{ enqueued: number; nextAt: number | null }> {
  const now = deps.now();
  let enqueued = 0;
  if (!suspension(deps).suspended) {
    const due = deps.db.all<BroadcastRow>(
      `SELECT * FROM mail_broadcasts WHERE status IN ('scheduled', 'sending') AND deleted_at IS NULL
          AND next_send_at IS NOT NULL AND next_send_at <= ?`,
      now,
    );
    for (const b of due) enqueued += await tickOne(deps, b, now);
  }
  const next = deps.db.all<{ at: number | null }>(
    `SELECT MIN(next_send_at) AS at FROM mail_broadcasts
      WHERE status IN ('scheduled', 'sending') AND deleted_at IS NULL`,
  )[0]?.at;
  const nextAt = next === null || next === undefined ? null : next;
  if (nextAt !== null) await deps.scheduleAlarm(nextAt);
  return { enqueued, nextAt };
}

async function tickOne(deps: MailDeps, b: BroadcastRow, now: number): Promise<number> {
  const allowance =
    b.throttle_per_hour === null ? UNTHROTTLED_PER_TICK : Math.max(1, Math.floor(b.throttle_per_hour / 60));
  const due = deps.db.all<{ contact_id: string; request_id: string }>(
    `SELECT contact_id, request_id FROM mail_broadcast_recipients
      WHERE broadcast_id = ? AND status = 'pending' AND send_at <= ?
      ORDER BY send_at, contact_id LIMIT ?`,
    b.id,
    now,
    allowance,
  );
  const requestedAt = isoOf(now);
  for (let i = 0; i < due.length; i += QUEUE_BATCH) {
    const chunk = due.slice(i, i + QUEUE_BATCH);
    const requests: EmailSendRequest[] = chunk.map((r) => ({
      kind: 'email.send',
      version: 1,
      id: r.request_id,
      tenantId: deps.tenantId,
      contactId: r.contact_id,
      content: EMPTY_CONTENT,
      source: { type: 'broadcast', broadcastId: b.id },
      requestedAt,
      notAfter: null,
    }));
    await deps.queue.send(requests);
    deps.db.transaction(() => {
      for (const r of chunk) {
        deps.db.run(
          `UPDATE mail_broadcast_recipients SET status = 'enqueued' WHERE broadcast_id = ? AND contact_id = ?`,
          b.id,
          r.contact_id,
        );
      }
    });
  }
  const rest = deps.db.all<{ pending: number; next: number | null }>(
    `SELECT COUNT(*) AS pending, MIN(send_at) AS next FROM mail_broadcast_recipients
      WHERE broadcast_id = ? AND status = 'pending'`,
    b.id,
  )[0] ?? { pending: 0, next: null };
  const current = getBroadcastRow(deps, b.id);
  if (current.status !== 'scheduled' && current.status !== 'sending') return due.length;
  if (rest.pending === 0) {
    deps.db.run(
      `UPDATE mail_broadcasts SET status = 'sent', next_send_at = NULL, started_at = COALESCE(started_at, ?),
              completed_at = ?, updated_at = ? WHERE id = ?`,
      now,
      now,
      now,
      b.id,
    );
  } else {
    const throttledNext = b.throttle_per_hour === null ? now + 1_000 : now + 60_000;
    const nextAt = Math.max(rest.next ?? now, due.length > 0 ? throttledNext : now);
    deps.db.run(
      `UPDATE mail_broadcasts SET status = ?, next_send_at = ?, started_at = CASE WHEN ? > 0 THEN COALESCE(started_at, ?) ELSE started_at END,
              updated_at = ? WHERE id = ?`,
      due.length > 0 || current.started_at !== null ? 'sending' : 'scheduled',
      nextAt,
      due.length,
      now,
      now,
      b.id,
    );
  }
  return due.length;
}

// ------------------------------------------------------------------ stats

export function broadcastStats(deps: MailDeps, input: { id: string }): BroadcastStats {
  const row = getBroadcastRow(deps, input.id);
  const frozen = frozenStats(deps.db, [row.id]).get(row.id);
  const progress = frozen?.progress ?? progressOfOne(deps, row.id);
  const t = frozen?.totals ?? { recipients: progress.recipients, ...liveTotals(deps.db, row.id) };
  const links = frozen?.links ?? liveLinks(deps.db, row.id);
  const rate = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);
  return {
    broadcast_id: row.id,
    status: row.status,
    archived: frozen !== undefined,
    messages_archived:
      frozen !== undefined &&
      deps.db.all(`SELECT 1 FROM archive_catalog WHERE stream = 'mail_messages' AND partition = ? LIMIT 1`, row.id).length > 0,
    totals: {
      recipients: t.recipients,
      sent: t.sent,
      delivered: t.delivered,
      opened: t.opened,
      clicked: t.clicked,
      bounced: t.bounced,
      complained: t.complained,
      unsubscribed: t.unsubscribed,
      failed: t.failed,
      skipped: t.skipped,
    },
    rates: {
      delivery: rate(t.delivered, t.sent),
      open: rate(t.opened, t.sent),
      click: rate(t.clicked, t.sent),
      bounce: rate(t.bounced, t.sent),
      unsubscribe: rate(t.unsubscribed, t.sent),
    },
    links,
    progress,
  };
}

// --------------------------------------------------------------- test send

/**
 * Sends the content to tenant members only (never to contacts), with a
 * `[Test]` subject, no tracking and a non-functional unsubscribe link.
 * Allowed before the sending domain is verified (plan rule), not while suspended.
 */
export async function testSend(
  deps: MailDeps,
  input: {
    content: BroadcastContent;
    userIds: readonly string[];
    contactId: string | null;
  },
): Promise<{ sent: { email: string; message_id: string }[] }> {
  if (suspension(deps).suspended) {
    throw new MailError('sending_suspended', 409, BLOCK_MESSAGES['sending_suspended'] ?? 'suspended');
  }
  const unique = [...new Set(input.userIds)];
  const members = await deps.users.members(unique);
  if (members.length !== unique.length) {
    throw new MailError('not_tenant_member', 403, 'test emails can only go to members of this tenant');
  }
  const sending = await deps.sending();
  let contactCtx: Record<string, unknown> | null = null;
  if (input.contactId !== null) {
    const [data] = await deps.crm.contactsForSend([input.contactId]);
    if (data === undefined) throw new MailError('not_found', 404, `contact ${input.contactId} not found`);
    const owners = data.contact.owner_id === null ? [] : await deps.users.users([data.contact.owner_id]);
    contactCtx = recipientContext(data, owners[0] ?? null);
  }
  const sent: { email: string; message_id: string }[] = [];
  for (const member of members) {
    sent.push(await sendTestTo(deps, input.content, member, contactCtx, sending.trackingOrigin, sending.providerTenantId));
  }
  return { sent };
}

async function sendTestTo(
  deps: MailDeps,
  content: BroadcastContent,
  member: TenantUser,
  contactCtx: Record<string, unknown> | null,
  origin: string,
  providerTenantId: string | null,
): Promise<{ email: string; message_id: string }> {
  const context: Record<string, unknown> = {
    ...(contactCtx ?? sampleContext(member)),
    unsubscribe_url: `${origin.replace(/\/+$/, '')}/unsub/test`,
  };
  context['snippets'] = await renderSnippets(deps, content.content.snippetKeys, context);
  const rendered = await content.content.renderer.render(context);
  const subject = `[Test] ${rendered.subject}`;
  const id = deps.newId();
  const result = await deps.provider.sendEmail({
    from: fromAddress(deps, content.fromName),
    to: member.email,
    subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: content.replyTo ?? getSetting(deps, 'reply_to'),
    providerTenantId,
    idempotencyKey: id,
    metadata: { tenant_id: deps.tenantId, message_id: id, test: 'true' },
  });
  const now = deps.now();
  deps.db.run(
    `INSERT INTO mail_messages (id, request_id, contact_id, email, subject, status, source_type, provider_message_id,
                                attempts, sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sent', 'test', ?, 1, ?, ?, ?)`,
    id,
    `test:${id}`,
    `user:${member.id}`,
    normalizeEmail(member.email),
    subject,
    result.messageId,
    now,
    now,
    now,
  );
  return { email: member.email, message_id: id };
}
