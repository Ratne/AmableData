import { appConnectorConfigSchema, type AppConnectorConfig, type ConnectorInfo } from '@amable/api-types';
import { validateAppInput, type AppInputSchema } from '@amable/core/apps';
import { callApp } from '../../apps/call';
import { tenantInstalls, type AppInstall } from '../../apps/store';
import type { Env } from '../../env';
import { webhookPayload } from './webhook';
import { failure, transient, type Connector, type ConnectorContext } from './types';
import { zodConfig } from './merge';

const APP_CONNECTOR_TIMEOUT_MS = 15_000;

type FormConnectorDef = NonNullable<AppInstall['manifest']['extensions']['form_connectors']>[number];

function findConnector(installs: readonly AppInstall[], appId: string, key: string) {
  const install = installs.find((i) => i.appId === appId && (i.status === 'active' || i.status === 'paused'));
  const def = install?.manifest.extensions.form_connectors?.find((c) => c.key === key);
  return install === undefined || def === undefined ? null : { install, def };
}

/** Settings problems (`config.settings.<key>`) of an app connection; checked on create/update. */
export async function appConnectorIssues(
  env: Env,
  tenantId: string,
  config: AppConnectorConfig,
): Promise<Array<{ path: string; message: string }>> {
  const found = findConnector(await tenantInstalls(env.DB, tenantId), config.app_id, config.key);
  if (found === null) return [{ path: 'config.key', message: 'this app or connector is not installed' }];
  const schema: AppInputSchema = found.def.settings_schema ?? { type: 'object', properties: {} };
  return validateAppInput(schema, config.settings).map((issue) => ({
    path: `config.settings.${issue.key}`,
    message: issue.code,
  }));
}

/** One catalog entry per connector of every running app of the tenant. */
export async function appConnectorCatalog(env: Env, tenantId: string): Promise<ConnectorInfo[]> {
  const installs = await tenantInstalls(env.DB, tenantId);
  return installs
    .filter((i) => i.status === 'active' || i.status === 'paused')
    .flatMap((install) =>
      (install.manifest.extensions.form_connectors ?? []).map((def: FormConnectorDef) => ({
        type: 'app' as const,
        secret: 'none' as const,
        oauth_provider: null,
        available: install.status === 'active',
        app: {
          app_id: install.appId,
          key: def.key,
          app_name: install.manifest.name,
          name: def.name,
          icon_url: install.manifest.icon_url,
          description: def.description ?? null,
          settings_schema: (def.settings_schema as Record<string, unknown> | undefined) ?? null,
          paused: install.status === 'paused',
        },
      })),
    );
}

/**
 * Sends the submission to the app's connector endpoint, signed like every app
 * call. The app answers 2xx when it took it; 5xx/429 are retried. A paused or
 * uninstalled app skips the delivery instead of failing the form.
 */
export const appConnector: Connector<AppConnectorConfig> = {
  type: 'app',
  secret: 'none',
  oauthProvider: null,
  available: () => true,
  parseConfig: zodConfig(appConnectorConfigSchema),
  async run(ctx: ConnectorContext<AppConnectorConfig>) {
    const config = ctx.connection.config;
    const request = `app ${config.app_id}/${config.key}`;
    const found = findConnector(await tenantInstalls(ctx.env.DB, ctx.tenantId), config.app_id, config.key);
    if (found === null || found.install.status !== 'active') {
      return { status: 'skipped', retryable: false, statusCode: null, request, response: found === null ? 'app not installed' : 'app paused' };
    }
    if (!found.install.scopes.includes('forms:submissions_read')) {
      return failure('the app was not granted forms:submissions_read', false, request);
    }
    const result = await callApp(
      ctx.env,
      found.install,
      found.def.endpoint,
      { connector: config.key, settings: config.settings, ...webhookPayload(ctx as unknown as Parameters<typeof webhookPayload>[0]) },
      { kind: 'connector', timeoutMs: APP_CONNECTOR_TIMEOUT_MS, idempotencyKey: `${ctx.submission.id}:${ctx.connection.id}` },
    );
    const response = typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? result.error ?? '');
    if (result.status === 0) return failure(result.error ?? 'app unreachable', true, request);
    if (result.ok) return { status: 'success', retryable: false, statusCode: result.status, request, response: response.slice(0, 1000) };
    return { status: 'failed', retryable: transient(result.status), statusCode: result.status, request, response: response.slice(0, 1000) };
  },
};
