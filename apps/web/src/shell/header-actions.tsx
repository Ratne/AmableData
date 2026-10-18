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
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronsUpDown, LogOut, Plus, ShieldCheck, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { ApiError, apiFetch, signOut, switchTenant, type MeResponse } from '../lib/api';
import { isStepUpRequired } from '../lib/step-up';

const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', it: 'Italiano' };

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

function NewWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugEdited ? slug : slugify(name);
  const valid = name.trim() !== '' && effectiveSlug.length >= 2 && SLUG_PATTERN.test(effectiveSlug);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/tenants', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), slug: effectiveSlug }),
      });
      const path = await switchTenant(effectiveSlug).catch(() => `/t/${effectiveSlug}`);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      onOpenChange(false);
      void navigate({ to: `${path}/dashboard` });
    } catch (err) {
      if (isStepUpRequired(err)) return;
      setError(
        err instanceof ApiError && err.code === 'slug_taken'
          ? t('shell.newTenant.slugTaken')
          : err instanceof ApiError && err.code === 'forbidden'
            ? t('shell.newTenant.forbidden')
            : t('common.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{t('shell.newTenant.title')}</DialogTitle>
            <DialogDescription>{t('shell.newTenant.body')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-tenant-name">{t('shell.newTenant.name')}</Label>
            <Input
              id="new-tenant-name"
              value={name}
              maxLength={120}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-tenant-slug">{t('shell.newTenant.slug')}</Label>
            <Input
              id="new-tenant-slug"
              value={effectiveSlug}
              maxLength={64}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('shell.newTenant.slugHint', { path: `/t/${effectiveSlug || '…'}` })}
            </p>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {t('shell.newTenant.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

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
  const canCreate = memberships.some((membership) => membership.role === 'owner');
  const [creating, setCreating] = useState(false);

  return (
    <>
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
          {canCreate ? (
            <>
              <DashboardMenuSeparator />
              <DashboardMenuItem onSelect={() => setCreating(true)}>
                <Plus aria-hidden />
                {t('shell.newTenant.title')}
              </DashboardMenuItem>
            </>
          ) : null}
        </DashboardMenuContent>
      </DashboardMenu>
      {creating ? <NewWorkspaceDialog open onOpenChange={setCreating} /> : null}
    </>
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
