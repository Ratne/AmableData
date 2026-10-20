import { useSyncExternalStore } from 'react';

/**
 * Feedback for requests to the CRM, with no per-screen code:
 * - the button (or form submitter) the user just activated gets `data-busy` /
 *   `aria-busy` until the requests it started settle (styles.css draws the spinner
 *   and blocks a second click);
 * - writes in flight are counted for the top progress bar.
 * Every same-origin `fetch` goes through here once `installActivityTracking` ran.
 */

/** A request started this soon after a click belongs to that button. */
const CLICK_WINDOW_MS = 400;

let lastActivation: { element: HTMLElement; at: number } | null = null;
let writes = 0;
const listeners = new Set<() => void>();
const busyCount = new WeakMap<HTMLElement, number>();

function emit(): void {
  for (const listener of listeners) listener();
}

function remember(element: Element | null): void {
  const button = element?.closest('button, [role="button"]');
  // Switches, checkboxes and tabs are buttons in the DOM, but a spinner inside them breaks their look.
  if (button?.matches('[role="switch"], [role="checkbox"], [role="radio"], [role="tab"]')) return;
  if (button instanceof HTMLElement) lastActivation = { element: button, at: performance.now() };
}

function markBusy(element: HTMLElement): () => void {
  busyCount.set(element, (busyCount.get(element) ?? 0) + 1);
  element.dataset.busy = '';
  element.setAttribute('aria-busy', 'true');
  return () => {
    const left = (busyCount.get(element) ?? 1) - 1;
    busyCount.set(element, left);
    if (left > 0) return;
    delete element.dataset.busy;
    element.removeAttribute('aria-busy');
  };
}

function isWrite(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function sameOrigin(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function installActivityTracking(): void {
  if (typeof window === 'undefined' || (window as { __activity?: boolean }).__activity) return;
  (window as { __activity?: boolean }).__activity = true;
  document.addEventListener('click', (event) => remember(event.target as Element | null), true);
  document.addEventListener('submit', (event) => remember(event.submitter ?? null), true);

  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!sameOrigin(input)) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const write = isWrite(method);
    const recent =
      lastActivation !== null &&
      performance.now() - lastActivation.at <= CLICK_WINDOW_MS &&
      lastActivation.element.isConnected
        ? lastActivation.element
        : null;
    const release = recent === null ? null : markBusy(recent);
    if (write) {
      writes += 1;
      emit();
    }
    const settle = () => {
      release?.();
      if (write) {
        writes -= 1;
        emit();
      }
    };
    const request = original(input, init);
    request.then(settle, settle);
    return request;
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Writes (POST, PATCH, PUT, DELETE) to the CRM still in flight. */
export function usePendingWrites(): number {
  return useSyncExternalStore(subscribe, () => writes, () => 0);
}
