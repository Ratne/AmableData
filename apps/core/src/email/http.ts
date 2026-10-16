import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CrmHttpError, createCrmRouter, errorBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { getTenant, handleError, type AppEnv } from '../middleware';
import type { MailErrorShape } from './context';
import type { MailDb } from './mail-db';
import type { MailOpInput, MailOpName, MailOpOutput, MailResult } from './ops';

/** Error raised by the REST layer from a MailDb error result. */
export class MailHttpError extends Error {
  constructor(readonly shape: MailErrorShape) {
    super(shape.message);
  }
}

/** v2 router for the email module: CRM validation hook + MailDb error mapping. */
export function createMailRouter(): ReturnType<typeof createCrmRouter> {
  const router = createCrmRouter();
  router.onError((error, c) => {
    if (error instanceof MailHttpError) {
      return c.json(
        {
          error: error.shape.code,
          message: error.shape.message,
          ...(error.shape.details === undefined ? {} : { info: error.shape.details }),
        },
        error.shape.status as ContentfulStatusCode,
      );
    }
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

/** MailDb stub of the verified tenant — the only sanctioned way for routes to reach it. */
export function mailDb(c: Context<AppEnv>): DurableObjectStub<MailDb> {
  const { tenant } = getTenant(c);
  return c.env.MAIL_DB.get(c.env.MAIL_DB.idFromName(tenant.id));
}

export async function callMail<K extends MailOpName>(
  c: Context<AppEnv>,
  op: K,
  input: MailOpInput<K>,
): Promise<MailOpOutput<K>> {
  const { tenant } = getTenant(c);
  const result = (await mailDb(c).mail(tenant.id, op, input)) as MailResult<MailOpOutput<K>>;
  if (!result.ok) throw new MailHttpError(result.error);
  return result.value;
}
