import {
  envelope,
  FRAME_PARAMS,
  parseHostMessage,
  type AppMessage,
  type FrameContext,
  type ToastTone,
} from './protocol';

export * from './protocol';

/**
 * Client side of the bridge, for app screens running inside the CRM:
 *
 *   const bridge = createAppBridge();
 *   bridge.autoResize();
 *   const token = await bridge.sessionToken(); // send it to your backend
 *   bridge.toast('Saved', 'success');
 *
 * The CRM origin comes from the `host` query parameter of the iframe URL;
 * messages from any other window or origin are ignored.
 */

export interface AppBridgeOptions {
  /** CRM origin; defaults to the `host` query parameter. */
  readonly hostOrigin?: string;
  /** Defaults to `window`. */
  readonly window?: Window;
  /** Renew the token when it expires within this many seconds. */
  readonly refreshMarginSeconds?: number;
}

export interface AppBridge {
  readonly hostOrigin: string;
  /** Latest context sent by the CRM (null until it arrives). */
  context(): FrameContext | null;
  onContext(listener: (context: FrameContext) => void): () => void;
  /** A valid session token (from the URL, renewed through the CRM when close to expiry). */
  sessionToken(): Promise<string>;
  resize(height: number): void;
  /** Keeps the iframe as tall as the document. Returns a function that stops it. */
  autoResize(): () => void;
  toast(message: string, tone?: ToastTone): void;
  navigate(path: string): void;
  openContact(contactId: string): void;
  close(): void;
  destroy(): void;
}

/** `exp` of a JWT, without verifying it (the app backend verifies). */
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (part === undefined) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

export function createAppBridge(options: AppBridgeOptions = {}): AppBridge {
  const win = options.window ?? window;
  const params = new URLSearchParams(win.location.search);
  const hostOrigin = options.hostOrigin ?? params.get(FRAME_PARAMS.host) ?? '';
  if (hostOrigin === '') throw new Error('app-bridge: unknown CRM origin (missing `host` parameter)');
  const margin = options.refreshMarginSeconds ?? 30;
  let token = params.get(FRAME_PARAMS.token);
  let context: FrameContext | null = null;
  const listeners = new Set<(context: FrameContext) => void>();
  const pending = new Map<string, { resolve: (token: string) => void; reject: (error: Error) => void }>();
  let counter = 0;

  const post = (message: AppMessage) => win.parent.postMessage(envelope(message), hostOrigin);

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== hostOrigin || event.source !== win.parent) return;
    const message = parseHostMessage(event.data);
    if (message === null) return;
    if (message.type === 'context') {
      context = message.context;
      for (const listener of listeners) listener(message.context);
      return;
    }
    const waiting = pending.get(message.request_id);
    if (waiting === undefined) return;
    pending.delete(message.request_id);
    if (message.type === 'session_token') {
      token = message.token;
      waiting.resolve(message.token);
    } else {
      waiting.reject(new Error(message.error));
    }
  };
  win.addEventListener('message', onMessage);
  post({ type: 'ready' });

  const fresh = (value: string | null): value is string => {
    if (value === null) return false;
    const exp = tokenExpiry(value);
    return exp !== null && exp - margin > Date.now() / 1000;
  };

  return {
    hostOrigin,
    context: () => context,
    onContext(listener) {
      listeners.add(listener);
      if (context !== null) listener(context);
      return () => listeners.delete(listener);
    },
    sessionToken() {
      if (fresh(token)) return Promise.resolve(token);
      counter += 1;
      const requestId = `t${String(counter)}`;
      return new Promise<string>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        post({ type: 'session_token', request_id: requestId });
        setTimeout(() => {
          if (pending.delete(requestId)) reject(new Error('app-bridge: session token request timed out'));
        }, 10_000);
      });
    },
    resize: (height) => post({ type: 'resize', height }),
    autoResize() {
      const doc = win.document.documentElement;
      let last = 0;
      const measure = () => {
        const height = Math.ceil(doc.scrollHeight);
        if (height !== last) {
          last = height;
          post({ type: 'resize', height });
        }
      };
      const observer = new ResizeObserver(measure);
      observer.observe(doc);
      measure();
      return () => observer.disconnect();
    },
    toast: (message, tone = 'info') => post({ type: 'toast', message, tone }),
    navigate: (path) => post({ type: 'navigate', path }),
    openContact: (contactId) => post({ type: 'open_contact', contact_id: contactId }),
    close: () => post({ type: 'close' }),
    destroy() {
      win.removeEventListener('message', onMessage);
      for (const waiting of pending.values()) waiting.reject(new Error('app-bridge: destroyed'));
      pending.clear();
    },
  };
}
