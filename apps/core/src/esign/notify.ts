import { sendSystemEmail } from '../auth/emails';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import type { DeclineNotice } from './signing';

const ADMIN_ROLES = ['owner', 'admin'];

interface Recipient {
  email: string;
  locale: string;
}

/**
 * The member who sent the request (for API keys, the member who created the
 * key); requests sent by automations, or whose sender left, go to the admins.
 */
async function recipients(
  env: Env,
  tenantId: string,
  createdBy: string | null,
): Promise<Recipient[]> {
  if (createdBy !== null) {
    const sender = await env.DB.prepare(
      `SELECT u.email, u.locale FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE u.id = ? AND m.tenant_id = ?`,
    )
      .bind(createdBy, tenantId)
      .first<Recipient>();
    if (sender !== null) return [sender];
  }
  const admins = await env.DB.prepare(
    `SELECT u.email, u.locale FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.tenant_id = ? AND m.role IN (SELECT value FROM json_each(?))`,
  )
    .bind(tenantId, JSON.stringify(ADMIN_ROLES))
    .all<Recipient>();
  return admins.results;
}

export async function notifyDecline(
  env: Env,
  tenant: { id: string; slug: string },
  notice: DeclineNotice,
): Promise<void> {
  try {
    const to = await recipients(env, tenant.id, notice.createdBy);
    if (to.length === 0) return;
    const services = await getAuthServices(env);
    const origin = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
    const url = `${origin}/t/${encodeURIComponent(tenant.slug)}/signatures/${encodeURIComponent(notice.requestId)}`;
    for (const recipient of to) {
      await sendSystemEmail(services, recipient.email, recipient.locale, 'esign_declined', {
        document: notice.requestName,
        signer: notice.signer,
        reason: notice.reason ?? (recipient.locale.startsWith('it') ? 'nessuno' : 'none'),
        url,
      });
    }
  } catch (error) {
    console.error('[esign] decline notice failed', notice.requestId, error);
  }
}
