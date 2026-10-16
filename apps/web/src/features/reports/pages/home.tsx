import { PageBody, usePageChrome } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { Link } from '@tanstack/react-router';
import { useI18n } from '../../../i18n';
import { useHomeDashboard, useReportApi, useReportPermissions } from '../api/hooks';
import { DashboardView } from '../components/dashboard-view';

/** Tenant home page: the default shared dashboard, or the built-in one the server packs for the member. */
export function HomeDashboardPage() {
  const { t } = useI18n();
  usePageChrome({ title: t('rep.home.title') });
  const { slug } = useReportApi();
  const perms = useReportPermissions();
  const home = useHomeDashboard(perms.ready && perms.canRead);

  if (perms.ready && !perms.canRead)
    return (
      <PageBody className="pt-10 text-center text-sm text-muted-foreground">
        {t('rep.forbidden')}
      </PageBody>
    );
  return (
    <PageBody className="pt-4">
      {!perms.ready || home.isPending ? (
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
          <Skeleton className="h-72 md:col-span-4" />
        </div>
      ) : home.isError ? (
        <p className="pt-10 text-center text-sm text-muted-foreground">{t('rep.widget.error')}</p>
      ) : (
        <DashboardView
          dashboard={home.data}
          leading={
            <Link
              to="/t/$tenant/reports/dashboards"
              params={{ tenant: slug }}
              className="sr-only focus:not-sr-only"
            >
              {t('rep.dash.manage')}
            </Link>
          }
        />
      )}
    </PageBody>
  );
}
