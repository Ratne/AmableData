/**
 * How a timer looks, shared by the email GIF, the page widget and the editor
 * preview. Everything here is plain data: no DOM, no Worker APIs.
 */

export const UNITS = ['days', 'hours', 'minutes', 'seconds'] as const;
export type Unit = (typeof UNITS)[number];

export const PRESETS = ['classic', 'minimal', 'bold', 'neon', 'soft'] as const;
export type Preset = (typeof PRESETS)[number];

export type Size = 'sm' | 'md' | 'lg';
export type Weight = 'thin' | 'regular' | 'bold';
export type LabelLocale = 'en' | 'it';

export interface TimerStyle {
  readonly preset: Preset;
  /** `#rrggbb` colors. */
  readonly background: string;
  readonly box: string;
  readonly digits: string;
  readonly labels: string;
  /** Boxes around the digits of each unit. */
  readonly boxes: boolean;
  /** Corner radius of the boxes, 0-1 of half the box height. */
  readonly radius: number;
  readonly separators: boolean;
  readonly show_labels: boolean;
  readonly units: readonly Unit[];
  readonly size: Size;
  readonly weight: Weight;
  readonly label_locale: LabelLocale;
  /** Overrides of the unit names; empty strings fall back to the locale's. */
  readonly label_text: Readonly<Partial<Record<Unit, string>>>;
  /** Shown instead of zeros once the deadline passed (empty: zeros). */
  readonly expired_text: string;
  /** Extra CSS for the page widget, scoped by the author with `.timely-<public id>`. */
  readonly custom_css: string;
}

export const LABELS: Readonly<Record<LabelLocale, Record<Unit, string>>> = {
  en: { days: 'Days', hours: 'Hours', minutes: 'Minutes', seconds: 'Seconds' },
  it: { days: 'Giorni', hours: 'Ore', minutes: 'Minuti', seconds: 'Secondi' },
};

type Palette = Pick<TimerStyle, 'background' | 'box' | 'digits' | 'labels' | 'boxes' | 'radius' | 'separators'>;

export const PRESET_PALETTES: Readonly<Record<Preset, Palette>> = {
  classic: { background: '#ffffff', box: '#1f2937', digits: '#ffffff', labels: '#4b5563', boxes: true, radius: 0.3, separators: false },
  minimal: { background: '#ffffff', box: '#ffffff', digits: '#111827', labels: '#6b7280', boxes: false, radius: 0, separators: true },
  bold: { background: '#fff7ed', box: '#ea580c', digits: '#ffffff', labels: '#9a3412', boxes: true, radius: 0.5, separators: false },
  neon: { background: '#0b1020', box: '#151c33', digits: '#4ade80', labels: '#93c5fd', boxes: true, radius: 0.25, separators: true },
  soft: { background: '#f5f3ff', box: '#ffffff', digits: '#6d28d9', labels: '#7c3aed', boxes: true, radius: 1, separators: false },
};

export function presetStyle(preset: Preset, locale: LabelLocale = 'it'): TimerStyle {
  return {
    preset,
    ...PRESET_PALETTES[preset],
    show_labels: true,
    units: UNITS,
    size: 'md',
    weight: 'regular',
    label_locale: locale,
    label_text: {},
    expired_text: '',
    custom_css: '',
  };
}

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_CSS = 20_000;

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
const color = (value: unknown, fallback: string) => (typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback);
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const short = (value: unknown, max: number) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '');

/** Any stored or submitted value as a complete style; unknown fields are dropped. */
export function normalizeStyle(input: unknown): TimerStyle {
  const raw = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const base = presetStyle(pick(raw['preset'], PRESETS, 'classic'), pick<LabelLocale>(raw['label_locale'], ['en', 'it'], 'it'));
  const units = Array.isArray(raw['units']) ? UNITS.filter((u) => (raw['units'] as unknown[]).includes(u)) : base.units;
  const labelText = (raw['label_text'] !== null && typeof raw['label_text'] === 'object' ? raw['label_text'] : {}) as Record<string, unknown>;
  const radius = typeof raw['radius'] === 'number' && Number.isFinite(raw['radius']) ? Math.min(1, Math.max(0, raw['radius'])) : base.radius;
  return {
    preset: base.preset,
    background: color(raw['background'], base.background),
    box: color(raw['box'], base.box),
    digits: color(raw['digits'], base.digits),
    labels: color(raw['labels'], base.labels),
    boxes: bool(raw['boxes'], base.boxes),
    radius,
    separators: bool(raw['separators'], base.separators),
    show_labels: bool(raw['show_labels'], base.show_labels),
    units: units.length === 0 ? base.units : units,
    size: pick(raw['size'], ['sm', 'md', 'lg'], base.size),
    weight: pick(raw['weight'], ['thin', 'regular', 'bold'], base.weight),
    label_locale: base.label_locale,
    label_text: Object.fromEntries(
      UNITS.map((u) => [u, short(labelText[u], 24)] as const).filter(([, v]) => v.trim() !== ''),
    ),
    expired_text: short(raw['expired_text'], 60),
    custom_css: typeof raw['custom_css'] === 'string' ? raw['custom_css'].slice(0, MAX_CSS) : '',
  };
}

export function unitLabel(style: TimerStyle, unit: Unit): string {
  return style.label_text[unit] ?? LABELS[style.label_locale][unit];
}

export interface Parts {
  /** Value per shown unit; the largest shown unit absorbs what the hidden larger ones would show. */
  readonly values: Readonly<Partial<Record<Unit, number>>>;
  readonly expired: boolean;
}

const UNIT_SECONDS: Readonly<Record<Unit, number>> = { days: 86_400, hours: 3_600, minutes: 60, seconds: 1 };

export function splitRemaining(remainingSeconds: number, units: readonly Unit[]): Parts {
  let rest = Math.max(0, Math.floor(remainingSeconds));
  const values: Partial<Record<Unit, number>> = {};
  for (const unit of UNITS) {
    if (!units.includes(unit)) continue;
    values[unit] = Math.floor(rest / UNIT_SECONDS[unit]);
    rest -= values[unit] * UNIT_SECONDS[unit];
  }
  return { values, expired: remainingSeconds <= 0 };
}

export const pad = (value: number) => String(value).padStart(2, '0');

const SIZE_PX: Readonly<Record<Size, number>> = { sm: 28, md: 40, lg: 56 };
export const digitHeight = (style: TimerStyle) => SIZE_PX[style.size];

/**
 * CSS of the page widget: `.timely-<id>` scopes it to one campaign, so
 * several timers on a page keep their own look. The author's CSS comes last.
 */
export function widgetCss(publicId: string, style: TimerStyle): string {
  const scope = `.timely-${publicId}`;
  const h = digitHeight(style);
  const weight = { thin: 300, regular: 600, bold: 800 }[style.weight];
  const radius = style.boxes ? `${String(Math.round((style.radius * (h * 1.5)) / 2))}px` : '0';
  const css = `
${scope}{display:flex;justify-content:center;align-items:flex-start;gap:${String(Math.round(h * 0.3))}px;padding:${String(Math.round(h * 0.35))}px;background:${style.background};font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1;box-sizing:border-box}
${scope} .timely-unit{display:flex;flex-direction:column;align-items:center;gap:${String(Math.round(h * 0.2))}px}
${scope} .timely-value{display:flex;gap:2px;min-width:${String(Math.round(h * 1.4))}px;justify-content:center;padding:${String(Math.round(h * 0.25))}px ${String(Math.round(h * 0.22))}px;border-radius:${radius};background:${style.boxes ? style.box : 'transparent'};color:${style.digits};font-size:${String(h)}px;font-weight:${String(weight)};font-variant-numeric:tabular-nums}
${scope} .timely-label{color:${style.labels};font-size:${String(Math.max(10, Math.round(h * 0.3)))}px;text-transform:uppercase;letter-spacing:.08em}
${scope} .timely-sep{color:${style.digits};font-size:${String(h)}px;font-weight:${String(weight)};padding-top:${String(Math.round(h * 0.25))}px}
${scope} .timely-expired{color:${style.digits};font-size:${String(Math.round(h * 0.7))}px;font-weight:${String(weight)};padding:${String(Math.round(h * 0.25))}px}
${scope}.timely-bar{position:fixed;left:0;right:0;z-index:2147483000;box-shadow:0 2px 12px rgba(0,0,0,.18)}
${scope}.timely-bar.timely-top{top:0}${scope}.timely-bar.timely-bottom{bottom:0}
`;
  return `${css}${style.custom_css.replace(/<\//g, '<\\/')}`;
}
