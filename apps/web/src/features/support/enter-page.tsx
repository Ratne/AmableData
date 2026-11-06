import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { apiFetch } from '../../lib/api';

/** Reads the assist token from the URL fragment (never sent to servers or logs) and scrubs it. */
function takeAssistToken(): string | null {
  const match = /(?:^|[#&])token=([A-Za-z0-9_.-]+)/.exec(window.location.hash);
  window.history.replaceState(null, '', window.location.pathname);
  return match?.[1] ?? null;
}

/** `/support-access` — entry of a support staff member through an assisted-access token. */
export function AssistEnterPage() {
  const { t } = useI18n();
  const [error, setError] = useState<'missing' | 'invalid' | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeAssistToken();
    if (token === null) {
      setError('missing');
      return;
    }
    // apiFetch: a rejected token answers 401 and must show the error here, not bounce to sign-in.
    apiFetch<{ redirect: string }>('/api/platform/assist/enter', { method: 'POST', body: JSON.stringify({ token }) })
      .then((body) => window.location.replace(body.redirect))
      .catch(() => setError('invalid'));
  }, []);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <p role={error ? 'alert' : 'status'} className="text-sm text-muted-foreground">
        {error === 'missing' ? t('sup.enter.missing') : error === 'invalid' ? t('sup.enter.error') : t('sup.enter.title')}
      </p>
    </main>
  );
}
