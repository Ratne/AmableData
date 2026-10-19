import {
  ResponseTooLargeError,
  SsrfBlockedError,
  WEBHOOK_SIGNATURE_HEADER,
  renderSandboxed,
  safeFetch,
  signWebhook,
} from '@amable/auth/security';
import {
  updateContactSchema,
  type AutomationSettings,
  type Contact,
  type SequenceNode,
  type Step,
  type StepOf,
  type UpdateContactInput,
  type UserRef,
} from '@amable/api-types';
import type { EmailSendRequest, EmailSendSource } from '@amable/core';
import type { AppActionContact } from '../apps/actions';
import type { CrmOpInput, CrmOpName, CrmOpOutput } from '../crm/ops';
import { CrmCallError, crmCall, type EnginePorts } from './ports';
import {
  durationMs,
  nextWindowOpening,
  nextYearly,
  parseDate,
  parseTimeOfDay,
  zonedToUtc,
} from './time';

/** Per-step persisted state (timers remember their deadline, email steps their pause). */
export interface StepState {
  until?: number;
  paused?: boolean;
}

export type StepOutcome =
  | { kind: 'done'; message: string; result?: Record<string, unknown> }
  | { kind: 'skip'; message: string }
  | { kind: 'wait'; until: number; message: string }
  | { kind: 'pause'; until: number; message: string }
  /** This position stops here (no successors). */
  | { kind: 'stop'; message: string }
  /** The whole enrollment ends (`end` step). */
  | { kind: 'end'; message: string };

/** A failed step. Permanent failures are not retried. */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

/** Engine services available to steps. */
export interface StepHost {
  readonly ports: EnginePorts;
  signingSecret(automationId: string): Promise<string>;
  /** Next index (0..size-1) of a persistent round-robin counter. */
  nextRoundRobin(key: string, size: number): number;
  addToSequence(contactId: string, automationId: string, nodeId: string): string;
  removeFromSequence(
    contactId: string,
    automationId: string,
    nodeId: string | undefined,
    selfTokenId: string,
  ): string;
}

export interface StepContext {
  readonly host: StepHost;
  readonly tokenId: string;
  readonly enrollmentId: string;
  readonly automationId: string;
  readonly versionId: string;
  readonly contactId: string;
  readonly settings: AutomationSettings;
  readonly node: SequenceNode;
  readonly step: Step;
  /** Idempotency key of this step execution (token + step index). */
  readonly key: string;
  readonly state: StepState;
  readonly now: number;
  contact(): Promise<Contact>;
  timeZone(explicit?: string): Promise<string>;
}

export const EMAIL_PAUSE_RECHECK_MS = 15 * 60_000;
const HTTP_FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  WEBHOOK_SIGNATURE_HEADER.toLowerCase(),
  'idempotency-key',
]);

/** Steps whose only side effect is waiting. */
export const TIMER_STEPS: ReadonlySet<Step['type']> = new Set([
  'delay',
  'wait_until',
  'field_timer',
]);

/** Wraps CRM failures into retry semantics: domain errors are permanent, transport errors transient. */
async function crm<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CrmCallError) throw new StepFailure(error.message, true);
    throw new StepFailure(error instanceof Error ? error.message : String(error), false);
  }
}

/**
 * Runs a non-idempotent CRM write at most once per step execution: the TenantDb
 * records the key (`eng:<token>:<step>`) in the same transaction as the write,
 * so a retry after a lost response replays the stored result.
 */
async function once<K extends CrmOpName>(
  ctx: StepContext,
  op: K,
  input: CrmOpInput<K>,
  /** Distinguishes several writes of the same step (one per subscription, …). */
  part?: string,
): Promise<CrmOpOutput<K>> {
  const key = part === undefined ? `eng:${ctx.key}` : `eng:${ctx.key}:${part}`;
  const result = await crm(() =>
    crmCall(ctx.host.ports.crm, 'automation.once', { key, op, input }),
  );
  return result.value as CrmOpOutput<K>;
}

async function resolveUser(ctx: StepContext, ref: UserRef | undefined): Promise<string | null> {
  if (ref === undefined) return null;
  if (ref === 'contact_owner') return (await ctx.contact()).owner_id;
  return ref.user_id;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ------------------------------------------------------------------ timers

function waitOrDone(ctx: StepContext, until: number, message: string): StepOutcome {
  return until <= ctx.now ? { kind: 'done', message } : { kind: 'wait', until, message };
}

async function runDelay(ctx: StepContext, step: StepOf<'delay'>): Promise<StepOutcome> {
  if (ctx.state.until !== undefined) return waitOrDone(ctx, ctx.state.until, 'delay elapsed');
  let until = ctx.now + durationMs(step.duration);
  if (step.window !== undefined) {
    until = nextWindowOpening(until, step.window, await ctx.timeZone());
  }
  return waitOrDone(ctx, until, 'delay elapsed');
}

async function runWaitUntil(ctx: StepContext, step: StepOf<'wait_until'>): Promise<StepOutcome> {
  if (ctx.state.until !== undefined) return waitOrDone(ctx, ctx.state.until, 'date reached');
  const date = parseDate(step.date);
  if (date === null) throw new StepFailure('invalid date', true);
  const [h, m] = parseTimeOfDay(step.time);
  const until = zonedToUtc(
    date.year,
    date.month,
    date.day,
    h,
    m,
    await ctx.timeZone(step.time_zone),
  );
  return waitOrDone(ctx, until, until <= ctx.now ? 'date already past' : 'date reached');
}

function fieldValue(contact: Contact, field: string): string | null {
  if (field === 'birthday') return contact.birthday;
  if (field === 'anniversary') return contact.anniversary;
  if (field === 'created_at') return contact.created_at;
  const value = contact.custom_fields[field.slice('custom.'.length)];
  return typeof value === 'string' && value !== '' ? value : null;
}

async function runFieldTimer(ctx: StepContext, step: StepOf<'field_timer'>): Promise<StepOutcome> {
  if (ctx.state.until !== undefined) return waitOrDone(ctx, ctx.state.until, 'field date reached');
  const raw = fieldValue(await ctx.contact(), step.field);
  const date = raw === null ? null : parseDate(raw);
  if (date === null) {
    return step.if_missing === 'stop'
      ? { kind: 'stop', message: `${step.field} is empty: contact stopped` }
      : { kind: 'skip', message: `${step.field} is empty: timer skipped` };
  }
  const zone = await ctx.timeZone(step.time_zone);
  const [h, m] = parseTimeOfDay(step.time);
  const offset =
    step.offset === undefined
      ? 0
      : (step.offset.direction === 'before' ? -1 : 1) * durationMs(step.offset);
  const until =
    step.yearly === true
      ? nextYearly(date, h, m, offset, ctx.now, zone)
      : zonedToUtc(date.year, date.month, date.day, h, m, zone) + offset;
  return waitOrDone(ctx, until, 'field date reached');
}

// ------------------------------------------------------------------- email

async function runSendEmail(ctx: StepContext, step: StepOf<'send_email'>): Promise<StepOutcome> {
  const window = step.window ?? ctx.settings.send_window;
  if (window !== undefined) {
    const opening = nextWindowOpening(ctx.now, window, await ctx.timeZone());
    if (opening > ctx.now)
      return { kind: 'wait', until: opening, message: 'waiting for the send window' };
  }
  const { ports } = ctx.host;
  const source: EmailSendSource = {
    type: 'automation',
    automationId: ctx.automationId,
    versionId: ctx.versionId,
    nodeId: ctx.node.id,
    stepId: step.id,
    enrollmentId: ctx.enrollmentId,
  };
  const decision = await ports.quota.check({
    tenantId: ports.tenantId,
    channel: 'email',
    count: 1,
    source,
  });
  if (decision.action === 'deny')
    return { kind: 'skip', message: `email not sent: ${decision.reason}` };
  if (decision.action === 'pause') {
    return {
      kind: 'pause',
      until: ctx.now + (decision.retryAfterMs ?? EMAIL_PAUSE_RECHECK_MS),
      message: `email paused: ${decision.reason}`,
    };
  }
  const request: EmailSendRequest = {
    kind: 'email.send',
    version: 1,
    id: `${ports.tenantId}:${ctx.key}`,
    tenantId: ports.tenantId,
    contactId: ctx.contactId,
    content: {
      templateId: step.template_id ?? null,
      subject: step.subject ?? null,
      preheader: step.preheader ?? null,
      body: step.body ?? null,
      fromName: step.from_name ?? null,
      replyTo: step.reply_to ?? null,
    },
    source,
    requestedAt: iso(ctx.now),
    notAfter: iso(ctx.now + 24 * 60 * 60_000),
  };
  try {
    await ports.email.send(request);
  } catch (error) {
    throw new StepFailure(
      `email queue: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  return {
    kind: 'done',
    message: ctx.state.paused === true ? 'email queued after pause' : 'email queued',
    result: { email_request_id: request.id },
  };
}

// --------------------------------------------------------------------- CRM

async function runSetField(ctx: StepContext, step: StepOf<'set_field'>): Promise<StepOutcome> {
  let value = step.value;
  const isCustom = step.field.startsWith('custom.');
  const key = step.field.slice('custom.'.length);
  if (step.mode === 'increment') {
    const contact = await ctx.contact();
    const current = isCustom ? contact.custom_fields[key] : contact.score_value;
    const base = typeof current === 'number' ? current : Number(current ?? 0);
    value = (Number.isFinite(base) ? base : 0) + (typeof value === 'number' ? value : 0);
  }
  const data: Record<string, unknown> = isCustom
    ? { custom_fields: { [key]: value } }
    : { [step.field]: value };
  const parsed = updateContactSchema.safeParse(data);
  if (!parsed.success) {
    throw new StepFailure(
      `invalid value for ${step.field}: ${parsed.error.issues[0]?.message ?? ''}`,
      true,
    );
  }
  const update: UpdateContactInput = parsed.data;
  await crm(() =>
    crmCall(ctx.host.ports.crm, 'contacts.update', { id: ctx.contactId, data: update }),
  );
  return { kind: 'done', message: `${step.field} updated`, result: { value } };
}

async function runMoveStage(
  ctx: StepContext,
  step: StepOf<'move_opportunity_stage'>,
): Promise<StepOutcome> {
  const port = ctx.host.ports.crm;
  const page = await crm(() =>
    crmCall(port, 'opportunities.list', {
      limit: 200,
      contact_id: ctx.contactId,
      pipeline_id: step.pipeline_id,
      status: 'open',
    }),
  );
  const latest = [...page.data].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (latest === undefined) {
    if (step.if_missing !== 'create')
      return { kind: 'skip', message: 'no open opportunity in the pipeline' };
    const opp = await once(ctx, 'opportunities.create', {
      title: 'Opportunity',
      pipeline_id: step.pipeline_id,
      stage_id: step.stage_id,
      contact_id: ctx.contactId,
    });
    return {
      kind: 'done',
      message: 'opportunity created in stage',
      result: { opportunity_id: opp.id },
    };
  }
  if (latest.stage_id === step.stage_id) return { kind: 'skip', message: 'already in stage' };
  await crm(() =>
    crmCall(port, 'opportunities.update', { id: latest.id, data: { stage_id: step.stage_id } }),
  );
  return { kind: 'done', message: 'opportunity moved', result: { opportunity_id: latest.id } };
}

/** Finalized order (`unpaid`, invoice issued, `order.created`) through the e-commerce module. */
async function runCreateOrder(
  ctx: StepContext,
  step: StepOf<'create_order'>,
): Promise<StepOutcome> {
  const order = await once(ctx, 'orders.create', {
    contact_id: ctx.contactId,
    items: step.items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
      ...(item.unit_price_minor === undefined ? {} : { unit_price_minor: item.unit_price_minor }),
    })),
    ...(step.currency === undefined ? {} : { currency: step.currency }),
    notes: `Created by automation ${ctx.automationId} (step ${step.id})`,
  });
  return {
    kind: 'done',
    message: `order ${order.number} created`,
    result: { order_id: order.id, total_minor: order.total_minor, currency: order.currency },
  };
}

/** Signature request through the e-signature module; the contact signs as `party_id`. */
async function runSendSignatureRequest(
  ctx: StepContext,
  step: StepOf<'send_signature_request'>,
): Promise<StepOutcome> {
  const request = await once(ctx, 'esign.requests.createFromAutomation', {
    template_id: step.template_id,
    contact_id: ctx.contactId,
    party_id: step.party_id,
    others: step.others,
    message: step.message,
    origin_ref: `eng:${ctx.key}`,
  });
  return {
    kind: 'done',
    message: `signature request ${request.id} sent`,
    result: { esign_request_id: request.id },
  };
}

const CANCELLABLE_SUBSCRIPTION = new Set(['trialing', 'active', 'past_due', 'paused']);

/** Cancels the contact's live subscriptions (optionally only for some products). */
async function runCancelSubscription(
  ctx: StepContext,
  step: StepOf<'cancel_subscription'>,
): Promise<StepOutcome> {
  const port = ctx.host.ports.crm;
  const page = await crm(() =>
    crmCall(port, 'subscriptions.list', { limit: 200, contact_id: ctx.contactId }),
  );
  const products = step.product_ids === undefined ? null : new Set(step.product_ids);
  const targets = page.data.filter(
    (sub) =>
      CANCELLABLE_SUBSCRIPTION.has(sub.status) &&
      (products === null || products.size === 0 || products.has(sub.product_id)),
  );
  if (targets.length === 0) return { kind: 'skip', message: 'no subscription to cancel' };
  const atPeriodEnd = step.at_period_end ?? true;
  const cancelled: string[] = [];
  for (const sub of targets) {
    await once(
      ctx,
      'subscriptions.cancel',
      { id: sub.id, data: { at_period_end: atPeriodEnd, reason: 'Cancelled by automation' } },
      sub.id,
    );
    cancelled.push(sub.id);
  }
  return {
    kind: 'done',
    message: `${cancelled.length} subscription(s) ${atPeriodEnd ? 'set to cancel at period end' : 'cancelled'}`,
    result: { subscription_ids: cancelled },
  };
}

// -------------------------------------------------------------------- HTTP

async function runHttp(ctx: StepContext, step: StepOf<'http_request'>): Promise<StepOutcome> {
  const { ports } = ctx.host;
  const payloadKind = step.payload ?? (step.method === 'GET' ? 'none' : 'contact');
  const body =
    payloadKind === 'none'
      ? undefined
      : JSON.stringify({
          event: 'automation.http_request',
          id: ctx.key,
          automation_id: ctx.automationId,
          version_id: ctx.versionId,
          node_id: ctx.node.id,
          step_id: step.id,
          enrollment_id: ctx.enrollmentId,
          contact_id: ctx.contactId,
          ...(payloadKind === 'contact' ? { contact: await ctx.contact() } : {}),
          sent_at: iso(ctx.now),
        });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(step.headers ?? {})) {
    if (!HTTP_FORBIDDEN_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  headers['user-agent'] = 'amable-automation/1';
  headers['idempotency-key'] = ctx.key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (step.sign !== false) {
    headers[WEBHOOK_SIGNATURE_HEADER] = await signWebhook(
      await ctx.host.signingSecret(ctx.automationId),
      body ?? '',
      ctx.now,
    );
  }
  let status: number;
  try {
    const response = await safeFetch(
      step.url,
      { method: step.method, headers, ...(body === undefined ? {} : { body }) },
      { fetchFn: ports.fetch, timeoutMs: step.timeout_ms ?? 10_000, maxBytes: 64 * 1024 },
    );
    status = response.status;
  } catch (error) {
    if (error instanceof SsrfBlockedError)
      throw new StepFailure(`blocked URL: ${error.message}`, true);
    if (error instanceof ResponseTooLargeError) throw new StepFailure('response too large', true);
    throw new StepFailure(
      `request failed: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }
  if (status >= 200 && status < 400)
    return { kind: 'done', message: `HTTP ${status}`, result: { status } };
  const transient = status >= 500 || status === 408 || status === 425 || status === 429;
  throw new StepFailure(`HTTP ${status}`, !transient);
}

// --------------------------------------------------------------- app actions

function appActionContact(contact: Contact): AppActionContact {
  return {
    id: contact.id,
    first_name: contact.given_name,
    last_name: contact.family_name,
    email: (contact.emails.find((e) => e.is_primary) ?? contact.emails[0])?.email ?? null,
    phone: contact.phones[0]?.number ?? null,
  };
}

async function resolveAppInput(
  ctx: StepContext,
  input: Readonly<Record<string, unknown>>,
  contact: Contact,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let vars: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || !value.includes('{{')) {
      out[key] = value;
      continue;
    }
    vars ??= {
      contact: {
        ...appActionContact(contact),
        name: [contact.given_name, contact.family_name].filter(Boolean).join(' '),
        job_title: contact.job_title,
        custom: contact.custom_fields,
      },
    };
    try {
      out[key] = await renderSandboxed(value, vars, { escapeHtml: false, timezone: await ctx.timeZone() });
    } catch (error) {
      throw new StepFailure(`input ${key}: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
  return out;
}

async function runAppAction(ctx: StepContext, step: StepOf<'app_action'>): Promise<StepOutcome> {
  const port = ctx.host.ports.apps;
  if (port === undefined) return { kind: 'skip', message: 'apps are not available on this installation' };
  const contact = await crm(() => ctx.contact());
  const input = await resolveAppInput(ctx, step.input, contact);
  let outcome;
  try {
    outcome = await port.run({
      appId: step.app_id,
      actionKey: step.action_key,
      input,
      contactId: ctx.contactId,
      contact: appActionContact(contact),
      idempotencyKey: ctx.key,
      automation: { id: ctx.automationId, versionId: ctx.versionId, nodeId: ctx.node.id, stepId: step.id },
    });
  } catch (error) {
    throw new StepFailure(`app ${step.app_id}: ${error instanceof Error ? error.message : String(error)}`, false);
  }
  switch (outcome.kind) {
    case 'skipped':
      return { kind: 'skip', message: `app ${step.app_id}: ${outcome.reason.replace('_', ' ')}` };
    case 'ok':
      return { kind: 'done', message: `${step.app_id}.${step.action_key}: HTTP ${outcome.status}`, result: outcome.output };
    case 'failed':
      throw new StepFailure(`${step.app_id}.${step.action_key}: ${outcome.error}`, !outcome.transient);
  }
}

// ------------------------------------------------------------------ router

export async function executeStep(ctx: StepContext): Promise<StepOutcome> {
  const step = ctx.step;
  const port = ctx.host.ports.crm;
  switch (step.type) {
    case 'delay':
      return runDelay(ctx, step);
    case 'wait_until':
      return runWaitUntil(ctx, step);
    case 'field_timer':
      return runFieldTimer(ctx, step);
    case 'send_email':
      return runSendEmail(ctx, step);
    case 'apply_tag':
      await crm(() =>
        crmCall(port, 'contacts.applyTags', { id: ctx.contactId, data: { tag_ids: step.tag_ids } }),
      );
      return { kind: 'done', message: `${step.tag_ids.length} tag(s) applied` };
    case 'remove_tag':
      for (const tagId of step.tag_ids) {
        await crm(() => crmCall(port, 'contacts.removeTag', { id: ctx.contactId, tagId }));
      }
      return { kind: 'done', message: `${step.tag_ids.length} tag(s) removed` };
    case 'add_note': {
      const note = await once(ctx, 'notes.create', {
        contact_id: ctx.contactId,
        ...(step.title === undefined ? {} : { title: step.title }),
        body: step.body,
      });
      return { kind: 'done', message: 'note added', result: { note_id: note.id } };
    }
    case 'create_task': {
      const assignee = await resolveUser(ctx, step.assign_to);
      const task = await once(ctx, 'tasks.create', {
        title: step.title,
        contact_id: ctx.contactId,
        assigned_to: assignee,
        ...(step.description === undefined ? {} : { description: step.description }),
        ...(step.due_in === undefined ? {} : { due_at: iso(ctx.now + durationMs(step.due_in)) }),
        ...(step.priority === undefined ? {} : { priority: step.priority }),
        ...(step.task_type === undefined ? {} : { type: step.task_type }),
      });
      return { kind: 'done', message: 'task created', result: { task_id: task.id } };
    }
    case 'create_appointment': {
      const owner = await resolveUser(ctx, step.owner);
      const start = ctx.now + durationMs(step.start_in);
      const appointment = await once(ctx, 'appointments.create', {
        title: step.title,
        start_at: iso(start),
        end_at: iso(start + step.duration_minutes * 60_000),
        contact_id: ctx.contactId,
        owner_id: owner,
        ...(step.location === undefined ? {} : { location: step.location }),
        ...(step.description === undefined ? {} : { description: step.description }),
      });
      return {
        kind: 'done',
        message: 'appointment created',
        result: { appointment_id: appointment.id },
      };
    }
    case 'set_field':
      return runSetField(ctx, step);
    case 'assign_owner': {
      const index =
        step.strategy === 'round_robin'
          ? ctx.host.nextRoundRobin(`rr:${ctx.automationId}:${step.id}`, step.user_ids.length)
          : 0;
      const ownerId = step.user_ids[index] ?? step.user_ids[0] ?? null;
      await crm(() =>
        crmCall(port, 'contacts.update', { id: ctx.contactId, data: { owner_id: ownerId } }),
      );
      return { kind: 'done', message: 'owner assigned', result: { owner_id: ownerId } };
    }
    case 'create_opportunity': {
      const owner = await resolveUser(ctx, step.owner ?? 'contact_owner');
      const opp = await once(ctx, 'opportunities.create', {
        title: step.title,
        contact_id: ctx.contactId,
        owner_id: owner,
        ...(step.pipeline_id === undefined ? {} : { pipeline_id: step.pipeline_id }),
        ...(step.stage_id === undefined ? {} : { stage_id: step.stage_id }),
        ...(step.value_minor === undefined ? {} : { value_minor: step.value_minor }),
        ...(step.currency === undefined ? {} : { currency: step.currency }),
      });
      return { kind: 'done', message: 'opportunity created', result: { opportunity_id: opp.id } };
    }
    case 'move_opportunity_stage':
      return runMoveStage(ctx, step);
    case 'create_order':
      return runCreateOrder(ctx, step);
    case 'cancel_subscription':
      return runCancelSubscription(ctx, step);
    case 'http_request':
      return runHttp(ctx, step);
    case 'app_action':
      return runAppAction(ctx, step);
    case 'add_to_sequence':
      return {
        kind: 'done',
        message: ctx.host.addToSequence(ctx.contactId, step.automation_id, step.node_id),
      };
    case 'remove_from_sequence':
      return {
        kind: 'done',
        message: ctx.host.removeFromSequence(
          ctx.contactId,
          step.automation_id,
          step.node_id,
          ctx.tokenId,
        ),
      };
    case 'send_signature_request':
      return runSendSignatureRequest(ctx, step);
    case 'end':
      return { kind: 'end', message: 'automation ended for the contact' };
  }
}
