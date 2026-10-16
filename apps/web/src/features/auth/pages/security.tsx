import { LOCALES, THEMES, type Locale, type Theme } from '@amable/i18n';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { isStepUpRequired } from '../../../lib/step-up';
import { authApi, currentLocale, errorMessage, useT } from '../api';
import { Button, Field, Notice, RecoveryCodes } from '../components';

interface DeviceSession {
  id: string;
  device: string | null;
  country: string | null;
  lastSeenAt: number;
  current: boolean;
}

/**
 * Sensitive actions (valid 5 minutes server-side after a step-up): the
 * app-wide step-up dialog replays them, so a `step_up_required` that still
 * reaches here means the user closed that dialog.
 */
async function run(action: () => Promise<void>) {
  try {
    await action();
  } catch (err) {
    if (!isStepUpRequired(err)) throw err;
  }
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** /account/security — devices, password, recovery codes, language and theme. */
export function SecurityPage() {
  const t = useT();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [locale, setLocale] = useState<Locale>(currentLocale());
  const [theme, setTheme] = useState<Theme>('system');

  const load = useCallback(() => {
    authApi<{ sessions: DeviceSession[] }>('/api/me/sessions')
      .then((body) => setSessions(body.sessions))
      .catch((err: unknown) => setError(errorMessage(t, err)));
    authApi<{ user: { theme: string } }>('/api/me')
      .then((body) => setTheme((THEMES as readonly string[]).includes(body.user.theme) ? (body.user.theme as Theme) : 'system'))
      .catch(() => undefined);
  }, [t]);

  useEffect(load, [load]);

  async function revoke(id: string) {
    await authApi(`/api/me/sessions/${id}`, { method: 'DELETE' });
    load();
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError('');
    await run(async () => {
      await authApi('/api/me/password', { body: { currentPassword, newPassword } });
      setMessage(t('auth.reset.done'));
      setCurrentPassword('');
      setNewPassword('');
    }).catch((err: unknown) => setError(errorMessage(t, err)));
  }

  async function regenerate() {
    setError('');
    await run(async () => {
      const body = await authApi<{ recoveryCodes: string[] }>('/api/me/2fa/recovery-codes', { body: {} });
      setCodes(body.recoveryCodes);
    }).catch((err: unknown) => setError(errorMessage(t, err)));
  }

  async function savePrefs(next: { locale?: Locale; theme?: Theme }) {
    await authApi('/api/me/preferences', { method: 'PATCH', body: next });
    // The document language/theme are injected server-side: reload to apply everywhere.
    window.location.reload();
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6 text-foreground">
      <h1 className="text-xl font-semibold">{t('auth.security.title')}</h1>
      <Notice tone="error">{error}</Notice>
      <Notice>{message}</Notice>
      <Section title={t('auth.security.devices')}>
        <ul className="divide-y divide-border">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <div>
                <p className="font-medium">
                  {s.device ?? '—'} {s.country !== null ? `· ${s.country}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">
                  {s.current
                    ? t('auth.security.current')
                    : t('auth.security.lastSeen', { time: new Date(s.lastSeenAt).toLocaleString(locale) })}
                </p>
              </div>
              {!s.current && (
                <button className="text-xs text-red-600 hover:underline" onClick={() => void revoke(s.id)}>
                  {t('auth.security.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('auth.security.changePassword')}>
        <form className="space-y-3" onSubmit={(e) => void changePassword(e)}>
          <Field
            label={t('auth.security.currentPassword')}
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Field
            label={t('auth.reset.newPassword')}
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Button type="submit">{t('common.save')}</Button>
        </form>
      </Section>

      <Section title={t('auth.enroll.recoveryTitle')}>
        {codes === null ? (
          <Button onClick={() => void regenerate()}>{t('auth.security.regenerateCodes')}</Button>
        ) : (
          <RecoveryCodes codes={codes} doneLabel={t('auth.enroll.done')} onDone={() => setCodes(null)} />
        )}
      </Section>

      <Section title={`${t('prefs.language')} · ${t('prefs.theme')}`}>
        <div className="flex flex-wrap gap-4 text-sm">
          <select
            className="rounded-md border border-border bg-background px-2 py-1"
            value={locale}
            onChange={(e) => {
              const next = e.target.value as Locale;
              setLocale(next);
              void savePrefs({ locale: next });
            }}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {l === 'en' ? 'English' : 'Italiano'}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-border bg-background px-2 py-1"
            value={theme}
            onChange={(e) => {
              const next = e.target.value as Theme;
              setTheme(next);
              void savePrefs({ theme: next });
            }}
          >
            {THEMES.map((th) => (
              <option key={th} value={th}>
                {t(`prefs.theme.${th}`)}
              </option>
            ))}
          </select>
        </div>
      </Section>

      <Button variant="ghost" onClick={() => void authApi('/api/auth/logout', { body: {} }).then(() => window.location.assign('/login'))}>
        {t('auth.logout')}
      </Button>
    </main>
  );
}
