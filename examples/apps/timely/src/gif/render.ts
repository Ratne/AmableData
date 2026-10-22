import { digitHeight, pad, splitRemaining, unitLabel, type TimerStyle, type Unit } from '../style';
import { encodeGif, type GifFrame } from './encoder';
import { DIGIT_ADVANCE, glyphOf, rasterize, type Bitmap } from './font';

/**
 * The email timer: an animated GIF counting down from the remaining time for
 * up to 60 seconds, then resting on the last frame. Opening the email again
 * fetches a new one, so the time shown is always the real one.
 */

export const MAX_FRAMES = 60;

const WEIGHT: Readonly<Record<TimerStyle['weight'], number>> = { thin: 0.42, regular: 0.62, bold: 0.86 };
const LEVELS = 16;

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** One base color fading into one ink color, `LEVELS` entries of the palette. */
interface Ramp {
  readonly base: number;
}

const glyphCache = new Map<string, Bitmap>();

function glyphBitmap(char: string, unit: number, halfWidth: number): Bitmap {
  const key = `${char}|${unit.toFixed(3)}|${halfWidth.toFixed(3)}`;
  let bitmap = glyphCache.get(key);
  if (bitmap === undefined) {
    bitmap = rasterize(glyphOf(char), unit, halfWidth);
    if (glyphCache.size > 2000) glyphCache.clear();
    glyphCache.set(key, bitmap);
  }
  return bitmap;
}

class Canvas {
  readonly pixels: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.pixels = new Uint8Array(width * height);
  }

  /** Draws `text` with its top-left glyph origin at (x, y). */
  text(text: string, x: number, y: number, unit: number, halfWidth: number, ramp: Ramp, spacing: number, fixedAdvance?: number): void {
    let cursor = x;
    for (const char of text) {
      const bitmap = glyphBitmap(char, unit, halfWidth);
      const left = Math.round(cursor) - bitmap.originX;
      const top = Math.round(y) - bitmap.originY;
      for (let by = 0; by < bitmap.height; by += 1) {
        const cy = top + by;
        if (cy < 0 || cy >= this.height) continue;
        for (let bx = 0; bx < bitmap.width; bx += 1) {
          const cx = left + bx;
          const alpha = bitmap.alpha[by * bitmap.width + bx]!;
          if (alpha === 0 || cx < 0 || cx >= this.width) continue;
          const level = Math.round((alpha / 255) * (LEVELS - 1));
          if (level > 0) this.pixels[cy * this.width + cx] = ramp.base + level;
        }
      }
      cursor += ((fixedAdvance ?? glyphOf(char).advance) + spacing) * unit;
    }
  }

  /** Anti-aliased rounded rectangle filled with the ramp's ink. */
  box(x: number, y: number, width: number, height: number, radius: number, ramp: Ramp): void {
    const cx = x + width / 2;
    const cy = y + height / 2;
    const hx = width / 2 - radius;
    const hy = height / 2 - radius;
    for (let py = Math.floor(y); py < Math.ceil(y + height); py += 1) {
      if (py < 0 || py >= this.height) continue;
      for (let px = Math.floor(x); px < Math.ceil(x + width); px += 1) {
        if (px < 0 || px >= this.width) continue;
        const qx = Math.max(Math.abs(px + 0.5 - cx) - hx, 0);
        const qy = Math.max(Math.abs(py + 0.5 - cy) - hy, 0);
        const coverage = 0.5 - (Math.sqrt(qx * qx + qy * qy) - radius);
        if (coverage <= 0) continue;
        this.pixels[py * this.width + px] = ramp.base + Math.round(Math.min(1, coverage) * (LEVELS - 1));
      }
    }
  }

  copyFrom(source: Canvas, x: number, y: number, width: number, height: number): void {
    for (let row = y; row < y + height; row += 1) {
      const start = row * this.width + x;
      this.pixels.set(source.pixels.subarray(start, start + width), start);
    }
  }

  crop(x: number, y: number, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      const start = (y + row) * this.width + x;
      out.set(this.pixels.subarray(start, start + width), row * width);
    }
    return out;
  }
}

interface Column {
  readonly unit: Unit;
  readonly digits: number;
  readonly x: number;
  readonly width: number;
  readonly boxX: number;
  readonly boxWidth: number;
}

interface Layout {
  readonly width: number;
  readonly height: number;
  readonly columns: readonly Column[];
  readonly boxY: number;
  readonly boxHeight: number;
  readonly unit: number;
  readonly halfWidth: number;
  readonly digitSpacing: number;
}

function textWidth(text: string, unit: number, spacing: number): number {
  let width = 0;
  for (const char of text) width += (glyphOf(char).advance + spacing) * unit;
  return Math.max(0, width - spacing * unit);
}

function labelMetrics(style: TimerStyle) {
  const height = Math.max(9, Math.round(digitHeight(style) * 0.3));
  const unit = height / 6;
  return { height, unit, halfWidth: Math.max(0.65, unit * 0.55), spacing: 1.3 };
}

function layoutOf(style: TimerStyle, digitsPerUnit: Readonly<Partial<Record<Unit, number>>>): Layout {
  const h = digitHeight(style);
  const unit = h / 6;
  const halfWidth = unit * WEIGHT[style.weight];
  const digitSpacing = 1.5;
  const padX = 2.2 * unit;
  const padY = 1.9 * unit;
  const margin = Math.round(2.4 * unit);
  const boxHeight = Math.round(h + 2 * padY);
  const label = labelMetrics(style);
  const gap = style.separators ? Math.round(4.4 * unit) : Math.round(2.4 * unit);
  const columns: Column[] = [];
  let x = margin;
  for (const u of style.units) {
    const digits = Math.max(2, digitsPerUnit[u] ?? 2);
    const boxWidth = Math.round(digits * (DIGIT_ADVANCE + digitSpacing) * unit - digitSpacing * unit + 2 * padX);
    const labelWidth = style.show_labels ? Math.ceil(textWidth(unitLabel(style, u), label.unit, label.spacing)) : 0;
    const width = Math.max(boxWidth, labelWidth);
    columns.push({ unit: u, digits, x, width, boxX: x + Math.round((width - boxWidth) / 2), boxWidth });
    x += width + gap;
  }
  const labelsHeight = style.show_labels ? Math.round(1.5 * unit + label.height * 1.15) : 0;
  return {
    width: x - gap + margin,
    height: margin * 2 + boxHeight + labelsHeight,
    columns,
    boxY: margin,
    boxHeight,
    unit,
    halfWidth,
    digitSpacing,
  };
}

interface Ramps {
  readonly box: Ramp;
  readonly digits: Ramp;
  readonly labels: Ramp;
  readonly separators: Ramp;
  readonly palette: number[];
}

function rampsOf(style: TimerStyle): Ramps {
  const background = rgb(style.background);
  const box = rgb(style.box);
  const pairs: Array<readonly [Rgb, Rgb]> = [
    [background, box],
    [style.boxes ? box : background, rgb(style.digits)],
    [background, rgb(style.labels)],
    [background, rgb(style.boxes ? style.labels : style.digits)],
  ];
  const palette: number[] = [];
  for (const [from, to] of pairs) {
    for (let level = 0; level < LEVELS; level += 1) {
      const t = level / (LEVELS - 1);
      for (let c = 0; c < 3; c += 1) palette.push(Math.round(from[c]! + (to[c]! - from[c]!) * t));
    }
  }
  return { box: { base: 0 }, digits: { base: LEVELS }, labels: { base: LEVELS * 2 }, separators: { base: LEVELS * 3 }, palette };
}

/** Background, boxes, labels and separators: everything that does not move. */
function staticCanvas(style: TimerStyle, layout: Layout, ramps: Ramps): Canvas {
  const canvas = new Canvas(layout.width, layout.height);
  const radius = style.radius * (layout.boxHeight / 2);
  const label = labelMetrics(style);
  layout.columns.forEach((column, index) => {
    if (style.boxes) canvas.box(column.boxX, layout.boxY, column.boxWidth, layout.boxHeight, Math.min(radius, column.boxWidth / 2), ramps.box);
    if (style.show_labels) {
      const text = unitLabel(style, column.unit);
      const x = column.x + (column.width - textWidth(text, label.unit, label.spacing)) / 2;
      canvas.text(text, x, layout.boxY + layout.boxHeight + 1.5 * layout.unit, label.unit, label.halfWidth, ramps.labels, label.spacing);
    }
    const next = layout.columns[index + 1];
    if (style.separators && next !== undefined) {
      const center = (column.x + column.width + next.x) / 2;
      canvas.text(':', center - 0.5 * layout.unit, layout.boxY + (layout.boxHeight - 6 * layout.unit) / 2, layout.unit, layout.halfWidth, ramps.separators, 0);
    }
  });
  return canvas;
}

function drawDigits(canvas: Canvas, base: Canvas, layout: Layout, column: Column, value: string, ramps: Ramps): void {
  canvas.copyFrom(base, column.boxX, layout.boxY, column.boxWidth, layout.boxHeight);
  const textW = value.length * (DIGIT_ADVANCE + layout.digitSpacing) * layout.unit - layout.digitSpacing * layout.unit;
  const x = column.boxX + (column.boxWidth - textW) / 2;
  const y = layout.boxY + (layout.boxHeight - 6 * layout.unit) / 2;
  canvas.text(value, x, y, layout.unit, layout.halfWidth, ramps.digits, layout.digitSpacing, DIGIT_ADVANCE);
}

/** The expired state on the same canvas size, so the email layout does not jump. */
function expiredCanvas(style: TimerStyle, layout: Layout, ramps: Ramps): Canvas {
  const canvas = new Canvas(layout.width, layout.height);
  const text = style.expired_text.trim();
  const fit = (layout.width * 0.86) / Math.max(1, textWidth(text, 1, 1.2));
  const unit = Math.min(layout.unit * 0.8, fit, (layout.height * 0.5) / 6);
  const radius = style.radius * (layout.boxHeight / 2);
  const boxY = (layout.height - layout.boxHeight) / 2;
  if (style.boxes) canvas.box(layout.columns[0]!.boxX, boxY, layout.width - 2 * layout.columns[0]!.boxX, layout.boxHeight, radius, ramps.box);
  const ramp = style.boxes ? ramps.digits : ramps.separators;
  canvas.text(text, (layout.width - textWidth(text, unit, 1.2)) / 2, (layout.height - 6 * unit) / 2, unit, Math.max(0.7, unit * WEIGHT[style.weight]), ramp, 1.2);
  return canvas;
}

function valuesOf(style: TimerStyle, seconds: number): Map<Unit, string> {
  const parts = splitRemaining(seconds, style.units);
  return new Map(style.units.map((u) => [u, pad(parts.values[u] ?? 0)]));
}

export interface RenderOptions {
  /** Seconds left at the first frame (<= 0: expired). */
  readonly remaining: number;
  /** A countdown that has not started: one still frame of the full window. */
  readonly still?: boolean;
}

export function renderTimerGif(style: TimerStyle, options: RenderOptions): Uint8Array {
  const remaining = Math.max(0, Math.floor(options.remaining));
  const first = valuesOf(style, remaining);
  const digits = Object.fromEntries([...first].map(([u, v]) => [u, v.length]));
  const layout = layoutOf(style, digits);
  const ramps = rampsOf(style);
  const base = staticCanvas(style, layout, ramps);
  const full = (pixels: Uint8Array, delay: number): GifFrame => ({ left: 0, top: 0, width: layout.width, height: layout.height, pixels, delay });
  const expired = style.expired_text.trim() === '' ? null : expiredCanvas(style, layout, ramps);

  if (remaining === 0 && expired !== null) return encodeGif(layout.width, layout.height, ramps.palette, [full(expired.pixels, 0)]);

  const canvas = new Canvas(layout.width, layout.height);
  canvas.pixels.set(base.pixels);
  for (const column of layout.columns) drawDigits(canvas, base, layout, column, first.get(column.unit)!, ramps);
  const frames: GifFrame[] = [full(canvas.pixels.slice(), 100)];
  const count = options.still === true ? 1 : Math.min(MAX_FRAMES, remaining + 1);
  let previous = first;
  for (let i = 1; i < count; i += 1) {
    const values = valuesOf(style, remaining - i);
    let left = Infinity;
    let right = -Infinity;
    for (const column of layout.columns) {
      const value = values.get(column.unit)!;
      if (value === previous.get(column.unit) || value.length > column.digits) continue;
      drawDigits(canvas, base, layout, column, value, ramps);
      left = Math.min(left, column.boxX);
      right = Math.max(right, column.boxX + column.boxWidth);
    }
    previous = values;
    if (left === Infinity) continue;
    frames.push({
      left,
      top: layout.boxY,
      width: right - left,
      height: layout.boxHeight,
      pixels: canvas.crop(left, layout.boxY, right - left, layout.boxHeight),
      delay: 100,
    });
  }
  if (expired !== null && count === remaining + 1 && options.still !== true) frames.push(full(expired.pixels, 0));
  return encodeGif(layout.width, layout.height, ramps.palette, frames);
}
