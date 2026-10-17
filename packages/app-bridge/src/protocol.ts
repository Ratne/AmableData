/**
 * Wire format between an app screen (iframe) and the CRM page around it.
 * Every message is `{ ns: 'amable-bridge', v: 1, type, ... }`; both sides
 * check the peer origin and `event.source` before reading it. Parsing is
 * strict: unknown types or malformed fields are dropped, never thrown.
 */

export const BRIDGE_NS = 'amable-bridge';
export const BRIDGE_VERSION = 1;

/** Query parameters the CRM adds to the iframe URL. */
export const FRAME_PARAMS = {
  token: 'session_token',
  host: 'host',
  locale: 'locale',
  theme: 'theme',
} as const;

export const TOAST_TONES = ['info', 'success', 'error'] as const;
export type ToastTone = (typeof TOAST_TONES)[number];

/** What the CRM tells the screen once it is ready (and again when it changes). */
export interface FrameContext {
  readonly app_id: string;
  readonly key: string;
  readonly slot: string;
  readonly tenant: string;
  readonly locale: string;
  readonly theme: 'light' | 'dark';
  readonly contact_id: string | null;
}

/** App → CRM. */
export type AppMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'resize'; readonly height: number }
  | { readonly type: 'toast'; readonly message: string; readonly tone: ToastTone }
  /** Path inside the workspace, e.g. `contacts` or `settings/apps/installed`. */
  | { readonly type: 'navigate'; readonly path: string }
  | { readonly type: 'open_contact'; readonly contact_id: string }
  | { readonly type: 'session_token'; readonly request_id: string }
  /** Closes the dialog of a `contact.actions` screen. */
  | { readonly type: 'close' };

/** CRM → app. */
export type HostMessage =
  | { readonly type: 'context'; readonly context: FrameContext }
  | { readonly type: 'session_token'; readonly request_id: string; readonly token: string; readonly expires_at: string }
  | { readonly type: 'error'; readonly request_id: string; readonly error: string };

export type Envelope<M> = M & { readonly ns: typeof BRIDGE_NS; readonly v: typeof BRIDGE_VERSION };

export function envelope<M extends { type: string }>(message: M): Envelope<M> {
  return { ns: BRIDGE_NS, v: BRIDGE_VERSION, ...message };
}

type Raw = Record<string, unknown>;

function base(data: unknown): Raw | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const raw = data as Raw;
  return raw['ns'] === BRIDGE_NS && raw['v'] === BRIDGE_VERSION && typeof raw['type'] === 'string' ? raw : null;
}

const shortString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/** Workspace-relative path: letters, digits, `/`, `-`, `_`, `.`; no scheme, no `..`. */
export function isSafePath(path: string): boolean {
  return /^[a-z0-9][a-z0-9/_.-]{0,199}$/i.test(path) && !path.split('/').includes('..');
}

export function parseAppMessage(data: unknown): AppMessage | null {
  const raw = base(data);
  if (raw === null) return null;
  switch (raw['type']) {
    case 'ready':
    case 'close':
      return { type: raw['type'] };
    case 'resize': {
      const height = raw['height'];
      if (typeof height !== 'number' || !Number.isFinite(height)) return null;
      return { type: 'resize', height: Math.min(Math.max(Math.round(height), 40), 4000) };
    }
    case 'toast': {
      if (!shortString(raw['message'], 300)) return null;
      const tone = (TOAST_TONES as readonly unknown[]).includes(raw['tone']) ? (raw['tone'] as ToastTone) : 'info';
      return { type: 'toast', message: raw['message'], tone };
    }
    case 'navigate':
      return shortString(raw['path'], 200) && isSafePath(raw['path']) ? { type: 'navigate', path: raw['path'] } : null;
    case 'open_contact':
      return shortString(raw['contact_id'], 64) ? { type: 'open_contact', contact_id: raw['contact_id'] } : null;
    case 'session_token':
      return shortString(raw['request_id'], 64) ? { type: 'session_token', request_id: raw['request_id'] } : null;
    default:
      return null;
  }
}

export function parseHostMessage(data: unknown): HostMessage | null {
  const raw = base(data);
  if (raw === null) return null;
  switch (raw['type']) {
    case 'context': {
      const context = raw['context'];
      if (typeof context !== 'object' || context === null) return null;
      return { type: 'context', context: context as FrameContext };
    }
    case 'session_token':
      return shortString(raw['request_id'], 64) && shortString(raw['token'], 8000) && typeof raw['expires_at'] === 'string'
        ? { type: 'session_token', request_id: raw['request_id'], token: raw['token'], expires_at: raw['expires_at'] }
        : null;
    case 'error':
      return shortString(raw['request_id'], 64) && typeof raw['error'] === 'string'
        ? { type: 'error', request_id: raw['request_id'], error: raw['error'] }
        : null;
    default:
      return null;
  }
}
