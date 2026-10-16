import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { authApi, errorMessage, takeFragmentToken, useT } from '../api';
import { AuthCard, Button, Field, Notice, Turnstile } from '../components';

/** /auth/magic#token=… — consumes the magic link (first factor), then the 2FA challenge. */
export function MagicLinkPage() {
  const t = useT();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeFragmentToken();
    if (token === null) {
      setError(t('auth.magic.invalid'));
      return;
    }
    authApi('/api/auth/magic-link/consume', { body: { token } })
      .then(() => window.location.assign('/auth/challenge'))
      .catch(() => setError(t('auth.magic.invalid')));
  }, [t]);

  return (
    <AuthCard title={t('auth.login.title')}>
      {error === '' ? (
        <p className="text-sm text-muted-foreground">{t('auth.magic.consuming')}</p>
      ) : (
        <div className="space-y-4">
          <Notice tone="error">{error}</Notice>
          <Button onClick={() => window.location.assign('/login')}>{t('common.back')}</Button>
        </div>
      )}
    </AuthCard>
  );
}

/** /auth/forgot — always the same answer, whether the account exists or not. */
export function ForgotPasswordPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const onToken = useCallback((token: string) => setTurnstileToken(token), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await authApi('/api/auth/password/forgot', { body: { email, turnstileToken } });
      setSent(true);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <AuthCard title={t('auth.forgot.title')}>
      {sent ? (
        <Notice>{t('auth.forgot.sent')}</Notice>
      ) : (
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <p className="text-sm text-muted-foreground">{t('auth.forgot.intro')}</p>
          <Field label={t('auth.login.email')} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Turnstile onToken={onToken} />
          <Notice tone="error">{error}</Notice>
          <Button type="submit">{t('auth.forgot.submit')}</Button>
        </form>
      )}
      <Button variant="ghost" onClick={() => window.location.assign('/login')}>
        {t('common.back')}
      </Button>
    </AuthCard>
  );
}

/** /auth/reset#token=… — new password; the token is single-use and valid for 1 hour. */
export function ResetPasswordPage() {
  const t = useT();
  const [token] = useState(() => takeFragmentToken());
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState(token === null ? t('auth.reset.invalid') : '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (token === null) return;
    setError('');
    try {
      await authApi('/api/auth/password/reset', { body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <AuthCard title={t('auth.reset.title')}>
      {done ? (
        <div className="space-y-4">
          <Notice>{t('auth.reset.done')}</Notice>
          <Button onClick={() => window.location.assign('/login')}>{t('auth.login.submit')}</Button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <Field
            label={t('auth.reset.newPassword')}
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Notice tone="error">{error}</Notice>
          <Button type="submit" disabled={token === null}>
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

/** /auth/email#token=… — confirms an email change requested from the security settings. */
export function EmailConfirmPage() {
  const t = useT();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeFragmentToken();
    if (token === null) {
      setState('error');
      return;
    }
    authApi('/api/auth/email/confirm', { body: { token } })
      .then(() => setState('done'))
      .catch(() => setState('error'));
  }, []);

  return (
    <AuthCard title={t('auth.login.title')}>
      {state === 'working' && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {state === 'error' && <Notice tone="error">{t('auth.reset.invalid')}</Notice>}
      {state !== 'working' && <Button onClick={() => window.location.assign('/login')}>{t('auth.login.submit')}</Button>}
    </AuthCard>
  );
}
