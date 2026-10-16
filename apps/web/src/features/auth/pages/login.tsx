import { useCallback, useState, type FormEvent } from 'react';
import { AuthApiError, authApi, errorMessage, useT } from '../api';
import { AuthCard, Button, Field, Notice, Turnstile } from '../components';

/** /login — email + password, or magic link. 2FA always follows (see ChallengePage). */
export function LoginPage() {
  const t = useT();
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [needsTurnstile, setNeedsTurnstile] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const onToken = useCallback((token: string) => setTurnstileToken(token), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setInfo('');
    try {
      if (mode === 'magic') {
        await authApi('/api/auth/magic-link', { body: { email, turnstileToken } });
        setInfo(t('auth.magic.sent'));
      } else {
        await authApi('/api/auth/login', { body: { email, password, turnstileToken } });
        window.location.assign('/auth/challenge');
      }
    } catch (err) {
      if (err instanceof AuthApiError && (err.code === 'turnstile_required' || err.body.turnstileRequired === true)) {
        setNeedsTurnstile(true);
      }
      setError(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={t('auth.login.title')}>
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        <Field
          label={t('auth.login.email')}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {mode === 'password' && (
          <Field
            label={t('auth.login.password')}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
        {(needsTurnstile || mode === 'magic') && <Turnstile onToken={onToken} />}
        <Notice tone="error">{error}</Notice>
        <Notice>{info}</Notice>
        <Button type="submit" disabled={busy}>
          {mode === 'password' ? t('auth.login.submit') : t('auth.login.magicLink')}
        </Button>
      </form>
      <div className="space-y-1">
        <Button variant="ghost" onClick={() => setMode(mode === 'password' ? 'magic' : 'password')}>
          {mode === 'password' ? t('auth.login.magicLink') : t('auth.login.usePassword')}
        </Button>
        <Button variant="ghost" onClick={() => window.location.assign('/auth/forgot')}>
          {t('auth.login.forgot')}
        </Button>
      </div>
    </AuthCard>
  );
}
