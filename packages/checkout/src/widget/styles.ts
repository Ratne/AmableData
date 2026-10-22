import { buildStyles as formStyles } from '@amable/forms/widget/styles';
import type { CheckoutStyle } from '../schema';

/**
 * Checkout stylesheet (shadow root): the form widget rules for the fields,
 * plus layout, summary, bump skins and the offer block. `:where()` keeps the
 * custom CSS (appended last by the form rules) in charge.
 */
export function buildCheckoutStyles(s: CheckoutStyle): string {
  const mix = (pct: number) => `color-mix(in srgb, ${s.primary_color} ${String(pct)}%, transparent)`;
  const custom = s.custom_css;
  return `${formStyles({ ...s, custom_css: '' })}
:where(.ac-root) {
  font-family: ${s.font_family}; font-size: ${s.font_size}; color: ${s.text_color};
  background: ${s.background_color}; max-width: ${s.layout === 'two_columns' ? `calc(${s.max_width} * 1.75)` : s.max_width};
  width: 100%; margin: 0 auto; line-height: 1.45;
}
:where(.ac-grid) { display: grid; gap: calc(${s.gap} * 2); grid-template-columns: ${s.layout === 'two_columns' ? 'minmax(0, 3fr) minmax(0, 2fr)' : '1fr'}; align-items: start; }
:where(.ac-narrow .ac-grid) { grid-template-columns: 1fr; }
:where(.ac-main) { display: flex; flex-direction: column; gap: calc(${s.gap} * 1.5); min-width: 0; }
:where(.ac-heading) { font-size: 1.5em; font-weight: 700; margin: 0; }
:where(.ac-section) { display: flex; flex-direction: column; gap: ${s.gap}; }
:where(.ac-section-title) { font-weight: 700; font-size: 1.05em; }
:where(.ac-items) { display: flex; flex-direction: column; gap: 10px; }
:where(.ac-item) {
  display: flex; gap: 12px; align-items: center; padding: 12px; border: 1px solid ${s.border_color};
  border-radius: ${s.radius}; background: ${s.input_background}; cursor: default;
}
:where(label.ac-item) { cursor: pointer; }
:where(.ac-item-on) { border-color: ${s.primary_color}; box-shadow: 0 0 0 1px ${s.primary_color}; }
:where(.ac-thumb) { width: 52px; height: 52px; object-fit: cover; border-radius: calc(${s.radius} / 1.5); flex: 0 0 auto; }
:where(.ac-item-body) { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
:where(.ac-item-name) { font-weight: 600; }
:where(.ac-item-desc, .ac-muted) { font-size: .85em; opacity: .72; }
:where(.ac-price) { font-weight: 600; white-space: nowrap; text-align: right; }
:where(.ac-strike) { text-decoration: line-through; opacity: .55; font-weight: 400; margin-right: 6px; }
:where(.ac-qty) { width: 64px; padding: 6px 8px; font: inherit; border: 1px solid ${s.border_color}; border-radius: ${s.radius}; }
:where(.ac-row) { display: flex; gap: ${s.gap}; flex-wrap: wrap; }
:where(.ac-row > *) { flex: 1 1 180px; }
:where(.ac-suggest) { position: relative; }
:where(.ac-suggest-list) {
  position: absolute; z-index: 5; left: 0; right: 0; top: 100%; margin: 4px 0 0; padding: 4px; list-style: none;
  background: #fff; color: #111827; border: 1px solid ${s.border_color}; border-radius: ${s.radius};
  box-shadow: 0 8px 24px rgba(0,0,0,.12);
}
:where(.ac-suggest-list button) { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: .92em; }
:where(.ac-suggest-list button:hover, .ac-suggest-list button:focus) { background: ${mix(10)}; }
:where(.ac-suggest-attribution) { padding: 4px 10px 2px; font-size: .75em; color: #6b7280; text-align: right; }
:where(.ac-bump) { display: flex; gap: 12px; padding: 14px; border-radius: ${s.radius}; cursor: pointer; align-items: flex-start; }
:where(.ac-bump input) { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--ac-bump, ${s.primary_color}); flex: 0 0 auto; }
:where(.ac-bump-title) { font-weight: 700; }
:where(.ac-bump-classic) { border: 1px solid ${s.border_color}; background: ${s.input_background}; }
:where(.ac-bump-highlight) { border: 2px solid var(--ac-bump, #f59e0b); background: color-mix(in srgb, var(--ac-bump, #f59e0b) 12%, #fff); }
:where(.ac-bump-dashed) { border: 2px dashed var(--ac-bump, #dc2626); background: color-mix(in srgb, var(--ac-bump, #dc2626) 6%, #fff); }
:where(.ac-bump-minimal) { padding: 6px 0; }
:where(.ac-bump-ribbon) { flex-direction: column; gap: 0; padding: 0; border: 1px solid var(--ac-bump, ${s.primary_color}); overflow: hidden; }
:where(.ac-bump-ribbon .ac-ribbon) { display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: var(--ac-bump, ${s.primary_color}); color: #fff; font-weight: 700; }
:where(.ac-bump-ribbon .ac-ribbon input) { margin: 0; accent-color: #fff; }
:where(.ac-bump-ribbon .ac-bump-body) { padding: 12px 14px; }
:where(.ac-bump-body) { display: flex; gap: 12px; flex: 1; min-width: 0; }
:where(.ac-summary) {
  background: ${s.summary_background}; border-radius: ${s.radius}; padding: 18px; display: flex; flex-direction: column; gap: 10px;
  position: sticky; top: 16px;
}
:where(.ac-line) { display: flex; justify-content: space-between; gap: 12px; font-size: .95em; }
:where(.ac-total) { font-weight: 700; font-size: 1.1em; border-top: 1px solid ${s.border_color}; padding-top: 10px; }
:where(.ac-promo) { display: flex; gap: 8px; }
:where(.ac-promo .af-input) { flex: 1; padding: 8px 10px; }
:where(.ac-link) { all: unset; cursor: pointer; color: ${s.primary_color}; font-size: .85em; font-weight: 600; }
:where(.ac-small-button) { border: 1px solid ${s.primary_color}; color: ${s.primary_color}; background: transparent; border-radius: ${s.radius}; padding: 8px 12px; font: inherit; font-weight: 600; cursor: pointer; }
:where(.ac-ok) { color: #15803d; font-size: .85em; }
:where(.ac-warn) { color: #b45309; font-size: .85em; }
:where(.ac-payment) { min-height: 40px; }
:where(.ac-offer) { display: flex; flex-direction: column; gap: 14px; text-align: center; align-items: center; padding: 8px; }
:where(.ac-offer-img) { width: 100%; max-width: 420px; max-height: 320px; object-fit: contain; border-radius: ${s.radius}; }
:where(.ac-offer-title) { font-size: 1.4em; font-weight: 800; margin: 0; }
:where(.ac-offer-price) { font-size: 1.6em; font-weight: 800; color: ${s.primary_color}; }
:where(.ac-offer .af-button) { width: 100%; max-width: 420px; font-size: 1.05em; padding: 16px; }
:where(.ac-decline) { all: unset; cursor: pointer; text-decoration: underline; opacity: .7; font-size: .9em; }
${custom}
`;
}

/** The Payment Element lives in the light DOM (Stripe iframes do not support shadow roots), slotted in. */
export const PAYMENT_SLOT = 'amable-payment';
