import { createRoute, OpenAPIHono, z, type RouteConfig } from '@hono/zod-openapi';
import { errorResponseSchema } from '@amable/api-types';
import type { Permission } from '@amable/core';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  getAuth,
  getTenant,
  handleError,
  requireAnyPermission,
  requirePermission,
  requireStepUpForSession,
  requireStepUpForSessionWhen,
  tenantDb,
  type AppEnv,
} from '../../middleware';
import type { CrmActor } from '../context';
import { CrmError, type CrmErrorShape } from '../errors';
import type { CrmOpInput, CrmOpName, CrmOpOutput, CrmResult } from '../ops';

/** Error raised by the REST layer from a DO error result. */
export class CrmHttpError extends Error {
  constructor(readonly shape: CrmErrorShape) {
    super(shape.message);
  }
}

export function errorBody(shape: Pick<CrmErrorShape, 'code' | 'message' | 'details'>) {
  return {
    error: shape.code,
    message: shape.message,
    ...(shape.details === undefined ? {} : { details: shape.details }),
  };
}

/** Router factory: validation failures become 422 `validation_failed` with field details. */
export function createCrmRouter(): OpenAPIHono<AppEnv> {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (result.success) return undefined;
      const details = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || result.target,
        message: issue.message,
      }));
      return c.json(
        errorBody({
          code: 'validation_failed',
          message: `${details[0]?.path ?? result.target}: ${details[0]?.message ?? 'invalid'}`,
          details,
        }),
        422,
      );
    },
  });
  router.onError((error, c) => {
    if (error instanceof CrmHttpError) {
      return c.json(errorBody(error.shape), error.shape.status as ContentfulStatusCode);
    }
    if (error instanceof CrmError) {
      return c.json(errorBody(error.toShape()), error.status as ContentfulStatusCode);
    }
    return handleError(error, c);
  });
  return router;
}

const errorContent = { 'application/json': { schema: errorResponseSchema } };

/** Error responses every v2 route can return. */
export const ERROR_RESPONSES = {
  401: { description: 'Missing or invalid session / API key', content: errorContent },
  403: { description: 'The caller lacks the required permission', content: errorContent },
  404: { description: 'Tenant or resource not found', content: errorContent },
  409: { description: 'Conflict (duplicate, idempotency key in progress)', content: errorContent },
  422: { description: 'Validation failed', content: errorContent },
} as const;

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
});

/**
 * Declares a v2 route: OpenAPI metadata, the standard error responses and the
 * permission it requires (enforced by `requirePermission` and published as
 * `x-amable-permission` in the OpenAPI document).
 */
export function crmRoute<const R extends Omit<RouteConfig, 'middleware' | 'security'>>(
  permission: Permission,
  config: R,
  options: {
    /** Always, or only when the predicate says the request touches secrets. */
    stepUp?: boolean | ((c: Context<AppEnv>) => boolean | Promise<boolean>);
    /** Also requires at least one of these (declared as `x-amable-permission-any`). */
    anyOf?: readonly Permission[];
  } = {},
) {
  const { stepUp, anyOf } = options;
  const middleware: MiddlewareHandler<AppEnv>[] = [requirePermission(permission)];
  if (anyOf !== undefined) middleware.push(requireAnyPermission(anyOf));
  if (stepUp !== undefined && stepUp !== false) {
    middleware.push(stepUp === true ? requireStepUpForSession() : requireStepUpForSessionWhen(stepUp));
  }
  const extra = {
    middleware: middleware.length === 1 ? middleware[0]! : middleware,
    security: [{ apiKey: [] }, { session: [] }] as Array<Record<string, string[]>>,
    'x-amable-permission': permission,
    ...(anyOf === undefined ? {} : { 'x-amable-permission-any': [...anyOf] }),
  };
  const route: R & typeof extra = Object.assign({}, config, extra, {
    responses: { ...ERROR_RESPONSES, ...config.responses },
  });
  return createRoute(route);
}

/** CRM actor of the verified caller. */
export function actorOf(c: Context<AppEnv>): CrmActor {
  const auth = getAuth(c);
  const tenant = getTenant(c);
  return {
    type: auth.kind === 'session' ? 'user' : auth.kind,
    id: auth.user.id,
    canReadSensitive: tenant.can('contacts:read_sensitive'),
  };
}

/** Runs a CRM operation in the verified tenant's DO; domain errors become HTTP errors. */
export async function callCrm<K extends CrmOpName>(
  c: Context<AppEnv>,
  op: K,
  input: CrmOpInput<K>,
): Promise<CrmOpOutput<K>> {
  const result = (await tenantDb(c).crm(op, actorOf(c), input)) as CrmResult<CrmOpOutput<K>>;
  if (!result.ok) throw new CrmHttpError(result.error);
  return result.value;
}

// ------------------------------------------------------------- idempotency

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
/** Responses worth replaying: success and deterministic client errors. */
const NON_REPLAYABLE = new Set([401, 403, 429]);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `Idempotency-Key` support for every POST: the first request runs and its
 * response is stored for 24 h in the tenant DO; a retry with the same key and
 * body replays it (`Idempotent-Replayed: true`); the same key with a different
 * body is a 422, a concurrent duplicate a 409.
 */
export function idempotency(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('idempotency-key');
    if (c.req.method !== 'POST' || header === undefined) return next();
    if (!IDEMPOTENCY_KEY_RE.test(header)) {
      return c.json(
        errorBody({ code: 'bad_request', message: 'invalid Idempotency-Key header' }),
        400,
      );
    }
    const auth = getAuth(c);
    const key = `${auth.kind === 'api_key' ? `k:${auth.apiKey.id}` : auth.kind === 'app' ? `a:${auth.app.installId}` : `u:${auth.user.id}`}:${header}`;
    const body = await c.req.raw.clone().text();
    const requestHash = await sha256Hex(`${c.req.method} ${new URL(c.req.url).pathname}\n${body}`);
    const begin = await callCrm(c, 'idempotency.begin', { key, requestHash });
    if (begin.state === 'replay') {
      return new Response(begin.body, {
        status: begin.status,
        headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
      });
    }
    if (begin.state === 'mismatch') {
      return c.json(
        errorBody({
          code: 'idempotency_conflict',
          message: 'Idempotency-Key reused with a different request',
        }),
        422,
      );
    }
    if (begin.state === 'in_progress') {
      return c.json(
        errorBody({
          code: 'idempotency_in_progress',
          message: 'a request with this key is in progress',
        }),
        409,
      );
    }
    await next();
    const status = c.res.status;
    if (status >= 500 || NON_REPLAYABLE.has(status)) {
      await callCrm(c, 'idempotency.abort', { key });
    } else {
      await callCrm(c, 'idempotency.complete', { key, status, body: await c.res.clone().text() });
    }
  };
}
