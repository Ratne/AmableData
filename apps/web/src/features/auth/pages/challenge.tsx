import { useEffect, useState, type FormEvent } from 'react';
import {
  AuthApiError,
  authApi,
  currentLocale,
  errorMessage,
  homePath,
  useT,
  type AuthenticatedBody,
  type ChallengeState,
  type VerifyMethod,
} from '../api';
import { AuthCard, Button, Field, Notice, QrCode, RecoveryCodes } from '../components';

function formatWhen(at: number) {
  return new Date(at).toLocaleString(currentLocale(), { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * "I lost my second factor": an email code confirms the request, and the
 * factor is removed 24 hours later unless cancelled (from the email, from
 * Security or by signing in with the old factor). Nothing is unlocked now.
 */
function LostFactorForm({
  basePath,
  pendingDueAt,
  onBack,
  onClosed,
}: {
  basePath: string;
  pendingDueAt: number | null;
  /** Back to the second-factor form. */
  onBack: () => void;
  /** Leaves the flow once the challenge is used up. */
  onClosed: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dueAt, setDueAt] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);

  async function sendCode() {
    setError('');
    try {
      await authApi(`${basePath}/mfa-reset/email-code`, { body: {} });
      setSent(true);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = await authApi<{ dueAt: number }>(`${basePath}/mfa-reset/confirm`, { body: { code } });
      setDueAt(body.dueAt);
    } catch (err) {
      setError(errorMessage(t, err));
      if (err instanceof AuthApiError && err.code !== 'invalid_code') setClosed(true);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (dueAt !== null || closed) {
    return (
      <div className="space-y-4" data-testid="mfa-reset-result">
        {dueAt !== null && <Notice>{t('auth.mfaReset.scheduled', { time: formatWhen(dueAt) })}</Notice>}
        <Notice tone="error">{error}</Notice>
        <Button onClick={onClosed}>{t('common.back')}</Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => void confirm(e)} data-testid="mfa-reset-form">
      <p className="text-sm font-medium">{t('auth.mfaReset.title')}</p>
      <p className="text-sm text-muted-foreground">{t('auth.mfaReset.intro')}</p>
      {pendingDueAt !== null && (
        <Notice>{t('auth.mfaReset.pending', { time: formatWhen(pendingDueAt) })}</Notice>
      )}
      <Button type="button" variant={sent ? 'ghost' : 'primary'} onClick={() => void sendCode()}>
        {sent ? t('auth.mfaReset.resend') : t('auth.mfaReset.sendCode')}
      </Button>
      {sent && (
        <>
          <Notice>{t('auth.challenge.codeSent')}</Notice>
          <Field
            label={t('auth.challenge.code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {t('auth.mfaReset.confirm')}
          </Button>
        </>
      )}
      <Notice tone="error">{error}</Notice>
      <Button type="button" variant="ghost" onClick={onBack}>
        {t('common.back')}
      </Button>
    </form>
  );
}

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
  onCancelled,
}: {
  state: ChallengeState;
  basePath: string;
  onVerified: (body: Record<string, unknown>) => void;
  /** Signed-in flows (security settings, step-up): where Back goes once the challenge is void; default /login. */
  onCancelled?: () => void;
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
  const [lost, setLost] = useState(false);
  const leave = () => (onCancelled === undefined ? window.location.assign('/login') : onCancelled());

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
  const resetDueAt = state.resetDueAt ?? null;

  if (cancelled) {
    return (
      <div className="space-y-4">
        <Notice tone="error">{error}</Notice>
        <Button onClick={leave}>{t('common.back')}</Button>
      </div>
    );
  }

  if (lost) {
    return (
      <LostFactorForm
        basePath={basePath}
        pendingDueAt={resetDueAt}
        onBack={() => setLost(false)}
        onClosed={leave}
      />
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
        {state.resetAvailable === true && !enrolling && (
          <Button
            type="button"
            variant="ghost"
            data-testid="mfa-reset-link"
            onClick={() => {
              setLost(true);
              setError('');
              setInfo('');
            }}
          >
            {t('auth.mfaReset.link')}
          </Button>
        )}
      </div>
      {resetDueAt !== null && !enrolling && (
        <Notice>{t('auth.mfaReset.pending', { time: formatWhen(resetDueAt) })}</Notice>
      )}
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
    // Back to a pending invitation or app authorization if the sign-in started from one.
    const pendingInvite = sessionStorage.getItem('amb_invite_token') !== null;
    const pendingApp = sessionStorage.getItem('amb_app_authorize');
    if (pendingApp !== null && !pendingInvite) {
      sessionStorage.removeItem('amb_app_authorize');
      window.location.assign(pendingApp);
      return;
    }
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
