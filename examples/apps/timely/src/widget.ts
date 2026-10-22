import { normalizeStyle } from './style';
import { mountTimer, type MountedTimer, type TimerState } from './widget-view';

/**
 * Timely's page widget: `<div data-timely="<public id>"></div>` plus
 * `<script async src="https://amable-app-timely.<account>.workers.dev/widget.js"></script>`
 * (the snippet in the campaign editor has this workspace's URL).
 * Options on the element: `data-timely-mode="bar"`, `data-timely-position="bottom"`.
 *
 * The deadline comes from Timely, never from the page: a visitor gets one
 * per campaign (anonymous id in localStorage), a contact arriving from an
 * email link brings the signed `tly` token, which ties the deadline to the
 * contact on every device.
 */

const VISITOR_KEY = 'timely_visitor';
const TOKENS_KEY = 'timely_tokens';
const LAST_TOKEN_KEY = 'timely_last_token';
const REFRESH_MS = 5 * 60_000;

const memory = new Map<string, string>();
const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
};

function scriptBase(): string {
  const current = document.currentScript as HTMLScriptElement | null;
  const src = current?.src ?? document.querySelector<HTMLScriptElement>('script[src*="/widget.js"]')?.src ?? '';
  return src.replace(/\/widget\.js(\?.*)?$/, '');
}

const BASE = scriptBase();

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function visitorId(): string {
  let id = storage.get(VISITOR_KEY);
  if (id === null || !/^[0-9a-f-]{36}$/i.test(id)) {
    id = uuid();
    storage.set(VISITOR_KEY, id);
  }
  return id;
}

function tokens(): Record<string, string> {
  try {
    const parsed = JSON.parse(storage.get(TOKENS_KEY) ?? '{}') as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The token of the email link that opened this page, tried first. */
let fresh: string | null = null;

/** Keeps the `tly` token of the email link and removes it from the address bar. */
function captureToken(): void {
  const url = new URL(location.href);
  const token = url.searchParams.get('tly');
  if (token === null) return;
  fresh = token;
  storage.set(LAST_TOKEN_KEY, token);
  url.searchParams.delete('tly');
  try {
    history.replaceState(history.state, '', url.toString());
  } catch {
    // Sandboxed frames may refuse it: the token stays visible, nothing else changes.
  }
}

interface StateAnswer {
  campaign: string;
  /** Whether the token was a valid one for this campaign. */
  contact: boolean;
  status: TimerState['status'];
  deadline_at: number;
  server_now: number;
  expiry: TimerState['expiry'];
  redirect_url: string | null;
  style: unknown;
  css: string;
}

async function fetchState(publicId: string): Promise<StateAnswer | null> {
  const token = fresh ?? tokens()[publicId] ?? storage.get(LAST_TOKEN_KEY);
  const params = new URLSearchParams({ v: visitorId() });
  if (token !== null) params.set('t', token);
  try {
    const response = await fetch(`${BASE}/w/${encodeURIComponent(publicId)}/state?${params.toString()}`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return null;
    const answer = (await response.json()) as StateAnswer;
    if (token !== null && answer.contact && tokens()[publicId] !== token) {
      storage.set(TOKENS_KEY, JSON.stringify({ ...tokens(), [publicId]: token }));
    }
    return answer;
  } catch {
    return null;
  }
}

const mounted = new WeakMap<HTMLElement, MountedTimer>();

async function start(node: HTMLElement): Promise<void> {
  const publicId = node.dataset['timely'] ?? '';
  if (!/^[0-9a-z]{16}$/.test(publicId) || node.dataset['timelyReady'] !== undefined) return;
  node.dataset['timelyReady'] = 'loading';
  const load = async () => {
    const answer = await fetchState(publicId);
    if (answer === null) return null;
    const state: TimerState = {
      publicId,
      style: normalizeStyle(answer.style),
      css: answer.css,
      status: answer.status,
      deadlineAt: answer.deadline_at,
      serverNow: answer.server_now,
      expiry: answer.expiry,
      redirectUrl: answer.redirect_url,
      mode: node.dataset['timelyMode'] === 'bar' ? 'bar' : 'inline',
      position: node.dataset['timelyPosition'] === 'bottom' ? 'bottom' : 'top',
    };
    return state;
  };
  const state = await load();
  if (state === null) {
    node.dataset['timelyReady'] = 'error';
    return;
  }
  node.dataset['timelyReady'] = 'true';
  const timer = mountTimer(node, state, {
    onExpire: () => node.dispatchEvent(new CustomEvent('timely:expired', { bubbles: true, detail: { campaign: publicId } })),
  });
  mounted.set(node, timer);
  // A deadline changed in the CRM (reset, extended) reaches open pages too.
  const refresh = async () => {
    if (!node.isConnected) return timer.stop();
    if (document.visibilityState === 'visible') {
      const next = await load();
      if (next !== null) timer.update(next);
    }
    setTimeout(() => void refresh(), REFRESH_MS);
  };
  setTimeout(() => void refresh(), REFRESH_MS);
}

function scan(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-timely]').forEach((node) => void start(node));
}

function boot(): void {
  captureToken();
  scan();
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches('[data-timely]')) void start(node);
        scan(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

declare global {
  interface Window {
    Timely?: { scan: typeof scan; mounted: (node: HTMLElement) => MountedTimer | undefined };
  }
}

if (window.Timely === undefined) {
  window.Timely = { scan, mounted: (node) => mounted.get(node) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
