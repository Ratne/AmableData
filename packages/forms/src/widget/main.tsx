import { render } from 'preact';
import type { PublicFormConfig } from '../schema';
import { resolveWidgetLocale, WIDGET_STRINGS } from '../strings';
import { mountEach, scriptOrigin, shadowBox, showMessage, startScanning } from './embed';
import { Form } from './Form';
import { buildStyles } from './styles';

/**
 * Embed entry (`/forms.js`): mounts every
 * `<div data-amable-form="<formId>" data-amable-tenant="<slug>">` of the page in
 * its own shadow root, now and when added later. Talks to the origin the
 * script was loaded from. `window.amableForms.mount` is used by the builder's
 * live preview with an in-memory configuration.
 */

const API_BASE = scriptOrigin();

export function mount(el: HTMLElement, config: PublicFormConfig, options: { preview?: boolean } = {}): void {
  const locale = resolveWidgetLocale(config.settings.locale, navigator.languages);
  render(
    <Form
      key={options.preview === true ? JSON.stringify(config.fields.map((f) => f.id)) : config.id}
      config={config}
      strings={WIDGET_STRINGS[locale]}
      apiBase={API_BASE}
      host={el}
      preview={options.preview === true}
    />,
    shadowBox(el, buildStyles(config.style), 'data-af-container'),
  );
}

async function load(el: HTMLElement): Promise<void> {
  const formId = el.getAttribute('data-amable-form') ?? '';
  const tenant = el.getAttribute('data-amable-tenant') ?? '';
  const strings = WIDGET_STRINGS[resolveWidgetLocale('auto', navigator.languages)];
  if (formId === '' || tenant === '') {
    showMessage(el, strings.loadError);
    return;
  }
  try {
    const response = await fetch(
      `${API_BASE}/f/${encodeURIComponent(tenant)}/${encodeURIComponent(formId)}/config`,
      { credentials: 'omit', headers: { accept: 'application/json' } },
    );
    if (!response.ok) {
      showMessage(el, response.status === 404 ? strings.notFound : strings.loadError);
      return;
    }
    mount(el, (await response.json()) as PublicFormConfig);
  } catch {
    showMessage(el, strings.loadError);
  }
}

function scan(): void {
  mountEach('[data-amable-form]', (el) => void load(el));
}

declare global {
  interface Window {
    amableForms?: { mount: typeof mount; scan: typeof scan };
  }
}

if (window.amableForms === undefined) {
  window.amableForms = { mount, scan };
  startScanning(scan);
}
