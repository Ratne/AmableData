import type { FormStyle } from '../schema';

/**
 * Widget stylesheet, injected in the form's shadow root. Selectors are wrapped
 * in `:where()` (zero specificity) so the form's custom CSS always wins.
 */
export function buildStyles(s: FormStyle): string {
  return `
:host { all: initial; display: block; }
* { box-sizing: border-box; }
:where(.af-root) {
  font-family: ${s.font_family}; font-size: ${s.font_size}; color: ${s.text_color};
  background: ${s.background_color}; max-width: ${s.max_width}; width: 100%; margin: 0 auto;
  line-height: 1.45;
}
:where(.af-form) { display: flex; flex-wrap: wrap; gap: ${s.gap}; }
:where(.af-field) { display: flex; flex-direction: column; gap: 6px; flex: 1 1 100%; min-width: 0; }
:where(.af-half) { flex: 1 1 calc(50% - ${s.gap}); min-width: 180px; }
:where(.af-label) { font-weight: 600; font-size: .95em; }
:where(.af-req) { color: ${s.primary_color}; }
:where(.af-desc) { font-size: .85em; opacity: .75; }
:where(.af-input, .af-textarea, .af-select) {
  width: 100%; font: inherit; color: inherit; padding: 11px 13px;
  border: 1px solid ${s.border_color}; border-radius: ${s.radius}; background: ${s.input_background};
  outline: 0; transition: border-color .15s, box-shadow .15s;
}
:where(.af-textarea) { min-height: 110px; resize: vertical; }
:where(.af-input:focus, .af-textarea:focus, .af-select:focus) {
  border-color: ${s.primary_color}; box-shadow: 0 0 0 3px color-mix(in srgb, ${s.primary_color} 20%, transparent);
}
:where(.af-invalid .af-input, .af-invalid .af-textarea, .af-invalid .af-select) { border-color: #dc2626; }
:where(.af-choices) { display: flex; flex-direction: column; gap: 8px; }
:where(.af-choice) { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
:where(.af-choice input) { width: 18px; height: 18px; margin: 2px 0 0; accent-color: ${s.primary_color}; flex: none; }
:where(.af-choice a) { color: ${s.primary_color}; }
:where(.af-rating) { display: flex; gap: 4px; }
:where(.af-star) {
  border: 0; background: none; cursor: pointer; font-size: 1.7em; line-height: 1; padding: 0;
  color: ${s.border_color};
}
:where(.af-star-on) { color: ${s.primary_color}; }
:where(.af-heading) { font-size: 1.2em; font-weight: 700; margin: 4px 0 0; }
:where(.af-step-title) { font-size: 1.1em; font-weight: 700; flex: 1 1 100%; }
:where(.af-progress) { font-size: .85em; opacity: .7; flex: 1 1 100%; }
:where(.af-error) { color: #dc2626; font-size: .85em; }
:where(.af-alert) { flex: 1 1 100%; color: #b91c1c; background: #fef2f2; border-radius: ${s.radius}; padding: 10px 12px; font-size: .9em; }
:where(.af-notice) { flex: 1 1 100%; background: #fffbeb; color: #92400e; border-radius: ${s.radius}; padding: 8px 12px; font-size: .85em; }
:where(.af-actions) { display: flex; gap: 10px; flex: 1 1 100%; }
:where(.af-button) {
  flex: 1; border: 0; border-radius: ${s.radius}; cursor: pointer; font: inherit; font-weight: 600;
  padding: 13px 16px; background: ${s.primary_color}; color: ${s.button_text_color};
}
:where(.af-button:disabled) { opacity: .6; cursor: not-allowed; }
:where(.af-secondary) { flex: 0 0 auto; background: transparent; color: ${s.text_color}; border: 1px solid ${s.border_color}; }
:where(.af-success) {
  padding: 24px; text-align: center; border-radius: ${s.radius};
  background: color-mix(in srgb, ${s.primary_color} 10%, transparent);
}
:where(.af-hp) { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
:where(.af-turnstile) { flex: 1 1 100%; }
${s.custom_css}
`;
}
