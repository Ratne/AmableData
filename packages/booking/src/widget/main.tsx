import {
  mountEach,
  scriptOrigin,
  shadowBox,
  showMessage,
  startScanning,
} from '@amable/forms/widget/embed';
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

const API_BASE = scriptOrigin();

function container(el: HTMLElement, accent: string): HTMLElement {
  const box = shadowBox(el, buildStyles(accent), 'data-ab-container');
  if (el.offsetWidth > 0 && el.offsetWidth < 620) box.className = 'ab-narrow';
  return box;
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
    showMessage(el, strings.loadError);
    return;
  }
  const result = await new BookingApi(API_BASE, tenant).config(slug);
  if (!result.ok) {
    showMessage(el, result.failure.status === 404 ? strings.notFound : strings.loadError);
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
    showMessage(el, BOOKING_WIDGET_STRINGS.en.loadError);
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
  mountEach('[data-amable-booking]', (el) => void load(el));
  mountEach('[data-amable-booking-manage]', mountManage);
}

declare global {
  interface Window {
    amableBooking?: { mount: typeof mount; scan: typeof scan };
  }
}

if (window.amableBooking === undefined) {
  window.amableBooking = { mount, scan };
  startScanning(scan);
}
