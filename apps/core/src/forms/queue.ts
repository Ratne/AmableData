import type { Env } from '../env';
import { MAX_DELIVERY_ATTEMPTS, processSubmission, type ProcessOutcome } from './process';
import { formsRuntime } from './runtime';

/** Queue carrying stored form submissions to process (CRM mapping, connections). */
export const FORM_SUBMISSIONS_QUEUE = 'form-submissions';

export interface FormSubmissionMessage {
  readonly tenantId: string;
  readonly submissionId: string;
}

function isMessage(body: unknown): body is FormSubmissionMessage {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>)['tenantId'] === 'string' &&
    typeof (body as Record<string, unknown>)['submissionId'] === 'string'
  );
}

/** 30 s, 2 min, 8 min, 32 min… capped at 1 h. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(3600, 30 * 4 ** Math.max(0, attempt - 1));
}

/**
 * `form-submissions` consumer. Applying a submission is idempotent (a
 * processed one is not applied twice) and successful deliveries are not
 * repeated, so a retried message only redoes what failed.
 */
export async function consumeFormSubmissions(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const runtime = await formsRuntime(env);
  for (const message of batch.messages) {
    if (!isMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      const outcome = await processSubmission(env, message.body.tenantId, message.body.submissionId, {
        attempt: message.attempts,
        final: message.attempts >= MAX_DELIVERY_ATTEMPTS,
        runtime,
      });
      if (outcome.retry) message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      else message.ack();
    } catch (error) {
      console.error('[forms] submission processing failed', message.body.submissionId, error);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

/**
 * Hands a stored submission to the queue, or processes it in the background
 * of the current request when the binding is missing (single attempt; failed
 * deliveries can be retried with "reprocess").
 */
export async function enqueueSubmission(
  env: Env,
  executionCtx: Pick<ExecutionContext, 'waitUntil'>,
  message: FormSubmissionMessage,
): Promise<void> {
  if (env.FORM_SUBMISSIONS !== undefined) {
    await env.FORM_SUBMISSIONS.send(message);
    return;
  }
  executionCtx.waitUntil(
    processSubmission(env, message.tenantId, message.submissionId, { attempt: 1, final: true }).then(
      (outcome: ProcessOutcome) => void outcome,
      (error: unknown) => console.error('[forms] inline processing failed', message.submissionId, error),
    ),
  );
}
