import type { Context } from 'hono';
import { insertAudit } from '../auth/store';
import type { AppEnv } from './context';
import { clientIp } from './request';

export type AuditDetails = Record<string, string | number | boolean | null>;

/**
 * Appends an audit log entry. Tenant, actor and IP come from the verified
 * context. Never pass secrets, tokens, codes or full personal data in details.
 */
export async function audit(
  c: Context<AppEnv>,
  action: string,
  options: {
    target?: string | null;
    details?: AuditDetails | null;
    /** Overrides for flows without an authenticated context (login, reset…). */
    tenantId?: string | null;
    actorUserId?: string | null;
  } = {},
): Promise<void> {
  const auth = c.get('auth');
  const tenant = c.get('tenant');
  await insertAudit(c.env.DB, {
    tenantId: options.tenantId !== undefined ? options.tenantId : (tenant?.tenant.id ?? null),
    actorUserId:
      options.actorUserId !== undefined ? options.actorUserId : (auth?.user.id ?? null),
    actorType: auth?.kind === 'api_key' ? 'api_key' : auth === undefined && options.actorUserId === undefined ? 'system' : 'user',
    action,
    target: options.target ?? null,
    details: options.details ?? null,
    ip: clientIp(c),
    now: c.get('services').now(),
  });
}
