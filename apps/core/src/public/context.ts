import type { GatewayClientInfo, GatewayErrorBody, GatewayTenantInfo } from '@amable/api-types';
import type { CrmActor } from '../crm/context';
import type { CrmOpInput, CrmOpName, CrmOpOutput, CrmResult } from '../crm/ops';
import type { TenantDb } from '../do/tenant-db';
import type { Env } from '../env';

/**
 * Actor of operations triggered by anonymous visitors through the edge
 * (form submissions, bookings, page views). Events record it as `system`.
 */
export const PUBLIC_ACTOR: CrmActor = { type: 'system', id: null, canReadSensitive: false };

/** Expected error of a gateway op: becomes `{ ok: false, error }` for the edge. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: GatewayErrorBody['details'],
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toBody(): GatewayErrorBody {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** What a gateway op receives: the resolved tenant and the visitor facts collected by the edge. */
export interface GatewayContext {
  readonly env: Env;
  readonly executionCtx: ExecutionContext;
  readonly tenant: GatewayTenantInfo;
  readonly client: GatewayClientInfo;
  /** The tenant's TenantDb stub. */
  tenantDb(): DurableObjectStub<TenantDb>;
  /** Runs a TenantDb op as `PUBLIC_ACTOR`; domain errors are rethrown as `GatewayError`. */
  crm<K extends CrmOpName>(op: K, input: CrmOpInput<K>): Promise<CrmOpOutput<K>>;
}

/** Ops validate their own input (Zod) — the gateway only authenticates the edge and resolves the tenant. */
export type GatewayHandler = (ctx: GatewayContext, input: unknown) => Promise<unknown>;
export type GatewayHandlers = Record<string, GatewayHandler>;
export type GatewayRawHandler = (ctx: GatewayContext, input: unknown) => Promise<Response>;
export type GatewayRawHandlers = Record<string, GatewayRawHandler>;

export function createGatewayContext(input: {
  env: Env;
  executionCtx: ExecutionContext;
  tenant: GatewayTenantInfo;
  client: GatewayClientInfo;
}): GatewayContext {
  const stub = (): DurableObjectStub<TenantDb> =>
    input.env.TENANT_DB.get(input.env.TENANT_DB.idFromName(input.tenant.id));
  return {
    ...input,
    tenantDb: stub,
    async crm<K extends CrmOpName>(op: K, opInput: CrmOpInput<K>): Promise<CrmOpOutput<K>> {
      const result = (await stub().crm(op, PUBLIC_ACTOR, opInput)) as CrmResult<CrmOpOutput<K>>;
      if (!result.ok) {
        throw new GatewayError(
          result.error.status,
          result.error.code,
          result.error.message,
          result.error.details,
        );
      }
      return result.value;
    },
  };
}
