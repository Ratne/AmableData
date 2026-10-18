import { toast } from '@amable/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { analyticsErrorMessage } from '../api';
import { funnelKeys, funnelsApi, slugFromAdsState, takeAdsOAuth } from '../api-funnels';
import { analyticsAdsOAuthRoute } from '../routes';

/**
 * `/oauth/ads/callback` — fixed redirect URI of the ad platforms. The slug is
 * the prefix of `state`; site and platform were stored when the flow started.
 * Completes the connection, then returns to the `ads` settings tab.
 */
export function AdsOAuthCallbackPage() {
  const { t } = useI18n();
  const search = useSearch({ from: analyticsAdsOAuthRoute.id });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const slug = search.state ? slugFromAdsState(search.state) : null;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const { state, code } = search;
    if (search.error) {
      setError(t('analytics.ads.oauth.denied'));
      return;
    }
    if (!state || !code || !slug) {
      setError(t('analytics.ads.oauth.invalid'));
      return;
    }
    const pending = takeAdsOAuth(state);
    if (!pending) {
      setError(t('analytics.ads.oauth.expired'));
      return;
    }
    funnelsApi(slug)
      .ads.callback(pending.site_id, pending.platform, { state, code })
      .then(async () => {
        toast.success(t('analytics.ads.connections.connected'));
        await queryClient.invalidateQueries({ queryKey: funnelKeys.ads(slug, pending.site_id) });
        await navigate({
          to: '/t/$tenant/analytics/settings',
          params: { tenant: slug },
          search: { site: pending.site_id, tab: 'ads' },
          replace: true,
        });
      })
      .catch((reason: unknown) => setError(analyticsErrorMessage(t, reason)));
  }, [search, slug, navigate, queryClient, t]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {error ? (
          <>
            <TriangleAlert className="size-6 text-destructive" aria-hidden />
            <h1 className="text-base font-semibold">{t('analytics.ads.oauth.failedTitle')}</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
            {slug ? (
              <Link
                to="/t/$tenant/analytics/settings"
                params={{ tenant: slug }}
                search={{ tab: 'ads' }}
                className="text-sm font-medium underline underline-offset-2"
              >
                {t('analytics.ads.oauth.back')}
              </Link>
            ) : null}
          </>
        ) : (
          <>
            <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">{t('analytics.ads.oauth.connecting')}</p>
          </>
        )}
      </div>
    </div>
  );
}
