import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { appOriginOf } from '../providers/select';

/**
 * Plain notices to a workspace's admins about its apps (paused, revoked, new
 * permissions to approve). Best effort: a failing email never blocks the
 * lifecycle change that triggered it.
 */

export type AppNotice = 'paused' | 'revoked' | 'scopes_pending';

const COPY: Record<AppNotice, Record<'en' | 'it', { subject: string; body: string }>> = {
  paused: {
    en: {
      subject: 'App "{app}" paused',
      body: '"{app}" stopped answering and has been paused in {tenant}. It will not receive events or run until an admin resumes it.',
    },
    it: {
      subject: 'App "{app}" in pausa',
      body: '"{app}" ha smesso di rispondere ed è stata messa in pausa in {tenant}. Non riceverà eventi e non verrà eseguita finché un admin non la riattiva.',
    },
  },
  revoked: {
    en: {
      subject: 'App "{app}" removed from the marketplace',
      body: '"{app}" has been revoked by the marketplace and disabled in {tenant}. Reason: {reason}',
    },
    it: {
      subject: 'App "{app}" rimossa dal marketplace',
      body: '"{app}" è stata revocata dal marketplace e disattivata in {tenant}. Motivo: {reason}',
    },
  },
  scopes_pending: {
    en: {
      subject: 'App "{app}" asks for new permissions',
      body: 'An update of "{app}" in {tenant} needs new permissions: {scopes}. It keeps working with the current ones until an admin approves.',
    },
    it: {
      subject: 'L\'app "{app}" chiede nuovi permessi',
      body: 'Un aggiornamento di "{app}" in {tenant} richiede nuovi permessi: {scopes}. Continua a funzionare con quelli attuali finché un admin non approva.',
    },
  },
};

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export async function notifyAppAdmins(
  env: Env,
  tenantId: string,
  notice: AppNotice,
  vars: { app: string; reason?: string; scopes?: string[] },
): Promise<void> {
  try {
    const tenant = await env.DB.prepare(`SELECT name, slug FROM tenants WHERE id = ?`)
      .bind(tenantId)
      .first<{ name: string; slug: string }>();
    if (tenant === null) return;
    const admins = await env.DB.prepare(
      `SELECT u.email, u.locale FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.tenant_id = ? AND m.role IN ('owner', 'admin')`,
    )
      .bind(tenantId)
      .all<{ email: string; locale: string }>();
    const services = await getAuthServices(env);
    const link = `${appOriginOf(env)}/t/${tenant.slug}/settings/apps/installed`;
    for (const admin of admins.results) {
      const locale = admin.locale.startsWith('it') ? 'it' : 'en';
      const copy = COPY[notice][locale];
      const values = {
        app: vars.app,
        tenant: tenant.name,
        reason: vars.reason ?? '-',
        scopes: (vars.scopes ?? []).join(', '),
      };
      const subject = fill(copy.subject, values);
      const body = fill(copy.body, values);
      await services.email.send({
        to: admin.email,
        subject,
        text: `${body}\n\n${link}`,
        html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
        locale,
      });
    }
  } catch (error) {
    console.error('[apps] admin notice failed:', error instanceof Error ? error.message : error);
  }
}
