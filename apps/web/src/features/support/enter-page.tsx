import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { postJson } from './api';

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
    postJson<{ redirect: string }>('/api/platform/assist/enter', { token })
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
