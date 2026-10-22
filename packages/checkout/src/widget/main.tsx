import { render } from 'preact';
import type { PublicCheckoutConfig } from '../public';
import type { CheckoutStyle } from '../schema';
import { CHECKOUT_STRINGS, resolveCheckoutLocale } from '../strings';
import { CheckoutApi } from './api';
import { Checkout } from './Checkout';
import { sessionTokenFromUrl } from './nav';
import { Offer } from './Offer';
import { buildCheckoutStyles, PAYMENT_SLOT } from './styles';

/**
 * Embed entry (`/checkout.js`): mounts every
 * `<div data-amable-checkout="<id>" data-amable-tenant="<slug>">` and every
 * post-purchase offer block `<div data-amable-offer data-amable-tenant="<slug>">`
 * (session token from `?amb_cs=`) in its own shadow root, now and when added
 * later. Talks to the origin the script was loaded from.
 * `window.amableCheckout.mount` renders an in-memory configuration (builder preview).
 */

const MOUNTED = 'data-amable-mounted';

const DEFAULT_STYLE: CheckoutStyle = {
  primary_color: '#4f46e5',
  text_color: '#111827',
  background_color: 'transparent',
  input_background: '#ffffff',
  border_color: '#d1d5db',
  button_text_color: '#ffffff',
  radius: '8px',
  font_family: 'system-ui, -apple-system, Segoe UI, sans-serif',
  font_size: '15px',
  gap: '14px',
  max_width: '560px',
  custom_css: '',
  layout: 'one_column',
  summary_background: '#f9fafb',
};

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

function container(el: HTMLElement, style: CheckoutStyle): HTMLElement {
  const root = shadowOf(el);
  let tag = root.querySelector('style');
  if (tag === null) {
    tag = document.createElement('style');
    root.appendChild(tag);
  }
  tag.textContent = buildCheckoutStyles(style);
  let box = root.querySelector<HTMLElement>('div[data-ac-container]');
  if (box === null) {
    box = document.createElement('div');
    box.setAttribute('data-ac-container', '');
    root.appendChild(box);
  }
  if (el.offsetWidth > 0 && el.offsetWidth < 720) box.className = 'ac-narrow';
  return box;
}

function paymentHostOf(el: HTMLElement): HTMLElement {
  let node = el.querySelector<HTMLElement>(`:scope > [slot="${PAYMENT_SLOT}"]`);
  if (node === null) {
    node = document.createElement('div');
    node.setAttribute('slot', PAYMENT_SLOT);
    el.appendChild(node);
  }
  return node;
}

function message(el: HTMLElement, text: string): void {
  const root = shadowOf(el);
  root.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'font-family:system-ui,sans-serif;color:#b91c1c;font-size:14px';
  root.appendChild(p);
}

export function mount(el: HTMLElement, config: PublicCheckoutConfig, options: { preview?: boolean } = {}): void {
  const locale = resolveCheckoutLocale(config.settings.locale, navigator.languages);
  render(
    <Checkout
      key={config.id}
      config={config}
      api={new CheckoutApi(API_BASE, config.tenant)}
      strings={CHECKOUT_STRINGS[locale]}
      locale={locale}
      host={el}
      paymentHost={paymentHostOf(el)}
      preview={options.preview === true}
    />,
    container(el, config.style),
  );
}

async function load(el: HTMLElement): Promise<void> {
  const id = el.getAttribute('data-amable-checkout') ?? '';
  const tenant = el.getAttribute('data-amable-tenant') ?? '';
  const strings = CHECKOUT_STRINGS[resolveCheckoutLocale('auto', navigator.languages)];
  if (id === '' || tenant === '') {
    message(el, strings.loadError);
    return;
  }
  const result = await new CheckoutApi(API_BASE, tenant).config(id);
  if (!result.ok) {
    message(el, result.failure.status === 404 ? strings.notFound : strings.loadError);
    return;
  }
  mount(el, result.value);
}

function mountOffer(el: HTMLElement): void {
  const tenant = el.getAttribute('data-amable-tenant') ?? '';
  const locale = resolveCheckoutLocale(el.getAttribute('data-amable-locale') ?? 'auto', navigator.languages);
  const color = el.getAttribute('data-amable-color') ?? '';
  const style: CheckoutStyle = /^#[0-9a-f]{3,8}$/i.test(color) ? { ...DEFAULT_STYLE, primary_color: color } : DEFAULT_STYLE;
  if (tenant === '') {
    message(el, CHECKOUT_STRINGS[locale].loadError);
    return;
  }
  render(
    <Offer
      api={new CheckoutApi(API_BASE, tenant)}
      token={sessionTokenFromUrl()}
      strings={CHECKOUT_STRINGS[locale]}
      locale={locale}
      buttonsOnly={el.hasAttribute('data-amable-buttons-only')}
    />,
    container(el, style),
  );
}

function scan(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-amable-checkout]')) {
    if (el.hasAttribute(MOUNTED)) continue;
    el.setAttribute(MOUNTED, '');
    void load(el);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-amable-offer]')) {
    if (el.hasAttribute(MOUNTED)) continue;
    el.setAttribute(MOUNTED, '');
    mountOffer(el);
  }
}

declare global {
  interface Window {
    amableCheckout?: { mount: typeof mount; scan: typeof scan };
  }
}

if (window.amableCheckout === undefined) {
  window.amableCheckout = { mount, scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}
