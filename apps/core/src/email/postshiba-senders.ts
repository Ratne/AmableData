import type { PostShibaSenderStore, PostShibaWorkspace } from '@amable/core';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';

/**
 * Sending credentials of each workspace's PostShiba tenant, AES-GCM in
 * `installation_meta` (`postshiba_sender:<providerTenantId>`, associated data
 * = the key). `postshiba_tenant:<workspaceId>` maps a workspace to its tenant.
 */

const senderKey = (providerTenantId: string) => `postshiba_sender:${providerTenantId}`;
export const workspaceTenantKey = (workspaceId: string) => `postshiba_tenant:${workspaceId}`;

export function postshibaSenderStore(env: Env): PostShibaSenderStore {
  return {
    async get(providerTenantId) {
      const row = await env.DB.prepare(`SELECT value FROM installation_meta WHERE key = ?`)
        .bind(senderKey(providerTenantId))
        .first<{ value: string }>();
      if (row === null) return null;
      const box = (await getAuthServices(env)).secretBox;
      return JSON.parse(await box.decrypt(row.value, senderKey(providerTenantId))) as PostShibaWorkspace;
    },
    async put(workspaceId, workspace) {
      const key = senderKey(workspace.providerTenantId);
      const sealed = await (await getAuthServices(env)).secretBox.encrypt(JSON.stringify(workspace), key);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO installation_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(
          key,
          sealed,
        ),
        env.DB.prepare(`INSERT OR IGNORE INTO installation_meta (key, value) VALUES (?, ?)`).bind(
          workspaceTenantKey(workspaceId),
          workspace.providerTenantId,
        ),
      ]);
    },
  };
}

/** Signing secret of a workspace's delivery webhook, null before its sender exists. */
export async function workspaceWebhookSecret(env: Env, workspaceId: string): Promise<string | null> {
  const tenant = await env.DB.prepare(`SELECT value FROM installation_meta WHERE key = ?`)
    .bind(workspaceTenantKey(workspaceId))
    .first<{ value: string }>();
  if (tenant === null) return null;
  return (await postshibaSenderStore(env).get(tenant.value))?.webhookSecret ?? null;
}
