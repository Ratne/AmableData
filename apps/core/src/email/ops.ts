import type { BroadcastSchedule, TestSendInput } from '@amable/api-types';
import type { EmailSendRequest } from '@amable/core';
import * as broadcasts from '../broadcast/service';
import { getBroadcastRow } from '../broadcast/store';
import { MailError, type MailDeps, type MailErrorShape } from './context';
import * as library from './library';
import { ackEmailEvents, pendingEmailEvents } from './outbox';
import { processSends } from './pipeline';
import * as settings from './settings';
import { mailReportOps } from './report-queries';
import { queueSingleEmail } from './single';
import * as suppressions from './suppressions';
import * as tracking from './tracking';
import { handleProviderWebhook } from './webhooks';

/**
 * Every operation of the email domain, reachable through the single MailDb RPC
 * entry point `mail(op, input)`. Inputs come from the verified REST layer (or
 * the queue consumer / public endpoints, which verify tokens and signatures).
 */
export const mailOps = {
  // templates & snippets
  'templates.list': library.listTemplates,
  'templates.get': library.getTemplate,
  'templates.create': library.createTemplate,
  'templates.update': library.updateTemplate,
  'templates.delete': library.deleteTemplate,
  'templates.testSend': async (deps: MailDeps, input: { id: string; data: TestSendInput; callerId: string }) => {
    const tpl = await library.loadTemplateContent(deps, input.id, null);
    return broadcasts.testSend(deps, {
      content: tpl,
      userIds: input.data.user_ids ?? [input.callerId],
      contactId: input.data.contact_id ?? null,
    });
  },
  'snippets.list': (deps: MailDeps, _input: Record<string, never>) => library.listSnippets(deps),
  'snippets.get': library.getSnippet,
  'snippets.create': library.createSnippet,
  'snippets.update': library.updateSnippet,
  'snippets.delete': library.deleteSnippet,
  // suppressions & messages
  'suppressions.list': suppressions.listSuppressions,
  'suppressions.add': suppressions.addSuppression,
  'suppressions.remove': suppressions.removeSuppression,
  'messages.byContact': suppressions.listContactMessages,
  'messages.countByContact': suppressions.countContactMessages,
  'messages.get': suppressions.getMessage,
  'messages.sendSingle': queueSingleEmail,
  // settings
  'settings.get': (deps: MailDeps, _input: Record<string, never>) => settings.readSettings(deps),
  'settings.timezone': (deps: MailDeps, _input: Record<string, never>) => ({ timezone: settings.tenantTimeZone(deps) }),
  'settings.update': settings.updateSettings,
  'settings.resume': async (deps: MailDeps, _input: Record<string, never>) => {
    settings.resumeSending(deps);
    const { providerTenantId } = await deps.sending();
    if (providerTenantId !== null) await deps.provider.resumeTenant(providerTenantId);
    return settings.readSettings(deps);
  },
  // broadcasts
  'broadcasts.list': broadcasts.listBroadcasts,
  'broadcasts.get': broadcasts.getBroadcast,
  'broadcasts.create': broadcasts.createBroadcast,
  'broadcasts.update': broadcasts.updateBroadcast,
  'broadcasts.delete': broadcasts.deleteBroadcast,
  'broadcasts.estimate': broadcasts.estimateBroadcast,
  'broadcasts.schedule': (deps: MailDeps, input: { id: string; schedule: BroadcastSchedule }) =>
    broadcasts.scheduleBroadcast(deps, input),
  'broadcasts.pause': broadcasts.pauseBroadcast,
  'broadcasts.resume': broadcasts.resumeBroadcast,
  'broadcasts.cancel': broadcasts.cancelBroadcast,
  'broadcasts.stats': broadcasts.broadcastStats,
  'broadcasts.testSend': async (deps: MailDeps, input: { id: string; data: TestSendInput; callerId: string }) => {
    const content = await broadcasts.broadcastContent(deps, getBroadcastRow(deps, input.id));
    return broadcasts.testSend(deps, {
      content,
      userIds: input.data.user_ids ?? [input.callerId],
      contactId: input.data.contact_id ?? null,
    });
  },
  'broadcasts.tick': (deps: MailDeps, _input: Record<string, never>) => broadcasts.broadcastTick(deps),
  // pipeline, tracking, webhooks, outbox
  'send.process': (deps: MailDeps, input: { batch: { request: EmailSendRequest; queueAttempts: number }[] }) =>
    processSends(deps, input.batch),
  'track.click': tracking.recordClick,
  'track.open': tracking.recordOpen,
  'unsubscribe.info': tracking.unsubscribeInfo,
  'unsubscribe.confirm': tracking.unsubscribe,
  'webhooks.provider': handleProviderWebhook,
  'events.pending': pendingEmailEvents,
  'events.ack': ackEmailEvents,
  // report engine (read-only aggregates)
  ...mailReportOps,
} satisfies Record<string, (deps: MailDeps, input: never) => unknown>;

export type MailOps = typeof mailOps;
export type MailOpName = keyof MailOps;
export type MailOpInput<K extends MailOpName> = Parameters<MailOps[K]>[1];
export type MailOpOutput<K extends MailOpName> = Awaited<ReturnType<MailOps[K]>>;

export type MailResult<T> = { ok: true; value: T } | { ok: false; error: MailErrorShape };

export function isMailOp(op: string): op is MailOpName {
  return Object.hasOwn(mailOps, op);
}

/** Runs one op; domain errors become `{ ok: false }` (classes don't survive RPC). */
export async function runMailOp(deps: MailDeps, op: string, input: unknown): Promise<MailResult<unknown>> {
  if (!isMailOp(op)) {
    return { ok: false, error: { code: 'unknown_op', status: 400, message: `unknown mail op ${op}` } };
  }
  const fn = mailOps[op] as (deps: MailDeps, input: unknown) => unknown;
  try {
    return { ok: true, value: await fn(deps, input) };
  } catch (error) {
    if (error instanceof MailError) return { ok: false, error: error.toShape() };
    throw error;
  }
}
