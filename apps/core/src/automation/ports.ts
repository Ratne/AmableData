import type { SecretBox } from '@amable/auth/security';
import type { EmailSendRequest, QuotaGuard } from '@amable/core';
import type { CrmActor } from '../crm/context';
import type { CrmErrorShape } from '../crm/errors';
import type { CrmOpInput, CrmOpName, CrmOpOutput, CrmResult } from '../crm/ops';

/**
 * Everything the automation engine needs from the outside world. The Engine DO
 * wires them to the TenantDb RPC, the email queue, `fetch` and the DO alarm;
 * tests wire them to an in-memory tenant and fakes.
 */

/** Calls a CRM operation in the tenant's TenantDb (untyped: commerce ops may not exist yet). */
export interface CrmPort {
  call(op: string, input: unknown): Promise<CrmResult<unknown>>;
}

export interface EmailQueuePort {
  send(message: EmailSendRequest): Promise<void>;
}

/** Single DO alarm: `null` clears it. */
export interface AlarmPort {
  set(at: number | null): Promise<void>;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebhookPublisher {
  publish(
    events: ReadonlyArray<{
      id: string;
      type: string;
      occurredAt: string;
      payload: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void>;
}

export interface EnginePorts {
  readonly tenantId: string;
  readonly crm: CrmPort;
  readonly email: EmailQueuePort;
  readonly quota: QuotaGuard;
  readonly fetch: FetchFn;
  readonly alarm: AlarmPort;
  /**
   * Encrypts the HTTP signing secrets at rest (`AUTH_ENCRYPTION_KEY`). Without
   * it (no key configured) secrets are stored as generated.
   */
  readonly secretBox?: () => Promise<SecretBox | null>;
  /** Outgoing webhooks: every event seen by the bus is offered for fan-out (at-least-once). */
  readonly webhooks?: WebhookPublisher;
  now(): number;
  newId(): string;
}

/** Actor of every CRM change made by an automation. */
export const ENGINE_ACTOR: CrmActor = { type: 'system', id: null, canReadSensitive: true };

/** A CRM call answered with a domain error (4xx). */
export class CrmCallError extends Error {
  constructor(readonly shape: CrmErrorShape) {
    super(`${shape.code}: ${shape.message}`);
    this.name = 'CrmCallError';
  }
}

/** Typed CRM call; domain errors become `CrmCallError`, transport errors propagate. */
export async function crmCall<K extends CrmOpName>(
  port: CrmPort,
  op: K,
  input: CrmOpInput<K>,
): Promise<CrmOpOutput<K>> {
  const result = await port.call(op, input);
  if (!result.ok) throw new CrmCallError(result.error);
  return result.value as CrmOpOutput<K>;
}

export function isUnknownOp(error: unknown): boolean {
  return (
    error instanceof CrmCallError &&
    error.shape.code === 'bad_request' &&
    error.shape.message.startsWith('unknown CRM operation')
  );
}
