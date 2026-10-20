import type { EmailSendRequest, EmailSendSource } from '@amable/core';
import { EmailProviderError } from '@amable/core';
import { getBroadcastRow } from '../broadcast/store';
import type { MailSendContact } from '../crm/mail-reads';
import { MailError, normalizeEmail, parseJson, type MailDeps, type SendingState } from './context';
import { loadTemplateContent } from './library';
import { emitEmailEvent } from './outbox';
import {
  appendOpenPixel,
  compileContent,
  listUnsubscribeHeaders,
  openPixelUrl,
  recipientContext,
  renderSnippets,
  rewriteLinks,
  unsubscribeUrl,
  type CompiledContent,
} from './render';
import {
  fromAddress,
  getSetting,
  pruneCounters,
  releaseSlot,
  reserveSlot,
  sendGate,
  tenantTimeZone,
} from './settings';
import { getMessageRow, isSuppressed, suppress, suppressionReason, type MessageRow } from './suppressions';
import { MESSAGE_ID_ARG } from './webhooks';

/**
 * email-send queue processing for one tenant (runs inside its MailDb DO).
 *
 * Idempotency: one `mail_messages` row per `EmailSendRequest.id` (= message ×
 * recipient). A terminal row acks the duplicate; an in-flight row (lease) is
 * retried later. Retries: provider failures marked retryable are retried with
 * exponential backoff up to MAX_SEND_ATTEMPTS; deferrals (warm-up cap, rate
 * limit, paused broadcast, quota pause) don't consume attempts.
 */

export const MAX_SEND_ATTEMPTS = 5;
const LEASE_MS = 120_000;
const UNMARKETABLE = new Set(['unsubscribed', 'bounced', 'complained', 'non_marketable']);
/** Transactional sends ignore marketing opt-outs but never go to bounced / complaining addresses. */
const UNDELIVERABLE = new Set(['bounced', 'complained']);
const TRANSACTIONAL_BLOCKING_SUPPRESSIONS = new Set(['bounce', 'complaint', 'manual']);

export type SendOutcome =
  | { readonly id: string; readonly action: 'ack'; readonly status: MessageRow['status'] | 'duplicate' }
  | { readonly id: string; readonly action: 'retry'; readonly delaySeconds: number; readonly reason: string };

export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3600);
}

function sourceType(source: EmailSendSource): MessageRow['source_type'] {
  return source.type;
}

function ensureRow(deps: MailDeps, request: EmailSendRequest): MessageRow {
  const existing = deps.db.all<MessageRow>(
    `SELECT * FROM mail_messages WHERE request_id = ?`,
    request.id,
  )[0];
  if (existing !== undefined) return existing;
  const now = deps.now();
  const id = deps.newId();
  deps.db.run(
    `INSERT INTO mail_messages (id, request_id, contact_id, status, source_type, source, broadcast_id, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    id,
    request.id,
    request.contactId,
    sourceType(request.source),
    JSON.stringify(request.source),
    request.source.type === 'broadcast' ? request.source.broadcastId : null,
    now,
    now,
  );
  const row = getMessageRow(deps, id);
  if (row === undefined) throw new Error('mail message insert failed');
  return row;
}

function finish(
  deps: MailDeps,
  row: MessageRow,
  status: MessageRow['status'],
  reason: string | null,
  extra: { email?: string | null; subject?: string | null } = {},
): SendOutcome {
  deps.db.run(
    `UPDATE mail_messages SET status = ?, status_reason = ?, lease_until = NULL,
            email = COALESCE(?, email), subject = COALESCE(?, subject), updated_at = ? WHERE id = ?`,
    status,
    reason,
    extra.email ?? null,
    extra.subject ?? null,
    deps.now(),
    row.id,
  );
  return { id: row.request_id, action: 'ack', status };
}

interface ResolvedContent {
  readonly content: CompiledContent;
  readonly fromName: string | null;
  readonly replyTo: string | null;
}

/** Content of a send: inline body, stored template, or the broadcast it belongs to. */
export async function resolveContent(deps: MailDeps, request: EmailSendRequest): Promise<ResolvedContent> {
  const c = request.content;
  const footerAddress = getSetting(deps, 'physical_address');
  const timezone = tenantTimeZone(deps);
  if (c.body !== null) {
    return {
      content: await compileContent({
        body: c.body,
        subject: c.subject ?? '',
        footerAddress,
        transactional: request.source.type === 'transactional',
        timezone,
      }),
      fromName: c.fromName,
      replyTo: c.replyTo,
    };
  }
  if (c.templateId !== null) {
    const tpl = await loadTemplateContent(deps, c.templateId, c.subject);
    return { content: tpl.content, fromName: c.fromName ?? tpl.fromName, replyTo: c.replyTo ?? tpl.replyTo };
  }
  if (request.source.type === 'broadcast') {
    const broadcast = getBroadcastRow(deps, request.source.broadcastId);
    if (broadcast.body !== null) {
      return {
        content: await compileContent({
          body: parseJson<Record<string, unknown>>(broadcast.body, {}),
          subject: broadcast.subject,
          footerAddress,
          timezone,
        }),
        fromName: broadcast.from_name,
        replyTo: broadcast.reply_to,
      };
    }
    if (broadcast.template_id !== null) {
      const tpl = await loadTemplateContent(
        deps,
        broadcast.template_id,
        broadcast.subject === '' ? null : broadcast.subject,
      );
      return {
        content: tpl.content,
        fromName: broadcast.from_name ?? tpl.fromName,
        replyTo: broadcast.reply_to ?? tpl.replyTo,
      };
    }
  }
  throw new MailError('invalid_content', 422, 'send request without content');
}

function primaryEmail(data: MailSendContact): string | null {
  const email = data.contact.emails.find((e) => e.is_primary)?.email ?? data.contact.emails[0]?.email;
  return email === undefined ? null : normalizeEmail(email);
}

function recipientEmail(data: MailSendContact, request: EmailSendRequest): string | null {
  if (request.source.type === 'transactional' && request.toEmail !== undefined) {
    const wanted = normalizeEmail(request.toEmail);
    if (data.contact.emails.some((e) => normalizeEmail(e.email) === wanted)) return wanted;
  }
  return primaryEmail(data);
}

export async function processSends(
  deps: MailDeps,
  batch: readonly { request: EmailSendRequest; queueAttempts: number }[],
): Promise<SendOutcome[]> {
  if (batch.length === 0) return [];
  pruneCounters(deps);
  const sending: SendingState = await deps.sending();
  const contactIds = [...new Set(batch.map((b) => b.request.contactId))];
  const contacts = new Map(
    (await deps.crm.contactsForSend(contactIds)).map((c) => [c.contact.id, c] as const),
  );
  const ownerIds = [
    ...new Set(
      [...contacts.values()].map((c) => c.contact.owner_id).filter((id): id is string => id !== null),
    ),
  ];
  const owners = new Map((await deps.users.users(ownerIds)).map((u) => [u.id, u] as const));

  const outcomes: SendOutcome[] = [];
  for (const { request } of batch) {
    const outcome = await processOne(deps, request, sending, contacts, owners);
    outcomes.push(outcome);
    await reportUndelivered(deps, request, outcome);
  }
  return outcomes;
}

const UNDELIVERED = new Set<string>(['skipped', 'failed', 'blocked']);

async function reportUndelivered(
  deps: MailDeps,
  request: EmailSendRequest,
  outcome: SendOutcome,
): Promise<void> {
  const report = deps.crm.transactionalUndelivered;
  if (report === undefined || request.source.type !== 'transactional') return;
  if (outcome.action !== 'ack' || !UNDELIVERED.has(outcome.status)) return;
  const row = deps.db.all<MessageRow>(`SELECT * FROM mail_messages WHERE request_id = ?`, request.id)[0];
  try {
    await report({
      purpose: request.source.purpose,
      referenceId: request.source.referenceId,
      email: request.toEmail ?? row?.email ?? '',
      reason: row?.status_reason ?? outcome.status,
    });
  } catch (error) {
    console.error('[email] undelivered report failed', request.id, error);
  }
}

async function processOne(
  deps: MailDeps,
  request: EmailSendRequest,
  sending: SendingState,
  contacts: ReadonlyMap<string, MailSendContact>,
  owners: ReadonlyMap<string, { id: string; email: string; name: string | null }>,
): Promise<SendOutcome> {
  if (request.tenantId !== deps.tenantId) {
    return { id: request.id, action: 'ack', status: 'duplicate' };
  }
  let row = ensureRow(deps, request);
  if (row.status !== 'queued') return { id: request.id, action: 'ack', status: 'duplicate' };
  if (row.lease_until !== null && row.lease_until > deps.now()) {
    return { id: request.id, action: 'retry', delaySeconds: 60, reason: 'in_flight' };
  }
  if (request.notAfter !== null && Date.parse(request.notAfter) < deps.now()) {
    return finish(deps, row, 'skipped', 'expired');
  }

  const gate = sendGate(deps, sending);
  if (!gate.canSend) return finish(deps, row, 'blocked', gate.blockReason);

  if (request.source.type === 'broadcast') {
    const broadcast = getBroadcastRow(deps, request.source.broadcastId);
    if (broadcast.status === 'cancelled') return finish(deps, row, 'skipped', 'cancelled');
    if (broadcast.status === 'paused') {
      return { id: request.id, action: 'retry', delaySeconds: 300, reason: 'broadcast_paused' };
    }
  } else if (request.source.type !== 'transactional') {
    const decision = await deps.quota.check({
      tenantId: deps.tenantId,
      channel: 'email',
      count: 1,
      source: request.source,
    });
    if (decision.action === 'deny') return finish(deps, row, 'skipped', `quota_denied: ${decision.reason}`);
    if (decision.action === 'pause') {
      return {
        id: request.id,
        action: 'retry',
        delaySeconds: Math.ceil((decision.retryAfterMs ?? 600_000) / 1000),
        reason: 'quota_paused',
      };
    }
  }

  const planRate = (await deps.quota.ratePerMinute?.()) ?? null;

  const data = contacts.get(request.contactId);
  if (data === undefined) return finish(deps, row, 'skipped', 'contact_not_found');
  const email = recipientEmail(data, request);
  if (email === null) return finish(deps, row, 'skipped', 'no_email');
  const transactional = request.source.type === 'transactional';
  if ((transactional ? UNDELIVERABLE : UNMARKETABLE).has(data.contact.marketable_status)) {
    return finish(deps, row, 'skipped', `unmarketable: ${data.contact.marketable_status}`, { email });
  }
  if (transactional) {
    const reason = suppressionReason(deps, email);
    if (reason !== null && TRANSACTIONAL_BLOCKING_SUPPRESSIONS.has(reason)) {
      return finish(deps, row, 'skipped', 'suppressed', { email });
    }
  } else if (isSuppressed(deps, email)) {
    return finish(deps, row, 'skipped', 'suppressed', { email });
  }

  let resolved: ResolvedContent;
  let rendered: { subject: string; html: string; text: string };
  let links: { position: number; url: string }[];
  let headers: Record<string, string>;
  const secret = deps.tokenSecrets[0] ?? '';
  try {
    resolved = await resolveContent(deps, request);
    const owner = data.contact.owner_id === null ? null : (owners.get(data.contact.owner_id) ?? null);
    const unsub = await unsubscribeUrl(sending.trackingOrigin, secret, {
      tenantId: deps.tenantId,
      messageId: row.id,
      contactId: data.contact.id,
      email,
    });
    const context: Record<string, unknown> = {
      ...recipientContext(data, owner),
      unsubscribe_url: unsub,
    };
    context['snippets'] = await renderSnippets(deps, resolved.content.snippetKeys, context);
    const out = await resolved.content.renderer.render(context);
    const target = {
      origin: sending.trackingOrigin,
      secret,
      tenantId: deps.tenantId,
      messageId: row.id,
      contactId: data.contact.id,
    };
    const tracked = await rewriteLinks(out.html, target);
    rendered = {
      subject: out.subject,
      html: appendOpenPixel(tracked.html, await openPixelUrl(target)),
      text: out.text,
    };
    links = tracked.links;
    headers = transactional ? {} : listUnsubscribeHeaders(unsub);
  } catch (error) {
    if (error instanceof MailError && error.status !== 422 && error.status !== 404) throw error;
    return finish(deps, row, 'failed', `content_error: ${error instanceof Error ? error.message : 'invalid'}`, { email });
  }

  // From here to the provider call nothing awaits: check + lease + slot are atomic in the DO.
  row = getMessageRow(deps, row.id) ?? row;
  if (row.status !== 'queued' || (row.lease_until !== null && row.lease_until > deps.now())) {
    return { id: request.id, action: 'ack', status: 'duplicate' };
  }
  const slot = reserveSlot(deps, { ignoreWarmup: transactional, planRate });
  if (!slot.ok) {
    return {
      id: request.id,
      action: 'retry',
      delaySeconds: Math.min(slot.retryAfterSeconds, 43_200),
      reason: slot.reason,
    };
  }
  const reservedAt = deps.now();
  const attempt = row.attempts + 1;
  deps.db.run(
    `UPDATE mail_messages SET attempts = ?, lease_until = ?, email = ?, subject = ?, updated_at = ? WHERE id = ?`,
    attempt,
    reservedAt + LEASE_MS,
    email,
    rendered.subject,
    reservedAt,
    row.id,
  );

  try {
    const result = await deps.provider.sendEmail({
      from: fromAddress(deps, resolved.fromName),
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: resolved.replyTo ?? getSetting(deps, 'reply_to'),
      headers,
      providerTenantId: sending.providerTenantId,
      idempotencyKey: row.id,
      metadata: { account: deps.tenantId, [MESSAGE_ID_ARG]: row.id },
    });
    markSent(deps, { row, request, links, providerMessageId: result.messageId, reason: null });
    await deps.quota.recordUsage?.({ tenantId: deps.tenantId, channel: 'email', count: 1, source: request.source }).catch((e: unknown) => console.error('[email] usage metering failed', e));
    return { id: request.id, action: 'ack', status: 'sent' };
  } catch (error) {
    releaseSlot(deps, reservedAt);
    const code = error instanceof EmailProviderError ? error.code : null;
    if (code === 'suppressed') {
      suppress(deps, { email, reason: 'manual', source: 'provider', contactId: request.contactId });
      return finish(deps, row, 'skipped', 'suppressed_by_provider', { email });
    }
    if (code === 'outcome_unknown') {
      // The provider may have queued it: never resend. Delivery webhooks still match on unique args.
      markSent(deps, { row, request, links, providerMessageId: null, reason: 'provider_outcome_unknown' });
      await deps.quota.recordUsage?.({ tenantId: deps.tenantId, channel: 'email', count: 1, source: request.source }).catch((e: unknown) => console.error('[email] usage metering failed', e));
      return { id: request.id, action: 'ack', status: 'sent' };
    }
    const retryable = error instanceof EmailProviderError ? error.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    if (retryable && attempt < MAX_SEND_ATTEMPTS) {
      deps.db.run(
        `UPDATE mail_messages SET lease_until = NULL, status_reason = ?, updated_at = ? WHERE id = ?`,
        `retrying: ${message}`.slice(0, 300),
        deps.now(),
        row.id,
      );
      const hinted = error instanceof EmailProviderError ? error.retryAfterSeconds : null;
      return {
        id: request.id,
        action: 'retry',
        delaySeconds: Math.max(hinted ?? 0, backoffSeconds(attempt)),
        reason: 'provider_error',
      };
    }
    return finish(deps, row, 'failed', message.slice(0, 300), { email });
  }
}

function markSent(
  deps: MailDeps,
  input: {
    row: MessageRow;
    request: EmailSendRequest;
    links: readonly { position: number; url: string }[];
    providerMessageId: string | null;
    reason: string | null;
  },
): void {
  const { row, request, links } = input;
  const now = deps.now();
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE mail_messages SET status = 'sent', status_reason = ?, provider_message_id = ?,
              sent_at = ?, lease_until = NULL, updated_at = ? WHERE id = ?`,
      input.reason,
      input.providerMessageId,
      now,
      now,
      row.id,
    );
    for (const link of links) {
      deps.db.run(
        `INSERT OR REPLACE INTO mail_message_links (message_id, position, url) VALUES (?, ?, ?)`,
        row.id,
        link.position,
        link.url,
      );
    }
    emitEmailEvent(deps, 'email.sent', {
      messageId: row.id,
      contactId: request.contactId,
      source: request.source,
      providerMessageId: input.providerMessageId,
    });
  });
}
