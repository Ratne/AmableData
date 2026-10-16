import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { MessageKey } from '@amable/i18n';
import { AuthApiError, authApi, errorMessage, takeFragmentToken, useT } from '../api';
import { AuthCard, Button, Field, Notice, Turnstile } from '../components';

interface InvitePeek {
  tenant: { slug: string; name: string };
  email: string;
  role: string;
  inviter: string | null;
  accountExists: boolean;
}

/**
 * /invite#token=… — existing account: sign in as the invited address and
 * accept; new account: name + optional password, then mandatory 2FA setup.
 */
export function InvitePage() {
  const t = useT();
  const [token] = useState(() => takeFragmentToken() ?? sessionStorage.getItem('amb_invite_token'));
  const [invite, setInvite] = useState<InvitePeek | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [error, setError] = useState(token === null ? t('auth.invite.invalid') : '');
  const onToken = useCallback((value: string) => setTurnstileToken(value), []);

  useEffect(() => {
    if (token === null) return;
    // Keep the token for a sign-in round trip (fragment is scrubbed from the URL).
    sessionStorage.setItem('amb_invite_token', token);
    authApi<InvitePeek>('/api/invites/peek', { body: { token } })
      .then(setInvite)
      .catch((err: unknown) => setError(errorMessage(t, err)));
  }, [token, t]);

  async function accept(event?: FormEvent) {
    event?.preventDefault();
    if (token === null) return;
    setError('');
    try {
      const body: Record<string, unknown> = { token };
      if (invite?.accountExists === false) {
        if (name !== '') body.name = name;
        if (password !== '') body.password = password;
        body.turnstileToken = turnstileToken;
      }
      const result = await authApi<{ status: string; slug: string }>('/api/invites/accept', { body });
      sessionStorage.removeItem('amb_invite_token');
      window.location.assign(result.status === 'joined' ? `/t/${result.slug}` : '/auth/challenge');
    } catch (err) {
      if (err instanceof AuthApiError && err.code === 'login_required') {
        setError(t('auth.invite.signInFirst', { email: String(err.body.email) }));
        return;
      }
      setError(errorMessage(t, err));
    }
  }

  const roleLabel = invite === null ? '' : t(`roles.${invite.role}` as MessageKey);

  return (
    <AuthCard title={t('auth.invite.title', { tenant: invite?.tenant.name ?? '…' })}>
      {invite !== null && (
        <p className="text-sm text-muted-foreground">
          {t('auth.invite.intro', { inviter: invite.inviter ?? '—', tenant: invite.tenant.name, role: roleLabel })}
        </p>
      )}
      {invite?.accountExists === false ? (
        <form className="space-y-4" onSubmit={(e) => void accept(e)}>
          <Field label={t('auth.login.email')} value={invite.email} disabled readOnly />
          <Field label={t('auth.invite.name')} value={name} onChange={(e) => setName(e.target.value)} />
          <Field
            label={t('auth.invite.passwordOptional')}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Turnstile onToken={onToken} />
          <Notice tone="error">{error}</Notice>
          <Button type="submit">{t('auth.invite.accept')}</Button>
        </form>
      ) : (
        <div className="space-y-4">
          <Notice tone="error">{error}</Notice>
          {invite !== null && <Button onClick={() => void accept()}>{t('auth.invite.accept')}</Button>}
          {invite !== null && (
            <Button variant="ghost" onClick={() => window.location.assign('/login')}>
              {t('auth.login.title')}
            </Button>
          )}
        </div>
      )}
    </AuthCard>
  );
}
