import { render } from 'preact';
import type { ManageView, PublicBookingConfig } from '../public';
import { BOOKING_WIDGET_STRINGS, resolveBookingLocale } from '../strings';
import { BookingApi } from './api';
import { buildStyles } from './styles';
import { BookingWidget, ManageWidget } from './Widget';

/**
 * Embed entry (`/booking.js`): mounts every
 * `<div data-amable-booking="<eventSlug>" data-amable-tenant="<slug>">` of the
 * page in its own shadow root, now and when added later, plus the hosted
 * manage page (`data-amable-booking-manage`, view JSON in
 * `<script type="application/json" id="amable-booking-manage">`). Talks to the
 * origin the script was loaded from. `window.amableBooking.mount` renders an
 * in-memory configuration (SPA preview).
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

function container(el: HTMLElement, accent: string): HTMLElement {
  const root = shadowOf(el);
  let style = root.querySelector('style');
  if (style === null) {
    style = document.createElement('style');
    root.appendChild(style);
  }
  style.textContent = buildStyles(accent);
  let box = root.querySelector<HTMLElement>('div[data-ab-container]');
  if (box === null) {
    box = document.createElement('div');
    box.setAttribute('data-ab-container', '');
    root.appendChild(box);
  }
  if (el.offsetWidth > 0 && el.offsetWidth < 620) box.className = 'ab-narrow';
  return box;
}

function message(el: HTMLElement, text: string): void {
  const root = shadowOf(el);
  root.innerHTML = '';
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText = 'font-family:system-ui,sans-serif;color:#b91c1c;font-size:14px';
  root.appendChild(p);
}

export function mount(el: HTMLElement, config: PublicBookingConfig, options: { preview?: boolean } = {}): void {
  const locale = resolveBookingLocale(config.locale, navigator.languages);
  render(
    <BookingWidget
      key={config.slug}
      api={new BookingApi(API_BASE, config.tenant)}
      strings={BOOKING_WIDGET_STRINGS[locale]}
      locale={locale}
      config={config}
      host={el}
      preview={options.preview === true}
    />,
    container(el, config.color),
  );
}

async function load(el: HTMLElement): Promise<void> {
  const slug = el.getAttribute('data-amable-booking') ?? '';
  const tenant = el.getAttribute('data-amable-tenant') ?? '';
  const strings = BOOKING_WIDGET_STRINGS[resolveBookingLocale('auto', navigator.languages)];
  if (slug === '' || tenant === '') {
    message(el, strings.loadError);
    return;
  }
  const result = await new BookingApi(API_BASE, tenant).config(slug);
  if (!result.ok) {
    message(el, result.failure.status === 404 ? strings.notFound : strings.loadError);
    return;
  }
  mount(el, result.value);
}

function mountManage(el: HTMLElement): void {
  const token = el.getAttribute('data-amable-token') ?? '';
  const tenant = el.getAttribute('data-amable-tenant') ?? '';
  const data = document.getElementById('amable-booking-manage')?.textContent ?? '';
  let view: ManageView;
  try {
    view = JSON.parse(data) as ManageView;
  } catch {
    message(el, BOOKING_WIDGET_STRINGS.en.loadError);
    return;
  }
  const locale = resolveBookingLocale(view.config.locale, navigator.languages);
  render(
    <ManageWidget
      api={new BookingApi(API_BASE, tenant)}
      strings={BOOKING_WIDGET_STRINGS[locale]}
      locale={locale}
      view={view}
      token={token}
    />,
    container(el, view.config.color),
  );
}

function scan(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-amable-booking]')) {
    if (el.hasAttribute(MOUNTED)) continue;
    el.setAttribute(MOUNTED, '');
    void load(el);
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-amable-booking-manage]')) {
    if (el.hasAttribute(MOUNTED)) continue;
    el.setAttribute(MOUNTED, '');
    mountManage(el);
  }
}

declare global {
  interface Window {
    amableBooking?: { mount: typeof mount; scan: typeof scan };
  }
}

if (window.amableBooking === undefined) {
  window.amableBooking = { mount, scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
}
