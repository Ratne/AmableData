import type { Env } from '../env';
import { callApp } from './call';
import { sendAppEvent } from './events';
import { activeInstalls } from './store';
import { tenantOp } from './tenant';
import type { ContactPrivacyFacts } from './tenant-ops';

/**
 * GDPR requests that must reach every app holding personal data: erasure
 * (the CRM erases first, then each app gets `privacy.erasure_requested` with
 * the identifiers to look up) and access (the export includes what each app
 * returns from its `data_request_endpoint`).
 */

const personalDataInstalls = async (env: Env, tenantId: string) =>
  (await activeInstalls(env.DB, tenantId)).filter((i) => i.manifest.privacy.handles_personal_data);

export async function eraseContactEverywhere(
  env: Env,
  tenantId: string,
  contactId: string,
  nowMs: number,
): Promise<{ facts: ContactPrivacyFacts; apps: string[]; request_id: string }> {
  const facts = await tenantOp<ContactPrivacyFacts>(env, tenantId, 'contacts.erase', { contactId });
  const requestId = `prv_${crypto.randomUUID()}`;
  const apps: string[] = [];
  for (const install of await personalDataInstalls(env, tenantId)) {
    // The event is the reliable path (retries, replay); the endpoint gets an immediate copy.
    await sendAppEvent(env, install, 'privacy.erasure_requested', { request_id: requestId, ...facts }, nowMs);
    const endpoint = install.manifest.privacy.erasure_endpoint;
    if (endpoint !== undefined) {
      await callApp(env, install, endpoint, { request_id: requestId, ...facts }, { kind: 'hook', timeoutMs: 5000 });
    }
    apps.push(install.appId);
  }
  return { facts, apps, request_id: requestId };
}

export interface AppDataExport {
  readonly app_id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly data: unknown;
  readonly error: string | null;
}

export async function collectAppData(
  env: Env,
  tenantId: string,
  contactId: string,
  nowMs: number,
): Promise<{ stored: unknown; apps: AppDataExport[]; request_id: string }> {
  const facts = await tenantOp<ContactPrivacyFacts>(env, tenantId, 'apps.privacy.facts', { contactId });
  const stored = await tenantOp(env, tenantId, 'apps.entity.get', { entity: 'contact', entityId: contactId });
  const requestId = `prv_${crypto.randomUUID()}`;
  const installs = await personalDataInstalls(env, tenantId);
  const apps = await Promise.all(
    installs.map(async (install): Promise<AppDataExport> => {
      await sendAppEvent(env, install, 'privacy.data_requested', { request_id: requestId, ...facts }, nowMs);
      const endpoint = install.manifest.privacy.data_request_endpoint;
      if (endpoint === undefined) return { app_id: install.appId, name: install.manifest.name, ok: true, data: null, error: null };
      const result = await callApp(env, install, endpoint, { request_id: requestId, ...facts }, { kind: 'hook', timeoutMs: 8000 });
      return {
        app_id: install.appId,
        name: install.manifest.name,
        ok: result.ok,
        data: result.ok ? result.body : null,
        error: result.error,
      };
    }),
  );
  return { stored, apps, request_id: requestId };
}
