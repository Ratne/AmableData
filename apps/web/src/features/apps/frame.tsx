import { envelope, parseAppMessage, type FrameContext, type HostMessage } from '@amable/app-bridge/protocol';
import { toast } from '@amable/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { appKeys, useAppsApi, type FrameSession } from './api';

/**
 * An app screen: sandboxed cross-origin iframe opened with a short session
 * token, plus the host side of `@amable/app-bridge` (resize, toast,
 * navigation, token renewal). Messages are accepted only from this iframe's
 * window and the app's origin.
 */

const SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads';

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function AppFrame({
  appId,
  uiKey,
  title,
  contactId = null,
  defaultHeight = 320,
  onClose,
  className,
}: {
  appId: string;
  uiKey: string;
  title: string;
  contactId?: string | null;
  defaultHeight?: number;
  onClose?: () => void;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useAppsApi();
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const open = (theme = currentTheme()) =>
    api.frame({ app_id: appId, key: uiKey, ...(contactId === null ? {} : { contact_id: contactId }), theme });
  // The URL (and its token) is fixed for the iframe's life; renewals go through the bridge.
  const session = useQuery({
    queryKey: appKeys.frame(slug, appId, uiKey, contactId),
    queryFn: () => open(),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const latest = useRef({ session: session.data, onClose, contactId, locale });
  latest.current = { session: session.data, onClose, contactId, locale };

  useEffect(() => {
    const send = (frame: FrameSession, message: HostMessage) =>
      frameRef.current?.contentWindow?.postMessage(envelope(message), frame.origin);
    const onMessage = (event: MessageEvent) => {
      const frame = latest.current.session;
      if (frame === undefined || event.source !== frameRef.current?.contentWindow || event.origin !== frame.origin) return;
      const message = parseAppMessage(event.data);
      if (message === null) return;
      switch (message.type) {
        case 'ready': {
          const context: FrameContext = {
            app_id: appId,
            key: uiKey,
            slot: frame.slot,
            tenant: slug,
            locale: latest.current.locale,
            theme: currentTheme(),
            contact_id: latest.current.contactId,
          };
          send(frame, { type: 'context', context });
          return;
        }
        case 'resize':
          setHeight(message.height);
          return;
        case 'toast':
          (message.tone === 'error' ? toast.error : message.tone === 'success' ? toast.success : toast)(message.message);
          return;
        case 'navigate':
          void navigate({ to: `/t/${slug}/${message.path}` });
          return;
        case 'open_contact':
          void navigate({ to: '/t/$tenant/contacts/$contactId', params: { tenant: slug, contactId: message.contact_id } });
          return;
        case 'close':
          latest.current.onClose?.();
          return;
        case 'session_token':
          open()
            .then((fresh) => send(frame, { type: 'session_token', request_id: message.request_id, token: fresh.token, expires_at: fresh.expires_at }))
            .catch(() => send(frame, { type: 'error', request_id: message.request_id, error: 'session_unavailable' }));
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // `open` only depends on the props below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, uiKey, slug, navigate]);

  if (session.isError) {
    return <p className="p-3 text-sm text-muted-foreground">{t('apps.frame.unavailable')}</p>;
  }
  if (session.data === undefined) {
    return <div className="animate-pulse rounded-md bg-muted" style={{ height: defaultHeight }} />;
  }
  return (
    <iframe
      ref={frameRef}
      title={title}
      src={session.data.url}
      sandbox={SANDBOX}
      referrerPolicy="strict-origin"
      allow="clipboard-write"
      className={className ?? 'w-full rounded-md border-0 bg-transparent'}
      style={{ height: height ?? session.data.height ?? defaultHeight }}
    />
  );
}
