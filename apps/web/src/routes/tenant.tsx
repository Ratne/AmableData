import { AppShell, useTenantBranding, type DashboardShellNavSection } from '@amable/ui';
import { createRoute, Outlet, useMatches, useParams, useRouterState } from '@tanstack/react-router';
import { useMemo } from 'react';
import { EmailLiquidHelperProvider } from '../features/email/liquid/provider';
import { GlobalSearch } from '../features/search/command-palette';
import { SupportSessionBanner } from '../features/support/banner';
import { UpdateBanner } from '../features/updates/banner';
import { useWorkspaceProfile } from '../features/workspace/api';
import { useI18n } from '../i18n';
import { useMe } from '../lib/api';
import {
  ALL_MODULES,
  DEV_MODULES,
  NAV_GROUPS,
  SECONDARY_MODULES,
  type ModuleDef,
} from '../navigation';
import { TenantSwitcher, UserMenu } from '../shell/header-actions';
import { ShellLink } from '../shell/shell-link';
import { rootRoute } from './root';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Full-window page (e.g. the landing canvas editor): rendered without the app sidebar and header. */
    immersive?: boolean;
  }
}

function useActiveModuleId(tenant: string): string {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return useMemo(() => {
    const relative = pathname.slice(`/t/${tenant}/`.length);
    let best: ModuleDef | null = null;
    for (const module of [...ALL_MODULES, ...DEV_MODULES]) {
      const matches = relative === module.path || relative.startsWith(`${module.path}/`);
      if (matches && (best === null || module.path.length > best.path.length)) best = module;
    }
    return best?.id ?? '';
  }, [pathname, tenant]);
}

/** The workspace layout: Dashboard Shell with the module navigation, workspace switcher and user menu. */
function TenantLayout() {
  const { tenant } = useParams({ from: tenantRoute.id });
  const { t } = useI18n();
  const me = useMe();
  const membership = me.data?.memberships.find((candidate) => candidate.slug === tenant);
  // Until the session is known (or in UI-only dev without the API) everything is shown; the server enforces access anyway.
  const allowed = (module: ModuleDef) =>
    !module.permission || !membership || membership.permissions.includes(module.permission);
  const profile = useWorkspaceProfile(tenant);
  const branding = useTenantBranding({
    name: profile.data?.name ?? membership?.name ?? tenant,
    logoUrl: profile.data?.logo_url ?? null,
    primaryColor: profile.data?.primary_color ?? null,
  });
  const activeItemId = useActiveModuleId(tenant);
  const immersive = useMatches({ select: (matches) => matches.some((m) => m.staticData.immersive === true) });

  const toItem = (module: ModuleDef) => ({
    id: module.id,
    label: t(module.labelKey),
    icon: module.icon,
    href: `/t/${tenant}/${module.path}`,
  });

  const navigation: DashboardShellNavSection[] = [
    ...NAV_GROUPS.map((group) => ({
      id: group.id,
      title: t(group.titleKey),
      items: group.modules.filter(allowed).map(toItem),
    })).filter((section) => section.items.length > 0),
    ...(import.meta.env.DEV ? [{ id: 'dev', title: 'Dev', items: DEV_MODULES.map(toItem) }] : []),
  ];

  if (immersive) {
    return (
      <div className="flex h-dvh flex-col bg-background text-foreground">
        <SupportSessionBanner tenant={tenant} />
        <Outlet />
      </div>
    );
  }

  return (
    <AppShell
      brand={{ name: branding.name, description: t('common.appName'), logo: branding.logo }}
      navigation={navigation}
      secondaryNavigation={SECONDARY_MODULES.map(toItem)}
      activeItemId={activeItemId}
      navigationLabel={t('nav.label')}
      linkComponent={ShellLink}
      headerActions={
        <>
          <GlobalSearch tenant={tenant} />
          <TenantSwitcher me={me.data} tenantSlug={tenant} />
          <UserMenu me={me.data} />
        </>
      }
    >
      <UpdateBanner />
      <SupportSessionBanner tenant={tenant} />
      <EmailLiquidHelperProvider>
        <Outlet />
      </EmailLiquidHelperProvider>
    </AppShell>
  );
}

export const tenantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/t/$tenant',
  component: TenantLayout,
});
