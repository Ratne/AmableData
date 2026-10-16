import { LOCALES, type Locale } from '@amable/i18n';
import {
  DashboardButton,
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuLabel,
  DashboardMenuRadioGroup,
  DashboardMenuRadioItem,
  DashboardMenuSeparator,
  DashboardMenuTrigger,
  isThemePreference,
  THEME_PREFERENCES,
  useTheme,
} from '@amable/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronsUpDown, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { useI18n } from '../i18n';
import { signOut, switchTenant, type MeResponse } from '../lib/api';

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', it: 'Italiano' };

/** Header slot: active workspace and the memberships to switch to. */
export function TenantSwitcher({
  me,
  tenantSlug,
}: {
  me: MeResponse | null | undefined;
  tenantSlug: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const memberships = me?.memberships ?? [];
  const current = memberships.find((membership) => membership.slug === tenantSlug);

  return (
    <DashboardMenu>
      <DashboardMenuTrigger asChild>
        <DashboardButton
          variant="secondary"
          size="sm"
          aria-label={t('shell.tenantSwitcher')}
          disabled={memberships.length === 0}
        >
          <span className="max-w-40 truncate">{current?.name ?? tenantSlug}</span>
          <ChevronsUpDown aria-hidden />
        </DashboardButton>
      </DashboardMenuTrigger>
      <DashboardMenuContent align="end" className="min-w-56">
        <DashboardMenuLabel>{t('shell.tenants')}</DashboardMenuLabel>
        <DashboardMenuRadioGroup
          value={tenantSlug}
          onValueChange={(slug) => {
            void switchTenant(slug)
              .catch(() => `/t/${slug}`)
              .then((path) => navigate({ to: `${path}/dashboard` }));
          }}
        >
          {memberships.map((membership) => (
            <DashboardMenuRadioItem key={membership.slug} value={membership.slug}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">{membership.name}</span>
                <span className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">
                  {t(`roles.${membership.role}`)}
                </span>
              </span>
            </DashboardMenuRadioItem>
          ))}
        </DashboardMenuRadioGroup>
      </DashboardMenuContent>
    </DashboardMenu>
  );
}

/** Header slot: account, language and theme (persisted on the user), sign out. */
export function UserMenu({ me }: { me: MeResponse | null | undefined }) {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = me?.user;

  return (
    <DashboardMenu>
      <DashboardMenuTrigger asChild>
        <DashboardButton variant="secondary" size="icon" aria-label={t('shell.userMenu')}>
          <UserRound aria-hidden />
        </DashboardButton>
      </DashboardMenuTrigger>
      <DashboardMenuContent align="end" className="min-w-56">
        <DashboardMenuLabel>
          {user ? (
            <span className="flex flex-col gap-0.5">
              <span className="truncate text-sm text-(--obsidian-dashboard-shell-foreground)">
                {user.name ?? user.email}
              </span>
              {user.name ? <span className="truncate">{user.email}</span> : null}
            </span>
          ) : (
            t('shell.notSignedIn')
          )}
        </DashboardMenuLabel>
        <DashboardMenuSeparator />
        <DashboardMenuLabel>{t('prefs.language')}</DashboardMenuLabel>
        <DashboardMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            const next = LOCALES.find((candidate) => candidate === value);
            if (!next) return;
            setLocale(next);
          }}
        >
          {LOCALES.map((candidate) => (
            <DashboardMenuRadioItem key={candidate} value={candidate}>
              {LANGUAGE_NAMES[candidate]}
            </DashboardMenuRadioItem>
          ))}
        </DashboardMenuRadioGroup>
        <DashboardMenuSeparator />
        <DashboardMenuLabel>{t('prefs.theme')}</DashboardMenuLabel>
        <DashboardMenuRadioGroup
          value={theme}
          onValueChange={(value) => isThemePreference(value) && setTheme(value)}
        >
          {THEME_PREFERENCES.map((candidate) => (
            <DashboardMenuRadioItem key={candidate} value={candidate}>
              {t(`prefs.theme.${candidate}`)}
            </DashboardMenuRadioItem>
          ))}
        </DashboardMenuRadioGroup>
        {user ? (
          <>
            <DashboardMenuSeparator />
            <DashboardMenuItem onSelect={() => void navigate({ to: '/account/security' })}>
              <ShieldCheck aria-hidden />
              {t('auth.security.title')}
            </DashboardMenuItem>
            <DashboardMenuItem
              onSelect={() => {
                void signOut().then(() => {
                  queryClient.clear();
                  void navigate({ to: '/' });
                });
              }}
            >
              <LogOut aria-hidden />
              {t('auth.logout')}
            </DashboardMenuItem>
          </>
        ) : null}
      </DashboardMenuContent>
    </DashboardMenu>
  );
}
