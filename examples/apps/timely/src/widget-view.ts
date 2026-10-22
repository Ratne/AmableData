import { pad, splitRemaining, unitLabel, widgetCss, type TimerStyle } from './style';

/** The DOM countdown, shared by the public widget and the editor's live preview. */

export type Expiry = 'zeros' | 'message' | 'hide' | 'redirect';

export interface TimerState {
  readonly publicId: string;
  readonly style: TimerStyle;
  /** Server CSS (`widgetCss`); computed from `style` when missing. */
  readonly css?: string;
  readonly status: 'running' | 'expired' | 'not_started';
  readonly deadlineAt: number;
  /** Server clock at the time of the answer, to correct the visitor's clock. */
  readonly serverNow: number;
  readonly expiry: Expiry;
  readonly redirectUrl: string | null;
  readonly mode?: 'inline' | 'bar';
  readonly position?: 'top' | 'bottom';
}

export interface MountedTimer {
  update(state: TimerState): void;
  stop(): void;
}

const EXPIRED_TEXT = { it: 'Offerta scaduta', en: 'This offer has expired' } as const;

function injectCss(publicId: string, css: string): void {
  const id = `timely-css-${publicId}`;
  let tag = document.getElementById(id) as HTMLStyleElement | null;
  if (tag === null) {
    tag = document.createElement('style');
    tag.id = id;
    document.head.appendChild(tag);
  }
  if (tag.textContent !== css) tag.textContent = css;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountTimer(host: HTMLElement, initial: TimerState, options: { onExpire?: () => void } = {}): MountedTimer {
  let state = initial;
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let values: Partial<Record<string, HTMLElement>> = {};
  let built = '';
  let expiredShown = false;
  let barPadding: { side: 'top' | 'bottom'; previous: string } | null = null;

  const clearBarPadding = () => {
    if (barPadding === null) return;
    const prop = barPadding.side === 'top' ? 'paddingTop' : 'paddingBottom';
    document.body.style[prop] = barPadding.previous;
    barPadding = null;
  };

  const build = () => {
    const { style } = state;
    const key = JSON.stringify([style.units, style.separators, style.show_labels, style.label_locale, style.label_text, state.mode, state.position]);
    host.className = `timely timely-${state.publicId}`;
    if (state.mode === 'bar') host.classList.add('timely-bar', state.position === 'bottom' ? 'timely-bottom' : 'timely-top');
    host.setAttribute('role', 'timer');
    if (key === built && !expiredShown) return;
    built = key;
    expiredShown = false;
    host.textContent = '';
    values = {};
    style.units.forEach((unit, i) => {
      if (i > 0 && style.separators) host.appendChild(el('span', 'timely-sep', ':'));
      const box = el('div', 'timely-unit');
      const value = el('div', 'timely-value', '00');
      values[unit] = value;
      box.appendChild(value);
      if (style.show_labels) box.appendChild(el('div', 'timely-label', unitLabel(style, unit)));
      host.appendChild(box);
    });
  };

  const showMessage = (text: string) => {
    host.textContent = '';
    host.appendChild(el('div', 'timely-expired', text));
    expiredShown = true;
  };

  const placeBar = () => {
    if (state.mode !== 'bar' || host.hidden) return clearBarPadding();
    const side = state.position === 'bottom' ? 'bottom' : 'top';
    const prop = side === 'top' ? 'paddingTop' : 'paddingBottom';
    if (barPadding === null) barPadding = { side, previous: document.body.style[prop] };
    document.body.style[prop] = `${String(host.offsetHeight)}px`;
  };

  const expire = () => {
    const { style } = state;
    const message = style.expired_text !== '' ? style.expired_text : EXPIRED_TEXT[style.label_locale];
    switch (state.expiry) {
      case 'hide':
        host.hidden = true;
        break;
      case 'message':
        showMessage(message);
        break;
      case 'redirect':
        if (state.redirectUrl !== null && !sameUrl(state.redirectUrl)) {
          options.onExpire?.();
          location.replace(state.redirectUrl);
          return;
        }
        if (style.expired_text !== '') showMessage(style.expired_text);
        break;
      default:
        if (style.expired_text !== '') showMessage(style.expired_text);
    }
    options.onExpire?.();
  };

  const paint = () => {
    const remaining = (state.deadlineAt - (Date.now() + offset)) / 1000;
    if (state.status !== 'not_started' && remaining <= 0) {
      for (const node of Object.values(values)) if (node !== undefined) node.textContent = '00';
      expire();
      placeBar();
      return false;
    }
    const parts = splitRemaining(remaining, state.style.units);
    for (const [unit, value] of Object.entries(parts.values)) {
      const node = values[unit];
      if (node !== undefined && value !== undefined) {
        const text = unit === state.style.units[0] && value > 99 ? String(value) : pad(value);
        if (node.textContent !== text) node.textContent = text;
      }
    }
    host.setAttribute('aria-label', state.style.units.map((u) => `${String(parts.values[u] ?? 0)} ${unitLabel(state.style, u)}`).join(', '));
    placeBar();
    return state.status === 'running';
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!paint()) return;
    const now = Date.now() + offset;
    // Wake up just after the next second of the deadline's clock.
    timer = setTimeout(schedule, Math.max(50, ((state.deadlineAt - now) % 1000 + 1000) % 1000 + 15));
  };

  const update = (next: TimerState) => {
    state = next;
    offset = next.serverNow - Date.now();
    host.hidden = false;
    injectCss(next.publicId, next.css ?? widgetCss(next.publicId, next.style));
    build();
    schedule();
  };

  update(initial);
  return {
    update,
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      clearBarPadding();
    },
  };
}

function sameUrl(target: string): boolean {
  try {
    const a = new URL(target, location.href);
    return a.origin === location.origin && a.pathname === location.pathname;
  } catch {
    return true;
  }
}
