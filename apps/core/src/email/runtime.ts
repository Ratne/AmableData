import type { Contact } from '@amable/api-types';
import {
  ConsoleEmailMarketingProvider,
  DirectPostShibaAdmin,
  EmailProviderError,
  PostShibaAccount,
  PostShibaEmailMarketingProvider,
  type EmailMarketingProvider,
  type PostShibaWorkspaceAdmin,
  type QuotaGuard,
} from '@amable/core';
import { SYSTEM_ACTOR } from '../crm/context';
import type { CrmResult } from '../crm/ops';
import type { MailRecipientFacts, MailSendContact } from '../crm/mail-reads';
import type { TenantDb } from '../do/tenant-db';
import type { Env } from '../env';
import { controlPlaneClient } from '../platform/client';
import { createPlatformQuotaGuard } from '../platform/quota';
import { ControlPlanePostShibaAdmin } from './postshiba-managed';
import { postshibaSenderStore, workspaceTenantKey, workspaceWebhookSecret } from './postshiba-senders';
import type {
  AutomationSink,
  CrmReader,
  EmailQueue,
  SendingDomain,
  SendingState,
  TenantUser,
  UserDirectory,
} from './context';

/**
 * Production wiring of the email domain: TenantDb RPC for CRM reads, D1 for
 * members and domains, the email-send queue, the provider chosen from the
 * environment (console in dev, PostShiba otherwise) and the QuotaGuard.
 */

const DEV_TOKEN_SECRET = 'amable-dev-email-token-secret-not-for-production';
let warnedDevSecret = false;

export class EmailConfigError extends Error {
  override readonly name = 'EmailConfigError';
}

/** Signing secrets: `EMAIL_TOKEN_SECRET` (+ comma-separated previous ones for rotation). */
export function tokenSecrets(env: Env): string[] {
  const secrets = [env.EMAIL_TOKEN_SECRET, env.EMAIL_TOKEN_SECRET_PREVIOUS]
    .flatMap((value) => (value ?? '').split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (secrets.length > 0) return secrets;
  if (env.ENVIRONMENT === 'dev') {
    if (!warnedDevSecret) {
      console.warn('[email] EMAIL_TOKEN_SECRET not set: using the public dev secret');
      warnedDevSecret = true;
    }
    return [DEV_TOKEN_SECRET];
  }
  throw new EmailConfigError('EMAIL_TOKEN_SECRET is not configured');
}

export function webhookSecrets(env: Env): string[] {
  return (env.POSTSHIBA_WEBHOOK_SECRET ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Env secrets plus the secret of the workspace's own delivery webhook. */
export async function workspaceWebhookSecrets(env: Env, tenantId: string): Promise<string[]> {
  const own = await workspaceWebhookSecret(env, tenantId);
  return own === null ? webhookSecrets(env) : [own, ...webhookSecrets(env)];
}

class UnconfiguredPostShibaAdmin implements PostShibaWorkspaceAdmin {
  private fail(): Promise<never> {
    return Promise.reject(
      new EmailProviderError(
        'marketing email is not configured: link a license or set POSTSHIBA_API_KEY, POSTSHIBA_TEAM_ID and POSTSHIBA_CLUSTER_ID',
        false,
        null,
        null,
        'not_configured',
      ),
    );
  }
  ensureWorkspace = () => this.fail();
  addDomain = () => this.fail();
  verifyDomain = () => this.fail();
  removeDomain = () => this.fail();
  suspend = () => this.fail();
  resume = () => this.fail();
}

/** Own PostShiba account (team key + team + cluster), else the control plane of the license. */
function postshibaAdmin(env: Env): PostShibaWorkspaceAdmin {
  const apiKey = env.POSTSHIBA_API_KEY ?? '';
  const teamId = env.POSTSHIBA_TEAM_ID ?? '';
  const clusterId = env.POSTSHIBA_CLUSTER_ID ?? '';
  if (apiKey !== '' && teamId !== '' && clusterId !== '') {
    const account = new PostShibaAccount({ apiKey, teamId, ...(env.POSTSHIBA_BASE_URL ? { baseUrl: env.POSTSHIBA_BASE_URL } : {}) });
    return new DirectPostShibaAdmin(account, { clusterId, injectUrl: env.POSTSHIBA_INJECT_URL ?? null });
  }
  const client = controlPlaneClient(env);
  return client === null ? new UnconfiguredPostShibaAdmin() : new ControlPlanePostShibaAdmin(client);
}

/** Console provider in dev (never any network); PostShiba everywhere else. */
export function marketingProvider(env: Env): EmailMarketingProvider {
  if (env.ENVIRONMENT === 'dev') return new ConsoleEmailMarketingProvider();
  const origin = (env.APP_ORIGIN ?? '').replace(/\/+$/, '');
  return new PostShibaEmailMarketingProvider({
    admin: postshibaAdmin(env),
    senders: postshibaSenderStore(env),
    webhookUrl: (workspaceId) => `${origin}/hooks/email/postshiba/${encodeURIComponent(workspaceId)}`,
  });
}

/** Wallet / quota guard of the platform link (allows everything without a license). */
export function quotaGuard(env: Env): QuotaGuard {
  return createPlatformQuotaGuard(env);
}

function unwrap<T>(result: CrmResult<unknown>): T {
  if (!result.ok) throw new Error(`crm ${result.error.code}: ${result.error.message}`);
  return result.value as T;
}

export function crmReader(env: Env, tenantId: string): CrmReader {
  const stub = (): DurableObjectStub<TenantDb> =>
    env.TENANT_DB.get(env.TENANT_DB.idFromName(tenantId));
  return {
    async segmentMemberIds(segment) {
      return unwrap<string[]>(await stub().crm('mail.segmentMemberIds', SYSTEM_ACTOR, { segment }));
    },
    async recipientFacts(ids) {
      return unwrap<MailRecipientFacts[]>(await stub().crm('mail.recipientFacts', SYSTEM_ACTOR, { ids }));
    },
    async contactsForSend(ids) {
      return unwrap<MailSendContact[]>(await stub().crm('mail.contactsForSend', SYSTEM_ACTOR, { ids }));
    },
    async setMarketableStatus(contactId: string, status: Contact['marketable_status']) {
      unwrap(await stub().crm('contacts.update', SYSTEM_ACTOR, { id: contactId, data: { marketable_status: status } }));
    },
    async recordEvents(events) {
      return unwrap<{ recorded: number }>(await stub().crm('mail.recordEvents', SYSTEM_ACTOR, { events }));
    },
    async transactionalUndelivered(input) {
      if (input.purpose !== 'esign') return;
      unwrap(
        await stub().crm('esign.mailUndelivered', SYSTEM_ACTOR, {
          requestId: input.referenceId,
          email: input.email,
          reason: input.reason,
        }),
      );
    },
  };
}

export function userDirectory(env: Env, tenantId: string): UserDirectory {
  const query = async (sql: string, ids: readonly string[]): Promise<TenantUser[]> => {
    if (ids.length === 0) return [];
    const result = await env.DB.prepare(sql.replace('$IDS', ids.map(() => '?').join(', ')))
      .bind(...ids, tenantId)
      .all<TenantUser>();
    return result.results;
  };
  const members = (ids: readonly string[]): Promise<TenantUser[]> =>
    query(
      `SELECT u.id, u.email, u.name FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE u.id IN ($IDS) AND m.tenant_id = ?`,
      ids,
    );
  // Contact owners are tenant members too: same lookup, never other tenants' users.
  return { members, users: members };
}

/**
 * Sending-domain state from the installation D1 (`domains`, kinds `sending` and
 * `tracking`). `EMAIL_ALLOW_UNVERIFIED_DOMAIN=true` is honored only in dev.
 */
export function sendingState(env: Env, tenantId: string): () => Promise<SendingState> {
  return async () => {
    const rows = (
      await env.DB.prepare(`SELECT hostname, kind, status FROM domains WHERE tenant_id = ?`)
        .bind(tenantId)
        .all<SendingDomain>()
    ).results;
    const verifiedSending = rows.some((d) => d.kind === 'sending' && d.status === 'verified');
    const tracking = rows.find((d) => d.kind === 'tracking' && d.status === 'verified');
    const override = env.ENVIRONMENT === 'dev' && env.EMAIL_ALLOW_UNVERIFIED_DOMAIN === 'true';
    const providerTenant = await env.DB.prepare(
      `SELECT value FROM installation_meta WHERE key = ?`,
    )
      .bind(workspaceTenantKey(tenantId))
      .first<{ value: string }>();
    return {
      state: verifiedSending ? 'verified' : override ? 'dev_override' : 'unverified',
      domains: rows,
      trackingOrigin:
        tracking !== undefined
          ? `https://${tracking.hostname}`
          : (env.EDGE_ORIGIN ?? env.APP_ORIGIN ?? 'http://localhost:8788'),
      providerTenantId: providerTenant?.value ?? null,
    };
  };
}

export function emailQueue(env: Env): EmailQueue {
  return {
    async send(requests) {
      for (let i = 0; i < requests.length; i += 100) {
        await env.EMAIL_SEND.sendBatch(requests.slice(i, i + 100).map((body) => ({ body })));
      }
    },
  };
}

export function automationSink(env: Env, tenantId: string): AutomationSink {
  return {
    async kick() {
      await env.ENGINE.get(env.ENGINE.idFromName(tenantId)).kick(tenantId);
    },
  };
}
