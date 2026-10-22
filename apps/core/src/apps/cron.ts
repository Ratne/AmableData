import type { Env } from '../env';
import { refreshPrivateInstalls, runCatalogSync } from './catalog-sync';
import { releaseUnusedDeployments } from './deployer';
import { finalizeUninstalls } from './lifecycle';
import { pruneAppMetrics } from './metrics';

const ASSERTION_GRACE_MS = 60_000;

/** Cron step of the apps module; each part fails on its own without stopping the others. */
export async function runAppsCron(env: Env, nowMs: number): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['catalog sync', () => runCatalogSync(env, nowMs)],
    ['private manifests refresh', () => refreshPrivateInstalls(env, nowMs)],
    ['uninstall cleanup', () => finalizeUninstalls(env, nowMs)],
    ['unused app deployments', () => releaseUnusedDeployments(env, nowMs)],
    ['metrics retention', () => pruneAppMetrics(env.DB, nowMs)],
    [
      'oauth cleanup',
      () =>
        env.DB.batch([
          env.DB.prepare(`DELETE FROM app_oauth_codes WHERE expires_at < ?`).bind(nowMs - ASSERTION_GRACE_MS),
          env.DB.prepare(`DELETE FROM app_assertions WHERE expires_at < ?`).bind(nowMs - ASSERTION_GRACE_MS),
          env.DB.prepare(`DELETE FROM app_tokens WHERE expires_at < ? OR revoked_at < ?`).bind(
            nowMs - 7 * 86_400_000,
            nowMs - 7 * 86_400_000,
          ),
          env.DB.prepare(`DELETE FROM app_hook_cache WHERE expires_at < ?`).bind(nowMs),
        ]),
    ],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      console.error(`[apps] ${name} failed:`, error instanceof Error ? error.message : error);
    }
  }
}
