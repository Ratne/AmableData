import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useI18n } from '../../../i18n';
import { useMe } from '../../../lib/api';
import type { AuthorizeSearch } from '../search';

/**
 * /apps/authorize: entry point of an app-initiated install (the `authorization_endpoint`
 * of the discovery document). Picks the workspace, then hands over to the consent page.
 */
export function AuthorizeAppPage() {
  const { t } = useI18n();
  const me = useMe();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as AuthorizeSearch;
  const { app_id: appId, tenant, ...rest } = search;
  const eligible = (me.data?.memberships ?? []).filter((m) => m.permissions.includes('apps:install'));

  const open = (slug: string) => {
    if (appId === undefined) return;
    void navigate({ to: '/t/$tenant/settings/apps/$appId', params: { tenant: slug, appId }, search: rest });
  };

  useEffect(() => {
    if (me.isPending) return;
    if (me.data === null) {
      sessionStorage.setItem('amb_app_authorize', window.location.pathname + window.location.search);
      window.location.assign('/login');
      return;
    }
    const preselected = eligible.find((m) => m.slug === tenant) ?? (eligible.length === 1 ? eligible[0] : undefined);
    if (preselected !== undefined && appId !== undefined) open(preselected.slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.isPending, me.data]);

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t('apps.authorize.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {appId === undefined ? <p className="text-sm">{t('apps.authorize.invalid')}</p> : null}
          {appId !== undefined && !me.isPending && eligible.length === 0 ? (
            <p className="text-sm">{t('apps.authorize.noWorkspace')}</p>
          ) : null}
          {appId !== undefined && eligible.length > 1 ? (
            <>
              <p className="text-sm">{t('apps.authorize.pick', { app: appId })}</p>
              {eligible.map((m) => (
                <Button key={m.slug} variant="outline" className="justify-start" onClick={() => open(m.slug)}>
                  {m.name}
                </Button>
              ))}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
