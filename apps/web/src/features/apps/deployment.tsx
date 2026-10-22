import type { MessageKey } from '@amable/i18n';
import { toast } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { isStepUpRequired } from '../../lib/step-up';
import { apiErrorCode, useTenantAccess } from '../developers/api';
import { appKeys, useAppsApi, type AppDeploymentState } from './api';

/**
 * Apps of the catalog run in this installation's own Cloudflare account, never
 * on AmableData's: self-hosted owners connect a token (Workers + D1 edit), on
 * AmableData Cloud the token saved in the portal during onboarding is used.
 */

const TOKEN_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'd1', type: 'edit' },
];

/** Cloudflare's token editor with the two permissions already selected. */
export const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?${new URLSearchParams({
  permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
  name: 'AmableData apps',
}).toString()}`;

export const DEPLOY_ERRORS = new Set([
  'cloudflare_token_required',
  'cloudflare_token_invalid',
  'cloudflare_token_inactive',
  'cloudflare_permissions',
  'bundle_mismatch',
  'deployment_required',
  'deploy_failed',
  'managed_by_portal',
]);

/** Readable message for the deployment errors of the apps API. */
export function useDeployErrorText(): (error: unknown) => string {
  const { t } = useI18n();
  return (error) => {
    const code = apiErrorCode(error);
    return DEPLOY_ERRORS.has(code) ? t(`apps.deploy.error.${code}` as MessageKey) : t('apps.install.failed', { code });
  };
}

export function useCloudflareStatus() {
  const { slug, api } = useAppsApi();
  return useQuery({ queryKey: appKeys.cloudflare(slug), queryFn: api.cloudflare, staleTime: 30_000 });
}

/** Self-hosted owner: paste a token, pick the account, save it (encrypted in the installation). */
export function CloudflareConnect({ onConnected }: { onConnected?: () => void }) {
  const { t } = useI18n();
  const { slug, api } = useAppsApi();
  const client = useQueryClient();
  const errorText = useDeployErrorText();
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }> | null>(null);
  const [accountId, setAccountId] = useState('');
  const onError = (error: unknown) => {
    if (!isStepUpRequired(error)) toast.error(errorText(error));
  };
  const check = useMutation({
    mutationFn: () => api.cloudflareAccounts(token.trim()),
    onSuccess: (result) => {
      setAccounts(result.data);
      setAccountId(result.data[0]?.id ?? '');
    },
    onError,
  });
  const connect = useMutation({
    mutationFn: () => api.connectCloudflare(token.trim(), accountId),
    onSuccess: async () => {
      setToken('');
      setAccounts(null);
      await client.invalidateQueries({ queryKey: ['apps', slug] });
      toast.success(t('apps.cloudflare.connected'));
      onConnected?.();
    },
    onError,
  });
  const validToken = /^[A-Za-z0-9_-]{20,200}$/.test(token.trim());

  return (
    <div className="grid gap-3 text-sm">
      <ol className="grid list-decimal gap-1 pl-5">
        <li>
          <a href={CLOUDFLARE_TOKEN_URL} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline underline-offset-2">
            {t('apps.cloudflare.step.open')}
            <ExternalLink className="size-3" />
          </a>
        </li>
        <li>{t('apps.cloudflare.step.permissions')}</li>
        <li>{t('apps.cloudflare.step.paste')}</li>
      </ol>
      <div className="grid gap-1">
        <Label htmlFor="cloudflare-token">{t('apps.cloudflare.token')}</Label>
        <Input
          id="cloudflare-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setAccounts(null);
          }}
        />
      </div>
      {accounts === null ? (
        <Button className="justify-self-start" disabled={!validToken || check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? t('apps.cloudflare.checking') : t('apps.cloudflare.check')}
        </Button>
      ) : accounts.length === 0 ? (
        <p className="text-destructive">{t('apps.cloudflare.noAccounts')}</p>
      ) : (
        <>
          <p>{t('apps.cloudflare.pickAccount')}</p>
          <RadioGroup value={accountId} onValueChange={setAccountId} className="grid gap-2">
            {accounts.map((account) => (
              <label key={account.id} className="flex items-center gap-2">
                <RadioGroupItem value={account.id} />
                <span>
                  {account.name} <span className="font-mono text-xs text-(--obsidian-dashboard-shell-text-subtle)">{account.id}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
          <Button className="justify-self-start" disabled={accountId === '' || connect.isPending} onClick={() => connect.mutate()}>
            {t('apps.cloudflare.connect')}
          </Button>
        </>
      )}
    </div>
  );
}

/** What blocks a deployment before it starts (missing or dead token), or null. */
export function useDeployBlocker(): { message: string; connect: boolean } | null {
  const { t } = useI18n();
  const status = useCloudflareStatus();
  const access = useTenantAccess();
  if (status.data === undefined || status.data.provider !== 'direct') return null;
  const credentials = status.data.credentials;
  if (credentials !== null && credentials.status === 'active') return null;
  const owner = access.role === 'owner';
  const message =
    credentials === null
      ? t(owner ? 'apps.cloudflare.required' : 'apps.cloudflare.requiredAskOwner')
      : t(owner ? 'apps.cloudflare.invalid' : 'apps.cloudflare.invalidAskOwner');
  return { message, connect: owner };
}

const REACHABLE_POLL_MS = 3000;
const REACHABLE_ATTEMPTS = 20;

/**
 * Deploys the app (when the deployed version is not the catalog one), waits
 * for its workers.dev address to answer, then runs `then` (the consent).
 */
export function useDeployThen(appId: string, then: () => void) {
  const { slug, api } = useAppsApi();
  const client = useQueryClient();
  const errorText = useDeployErrorText();
  const [phase, setPhase] = useState<'idle' | 'deploying' | 'waiting'>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    try {
      let state: AppDeploymentState = await api.deployment(appId);
      if (!state.current) {
        setPhase('deploying');
        state = await api.deploy(appId);
      }
      setPhase('waiting');
      for (let attempt = 0; !(state.deployment?.reachable ?? false); attempt += 1) {
        if (attempt >= REACHABLE_ATTEMPTS) throw new Error('unreachable');
        await new Promise((resolve) => setTimeout(resolve, REACHABLE_POLL_MS));
        state = await api.deployment(appId);
      }
      client.setQueryData(appKeys.deployment(slug, appId), state);
      setPhase('idle');
      then();
    } catch (failure) {
      setPhase('idle');
      await client.invalidateQueries({ queryKey: appKeys.cloudflare(slug) });
      if (isStepUpRequired(failure)) return;
      setError(failure instanceof Error && failure.message === 'unreachable' ? 'unreachable' : errorText(failure));
    }
  };

  return { phase, error, run: () => void run(), busy: phase !== 'idle' };
}

/** Settings → Apps → Installed: where the apps run, and (self-hosted owner) the token. */
export function CloudflareAppsCard() {
  const { t, locale } = useI18n();
  const { slug, api } = useAppsApi();
  const client = useQueryClient();
  const status = useCloudflareStatus();
  const access = useTenantAccess();
  const errorText = useDeployErrorText();
  const [changing, setChanging] = useState(false);
  const disconnect = useMutation({
    mutationFn: api.disconnectCloudflare,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: appKeys.cloudflare(slug) });
      toast.success(t('apps.cloudflare.disconnected'));
    },
    onError: (error) => {
      if (!isStepUpRequired(error)) toast.error(errorText(error));
    },
  });
  if (status.data === undefined) return null;
  const owner = access.role === 'owner';
  const credentials = status.data.credentials;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('apps.cloudflare.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {status.data.provider === 'control_plane' ? (
          <p>{t('apps.cloudflare.managed')}</p>
        ) : (
          <>
            <p>{t('apps.cloudflare.selfHosted')}</p>
            {credentials !== null ? (
              <Alert variant={credentials.status === 'invalid' ? 'destructive' : 'default'}>
                <AlertTitle>{credentials.account_name ?? credentials.account_id}</AlertTitle>
                <AlertDescription>
                  {credentials.status === 'invalid'
                    ? t('apps.cloudflare.invalid')
                    : t('apps.cloudflare.connectedSince', {
                        hint: credentials.token_hint,
                        at: new Date(credentials.verified_at).toLocaleDateString(locale),
                      })}
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-(--obsidian-dashboard-shell-text-subtle)">{t('apps.cloudflare.none')}</p>
            )}
            {!owner ? <p className="text-(--obsidian-dashboard-shell-text-subtle)">{t('apps.cloudflare.ownerOnly')}</p> : null}
            {owner && (changing || credentials === null || credentials.status === 'invalid') ? (
              <CloudflareConnect onConnected={() => setChanging(false)} />
            ) : null}
            {owner && credentials !== null && !changing && credentials.status === 'active' ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
                  {t('apps.cloudflare.change')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disconnect.isPending}
                  onClick={() => {
                    if (window.confirm(t('apps.cloudflare.disconnectConfirm'))) disconnect.mutate();
                  }}
                >
                  {t('apps.cloudflare.disconnect')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
