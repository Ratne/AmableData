import { render } from 'preact';
import type { PublicFormConfig } from '../schema';
import { resolveWidgetLocale, WIDGET_STRINGS } from '../strings';
import { Form } from './Form';
import { buildStyles } from './styles';

/**
 * Embed entry (`/forms.js`): mounts every
 * `<div data-amable-form="<formId>" data-amable-tenant="<slug>">` of the page in
 * its own shadow root, now and when added later. Talks to the origin the
 * script was loaded from. `window.amableForms.mount` is used by the builder's
 * live preview with an in-memory configuration.
 */

const MOUNTED = 'data-amable-mounted';

function scriptOrigin(): string {
  const current = document.currentScript;
  const src = current instanceof HTMLScriptElement ? current.src : '';
  if (src !== '' && !src.startsWith('blob:')) {
    try {
      return new URL(src).origin;
    } catch {
      // fall through
    }
  }
  return location.origin;
}

const API_BASE = scriptOrigin();

function shadowOf(el: HTMLElement): ShadowRoot {
  return el.shadowRoot ?? el.attachShadow({ mode: 'open' });
}

function message(el: HTMLElement, text: string): void {
  const root = shadowOf(el);
  root.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'font-family:system-ui,sans-serif;color:#b91c1c;font-size:14px';
  root.appendChild(p);
}

export function mount(el: HTMLElement, config: PublicFormConfig, options: { preview?: boolean } = {}): void {
  const root = shadowOf(el);
  const locale = resolveWidgetLocale(config.settings.locale, navigator.languages);
  let style = root.querySelector('style');
  if (style === null) {
    style = document.createElement('style');
    root.appendChild(style);
  }
  style.textContent = buildStyles(config.style);
  let container = root.querySelector<HTMLElement>('div[data-af-container]');
  if (container === null) {
    container = document.createElement('div');
    container.setAttribute('data-af-container', '');
    root.appendChild(container);
  }
  render(
    <Form
      key={options.preview === true ? JSON.stringify(config.fields.map((f) => f.id)) : config.id}
      config={config}
      strings={WIDGET_STRINGS[locale]}
      apiBase={API_BASE}
      host={el}
      preview={options.preview === true}
    />,
    container,
  );
}

async function load(el: HTMLElement): Promise<void> {
  const formId = el.getAttribute('data-amable-form') ?? '';
  const tenant = el.getAttribute('data-amable-tenant') ?? '';
  const strings = WIDGET_STRINGS[resolveWidgetLocale('auto', navigator.languages)];
  if (formId === '' || tenant === '') {
    message(el, strings.loadError);
    return;
  }
  try {
    const response = await fetch(
      `${API_BASE}/f/${encodeURIComponent(tenant)}/${encodeURIComponent(formId)}/config`,
      { credentials: 'omit', headers: { accept: 'application/json' } },
    );
    if (!response.ok) {
      message(el, response.status === 404 ? strings.notFound : strings.loadError);
      return;
    }
    mount(el, (await response.json()) as PublicFormConfig);
  } catch {
    message(el, strings.loadError);
  }
}

function scan(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-amable-form]')) {
    if (el.hasAttribute(MOUNTED)) continue;
    el.setAttribute(MOUNTED, '');
    void load(el);
  }
}

declare global {
  interface Window {
    amableForms?: { mount: typeof mount; scan: typeof scan };
  }
}

if (window.amableForms === undefined) {
  window.amableForms = { mount, scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}
