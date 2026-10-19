import { sha256Hex } from '@amable/auth';
import { ulid } from 'ulid';
import type { CrmOpInput, CrmOpName, CrmOpOutput } from '../crm/ops';
import type { MailResult } from '../email/ops';
import type { Env } from '../env';
import type { EsignMail } from './due';
import { esignEmail } from './messages';
import type { TenantFacts } from './model';
import { sealDocument } from './pdf';
import { signerToken, signingUrl } from './tokens';

/** Synchronous TenantDb op as the system actor (throws on domain errors). */
export type EsignCall = <K extends CrmOpName>(op: K, input: CrmOpInput<K>) => CrmOpOutput<K>;
/** The same op from outside the Durable Object (RPC). */
export type EsignAsyncCall = <K extends CrmOpName>(op: K, input: CrmOpInput<K>) => Promise<CrmOpOutput<K>>;

/** Queue of the sealing jobs (`{ tenantId, requestId }`), consumed by this worker. */
export const ESIGN_SEAL_QUEUE = 'esign-seal';

export interface EsignSealMessage {
  readonly tenantId: string;
  readonly requestId: string;
}

export interface EsignRunResult {
  /** Outbox events were written (invitations, seals): the automation engine should look. */
  changed: boolean;
  /** Something failed and is still due: retry later rather than right away. */
  failed: boolean;
  tenantId: string | null;
}

export function completedKey(tenantId: string, requestId: string): string {
  return `tenants/${tenantId}/esign/requests/${requestId}/completed-${ulid()}.pdf`;
}

/** The workspace time zone of the email settings (UTC when unset or unreachable). */
async function tenantTimeZone(env: Env, tenantId: string): Promise<string> {
  try {
    const stub = env.MAIL_DB.get(env.MAIL_DB.idFromName(tenantId));
    const result = (await stub.mail(tenantId, 'settings.timezone', {})) as MailResult<{ timezone: string }>;
    return result.ok ? result.value.timezone : 'UTC';
  } catch {
    return 'UTC';
  }
}

async function sendMail(
  env: Env,
  tenant: TenantFacts & { timeZone: string },
  mail: EsignMail,
  now: number,
): Promise<string> {
  const { token, hash } = await signerToken(env, mail.tokenNonce, mail.tokenHash);
  await env.EMAIL_SEND.send(
    esignEmail({
      id: `esign-${mail.kind}-${mail.signerId}-${String(now)}`,
      tenantId: tenant.id,
      senderName: tenant.name,
      tenantTimeZone: tenant.timeZone,
      kind: mail.kind,
      mail,
      url: signingUrl(env, tenant.slug, token),
      now,
    }),
  );
  return hash;
}

/**
 * Signature timers of one tenant, run by the TenantDb alarm: invitations
 * (sequential order: the next party once the previous one signed), reminders,
 * expiry, and sealing of completed requests.
 */
export async function runEsignDue(
  env: Env,
  call: EsignCall,
  now: () => number = Date.now,
): Promise<EsignRunResult> {
  const due = call('esign.due', {});
  const facts = due.tenant;
  const result: EsignRunResult = { changed: false, failed: false, tenantId: facts?.id ?? null };
  if (facts === null || (due.mails.length === 0 && due.finalize.length === 0)) return result;
  const tenant = {
    ...facts,
    timeZone: due.mails.some((m) => m.timeZone === null && m.expiresAt !== null)
      ? await tenantTimeZone(env, facts.id)
      : 'UTC',
  };

  for (const mail of due.mails) {
    if (mail.kind === 'completed') continue;
    try {
      const hash = await sendMail(env, tenant, mail, now());
      call('esign.markNotified', { signerId: mail.signerId, kind: mail.kind, tokenHash: hash });
      result.changed = true;
    } catch (error) {
      console.error('[esign] notification failed', mail.signerId, error);
      result.failed = true;
    }
  }

  for (const requestId of due.finalize) {
    if (!call('esign.finalizeLease', { requestId }).granted) continue;
    const queue = env.ESIGN_SEAL;
    if (queue !== undefined) {
      try {
        await queue.send({ tenantId: tenant.id, requestId } satisfies EsignSealMessage);
      } catch (error) {
        console.error('[esign] sealing job not queued', requestId, error);
        call('esign.markFinalizeFailed', { requestId, error: 'the sealing job could not be queued' });
        result.failed = true;
      }
      continue;
    }
    // No queue bound (older self-hosted configuration): seal here, blocking the tenant meanwhile.
    const outcome = await sealRequest(env, async (op, input) => call(op, input), requestId, now);
    if (outcome === 'sealed') result.changed = true;
    if (outcome === 'failed') result.failed = true;
  }
  return result;
}

/**
 * Builds and stores the signed PDF of a completed request, then emails every
 * signer their copy. Safe to run twice: an already sealed request is skipped,
 * and a duplicate that loses the race deletes its own file.
 */
export async function sealRequest(
  env: Env,
  call: EsignAsyncCall,
  requestId: string,
  now: () => number = Date.now,
): Promise<'sealed' | 'skipped' | 'failed'> {
  try {
    const context = await call('esign.finalizeContext', { requestId });
    if (context.request.completed_r2_key !== null || context.tenant === null) return 'skipped';
    const tenant = context.tenant;
    const source = await env.FILES.get(context.request.source_r2_key);
    if (source === null) throw new Error('original document missing');
    const sealed = await sealDocument({
      request: context.request,
      signers: context.signers,
      events: context.events,
      tenant,
      source: new Uint8Array(await source.arrayBuffer()),
      loadImage: async (key) => {
        const object = await env.FILES.get(key);
        return object === null ? null : new Uint8Array(await object.arrayBuffer());
      },
      now: now(),
    });
    const bytes = new Uint8Array(sealed);
    const sha256 = await sha256Hex(bytes);
    const key = completedKey(tenant.id, requestId);
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, sha256 });
    const { stored, mails } = await call('esign.markFinalized', { requestId, key, sha256 });
    if (!stored) {
      await env.FILES.delete(key).catch(() => undefined);
      return 'skipped';
    }
    for (const mail of mails) {
      try {
        await sendMail(env, { ...tenant, timeZone: 'UTC' }, mail, now());
      } catch (error) {
        console.error('[esign] completed email failed', mail.signerId, error);
      }
    }
    return 'sealed';
  } catch (error) {
    console.error('[esign] sealing failed', requestId, error);
    await call('esign.markFinalizeFailed', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    }).catch((reportError: unknown) => console.error('[esign] sealing failure not recorded', requestId, reportError));
    return 'failed';
  }
}
