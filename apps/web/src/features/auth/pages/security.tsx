import { LOCALES, THEMES, type Locale, type Theme } from '@amable/i18n';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { isStepUpRequired } from '../../../lib/step-up';
import { authApi, currentLocale, errorMessage, useT, type ChallengeState } from '../api';
import { Button, Field, Notice, RecoveryCodes } from '../components';
import { SecondFactorForm } from './challenge';

type MfaMethod = 'totp' | 'email' | null;

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
  const [email, setEmail] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>(null);
  const [enrollment, setEnrollment] = useState<ChallengeState | null>(null);

  const load = useCallback(() => {
    authApi<{ sessions: DeviceSession[] }>('/api/me/sessions')
      .then((body) => setSessions(body.sessions))
      .catch((err: unknown) => setError(errorMessage(t, err)));
    authApi<{ user: { theme: string; email: string }; mfa: { method: MfaMethod } }>('/api/me')
      .then((body) => {
        setTheme((THEMES as readonly string[]).includes(body.user.theme) ? (body.user.theme as Theme) : 'system');
        setEmail(body.user.email);
        setMfaMethod(body.mfa.method);
      })
      .catch(() => undefined);
  }, [t]);

  useEffect(load, [load]);

  async function revoke(id: string) {
    await authApi(`/api/me/sessions/${id}`, { method: 'DELETE' });
    load();
  }

  async function revokeOthers() {
    setError('');
    try {
      await authApi('/api/me/sessions/revoke-others', { body: {} });
      setMessage(t('auth.security.revokedOthers'));
      load();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function changeEmail(event: FormEvent) {
    event.preventDefault();
    setError('');
    await run(async () => {
      await authApi('/api/me/email', { body: { newEmail } });
      setMessage(t('auth.security.emailSent', { email: newEmail.trim() }));
      setNewEmail('');
    }).catch((err: unknown) => setError(errorMessage(t, err)));
  }

  async function startMfaChange() {
    setError('');
    setMessage('');
    await run(async () => {
      setEnrollment(await authApi<ChallengeState>('/api/me/2fa/start', { body: {} }));
    }).catch((err: unknown) => setError(errorMessage(t, err)));
  }

  function mfaChanged(body: Record<string, unknown>) {
    setEnrollment(null);
    const recovery = body.recoveryCodes;
    if (Array.isArray(recovery) && recovery.length > 0) setCodes(recovery as string[]);
    setMessage(t('auth.security.mfaChanged'));
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
        {sessions.some((s) => !s.current) && (
          <Button variant="ghost" onClick={() => void revokeOthers()}>
            {t('auth.security.revokeOthers')}
          </Button>
        )}
      </Section>

      <Section title={t('auth.security.changeEmail')}>
        <p className="text-sm text-muted-foreground">{t('auth.security.emailCurrent', { email })}</p>
        <form className="space-y-3" onSubmit={(e) => void changeEmail(e)}>
          <Field
            label={t('auth.security.newEmail')}
            type="email"
            autoComplete="email"
            maxLength={320}
            required
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('auth.security.emailHint')}</p>
          <Button type="submit">{t('auth.security.sendConfirmation')}</Button>
        </form>
      </Section>

      <Section title={t('auth.security.mfa')}>
        {enrollment === null ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t('auth.security.mfaCurrent', {
                method: mfaMethod === 'totp' ? t('auth.enroll.totp') : mfaMethod === 'email' ? t('auth.enroll.email') : '—',
              })}
            </p>
            <p className="text-xs text-muted-foreground">{t('auth.security.mfaHint')}</p>
            <Button onClick={() => void startMfaChange()}>{t('auth.security.changeMfa')}</Button>
          </>
        ) : (
          <>
            <SecondFactorForm
              state={enrollment}
              basePath="/api/me/2fa"
              onVerified={mfaChanged}
              onCancelled={() => setEnrollment(null)}
            />
            <Button variant="ghost" onClick={() => setEnrollment(null)}>
              {t('common.cancel')}
            </Button>
          </>
        )}
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
