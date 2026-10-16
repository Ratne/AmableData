import { createRootRoute, Link, Outlet } from '@tanstack/react-router';
import { useI18n } from '../i18n';

function NotFound() {
  const { t } = useI18n();
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
      <p className="text-sm font-medium">{t('page.notFound')}</p>
      <Link to="/" className="text-xs text-primary underline">
        {t('page.backHome')}
      </Link>
    </main>
  );
}

/**
 * Root of the route tree. Feature modules attach to it (auth) or to
 * `tenantRoute` (everything inside a workspace) with `getParentRoute`.
 */
export const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
});
