import { useEffect, useState, type FormEvent } from 'react';
import {
  AuthApiError,
  authApi,
  errorMessage,
  homePath,
  useT,
  type AuthenticatedBody,
  type ChallengeState,
  type VerifyMethod,
} from '../api';
import { AuthCard, Button, Field, Notice, QrCode, RecoveryCodes } from '../components';

/**
 * Second factor after password / magic link / invite: verify with TOTP, email
 * code or recovery code — or enroll (mandatory) when 2FA is not set up yet.
 * Also reused by the security settings for step-up and method changes via
 * `basePath` (e.g. "/api/auth/step-up" or "/api/me/2fa").
 */
export function SecondFactorForm({
  state,
  basePath,
  onVerified,
}: {
  state: ChallengeState;
  basePath: string;
  onVerified: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const enrolling = !state.enrolled;
  const [method, setMethod] = useState<VerifyMethod>(state.methods[0] ?? 'totp');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (method === 'enroll_totp' && setup === null) {
      authApi<{ secret: string; otpauthUri: string }>(`${basePath}/totp-setup`, { body: {} })
        .then(setSetup)
        .catch((err: unknown) => setError(errorMessage(t, err)));
    }
  }, [method, setup, basePath, t]);

  async function sendCode() {
    setError('');
    try {
      await authApi(`${basePath}/email-code`, { body: {} });
      setInfo(t('auth.challenge.codeSent'));
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onVerified(await authApi(`${basePath}/verify`, { body: { method, code } }));
    } catch (err) {
      setError(errorMessage(t, err));
      if (err instanceof AuthApiError && err.code !== 'invalid_code') setCancelled(true);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const prompt: Record<VerifyMethod, string> = {
    totp: t('auth.challenge.totp'),
    email: t('auth.challenge.email'),
    recovery: t('auth.challenge.recovery'),
    enroll_totp: t('auth.enroll.scan'),
    enroll_email: t('auth.challenge.email'),
  };
  const switchLabel: Record<VerifyMethod, string> = {
    totp: t('auth.challenge.useTotp'),
    email: t('auth.challenge.useEmail'),
    recovery: t('auth.challenge.useRecovery'),
    enroll_totp: t('auth.enroll.totp'),
    enroll_email: t('auth.enroll.email'),
  };

  if (cancelled) {
    return (
      <div className="space-y-4">
        <Notice tone="error">{error}</Notice>
        <Button onClick={() => window.location.assign('/login')}>{t('common.back')}</Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void verify(e)}>
      {enrolling && <p className="text-sm text-muted-foreground">{t('auth.enroll.intro')}</p>}
      <p className="text-sm">{prompt[method]}</p>
      {method === 'enroll_totp' && setup !== null && (
        <div className="space-y-2">
          <QrCode value={setup.otpauthUri} />
          <p className="text-xs text-muted-foreground">{t('auth.enroll.secret')}</p>
          <code className="block rounded bg-muted px-2 py-1 text-center font-mono text-xs break-all">{setup.secret}</code>
        </div>
      )}
      {(method === 'email' || method === 'enroll_email') && (
        <Button type="button" variant="ghost" onClick={() => void sendCode()}>
          {t('auth.challenge.sendCode')}
        </Button>
      )}
      <Field
        label={t('auth.challenge.code')}
        inputMode={method === 'recovery' ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <Notice tone="error">{error}</Notice>
      <Notice>{info}</Notice>
      <Button type="submit" disabled={busy}>
        {t('auth.challenge.verify')}
      </Button>
      <div className="space-y-1">
        {state.methods
          .filter((m) => m !== method)
          .map((m) => (
            <Button
              key={m}
              type="button"
              variant="ghost"
              onClick={() => {
                setMethod(m);
                setError('');
                setInfo('');
              }}
            >
              {switchLabel[m]}
            </Button>
          ))}
      </div>
    </form>
  );
}

/** /auth/challenge — the login second factor. */
export function ChallengePage() {
  const t = useT();
  const [state, setState] = useState<ChallengeState | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<AuthenticatedBody | null>(null);

  useEffect(() => {
    authApi<ChallengeState>('/api/auth/challenge')
      .then(setState)
      .catch((err: unknown) => setError(errorMessage(t, err)));
  }, [t]);

  function finish(body: AuthenticatedBody) {
    // Back to a pending invitation if the sign-in started from one.
    const pendingInvite = sessionStorage.getItem('amb_invite_token') !== null;
    window.location.assign(pendingInvite ? '/invite' : homePath(body.lastTenantSlug));
  }

  if (done?.recoveryCodes !== null && done?.recoveryCodes !== undefined) {
    return (
      <AuthCard title={t('auth.enroll.recoveryTitle')}>
        <p className="text-sm text-muted-foreground">{t('auth.enroll.recoveryIntro')}</p>
        <RecoveryCodes codes={done.recoveryCodes} doneLabel={t('auth.enroll.done')} onDone={() => finish(done)} />
      </AuthCard>
    );
  }

  return (
    <AuthCard title={state?.enrolled === false ? t('auth.enroll.title') : t('auth.challenge.title')}>
      {state === null ? (
        error === '' ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <div className="space-y-4">
            <Notice tone="error">{error}</Notice>
            <Button onClick={() => window.location.assign('/login')}>{t('common.back')}</Button>
          </div>
        )
      ) : (
        <SecondFactorForm
          state={state}
          basePath="/api/auth/challenge"
          onVerified={(body) => {
            const authenticated = body as unknown as AuthenticatedBody;
            if (authenticated.recoveryCodes !== null) setDone(authenticated);
            else finish(authenticated);
          }}
        />
      )}
    </AuthCard>
  );
}
