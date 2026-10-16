import type { SendSingleEmailInput } from '@amable/api-types';
import type { EmailSendRequest } from '@amable/core';
import { MailError, isoOf, type MailDeps } from './context';
import { getTemplate } from './library';

/** One email to one contact (sales "single email"), through the same queue and checks as automations. */
export async function queueSingleEmail(
  deps: MailDeps,
  input: { contactId: string; userId: string; data: SendSingleEmailInput },
): Promise<{ request_id: string; queued: true }> {
  const d = input.data;
  if (d.template_id === undefined && (d.subject === undefined || d.body === undefined)) {
    throw new MailError('validation_failed', 422, 'provide template_id, or subject and body');
  }
  if (d.template_id !== undefined) getTemplate(deps, { id: d.template_id });
  const [contact] = await deps.crm.recipientFacts([input.contactId]);
  if (contact === undefined) throw new MailError('not_found', 404, `contact ${input.contactId} not found`);
  const request: EmailSendRequest = {
    kind: 'email.send',
    version: 1,
    id: deps.newId(),
    tenantId: deps.tenantId,
    contactId: input.contactId,
    content: {
      templateId: d.template_id ?? null,
      subject: d.subject ?? null,
      preheader: null,
      body: d.body ?? null,
      fromName: null,
      replyTo: null,
    },
    source: { type: 'single', userId: input.userId },
    requestedAt: isoOf(deps.now()),
    notAfter: null,
  };
  await deps.queue.send([request]);
  return { request_id: request.id, queued: true };
}