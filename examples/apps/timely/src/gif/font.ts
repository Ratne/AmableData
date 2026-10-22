/**
 * A rounded stroke font for the email timer: every glyph is a few polylines on
 * a grid 6 units tall, drawn as thick round-capped strokes with anti-aliasing.
 * No font files, no canvas: it renders crisply at any size and weight.
 */

type Point = readonly [number, number];
export type Stroke = readonly Point[];

export interface Glyph {
  readonly advance: number;
  readonly strokes: readonly Stroke[];
}

/** Points of an elliptic arc from `a0` to `a1` degrees (0 = right, 90 = down). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number): Point[] {
  const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 12));
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return points;
}

const dot = (x: number, y: number): Stroke => [[x, y]];
const g = (advance: number, ...strokes: Stroke[]): Glyph => ({ advance, strokes });

const GLYPHS: Readonly<Record<string, Glyph>> = {
  '0': g(4, arc(2, 3, 2, 3, 0, 360)),
  '1': g(4, [[0.9, 1.1], [2.2, 0], [2.2, 6]]),
  '2': g(4, [...arc(2, 1.9, 1.95, 1.9, -165, 25), [0, 6], [4, 6]]),
  '3': g(4, [...arc(2, 1.5, 1.85, 1.5, -160, 90), ...arc(2, 4.5, 2, 1.5, -90, 160)]),
  '4': g(4, [[3, 6], [3, 0], [0, 4.2], [4, 4.2]]),
  '5': g(4, [[3.8, 0], [0.6, 0], [0.4, 2.9], ...arc(2, 4.1, 1.95, 1.9, -140, 140)]),
  '6': g(4, arc(2, 4.05, 2, 1.95, 0, 360), arc(4.2, 4.05, 4.2, 4.05, 180, 248)),
  '7': g(4, [[0, 0], [4, 0], [1.4, 6]]),
  '8': g(4, arc(2, 1.45, 1.7, 1.45, 0, 360), arc(2, 4.4, 2, 1.6, 0, 360)),
  '9': g(4, arc(2, 1.95, 2, 1.95, 0, 360), arc(-0.2, 1.95, 4.2, 4.05, 0, 68)),
  ':': g(1, dot(0.5, 1.9), dot(0.5, 4.6)),
  ' ': g(2.2),
  '.': g(1, dot(0.5, 6)),
  ',': g(1, [[0.7, 5.6], [0.3, 6.8]]),
  '!': g(1, [[0.5, 0], [0.5, 4.2]], dot(0.5, 6)),
  '?': g(4, [...arc(2, 1.6, 1.9, 1.6, -165, 60), [2, 4.2]], dot(2, 6)),
  '-': g(2.6, [[0, 3.2], [2.6, 3.2]]),
  '+': g(3.4, [[0, 3.2], [3.4, 3.2]], [[1.7, 1.5], [1.7, 4.9]]),
  '/': g(3, [[0, 6], [3, 0]]),
  "'": g(1, [[0.5, 0], [0.5, 1.6]]),
  '%': g(4.4, arc(0.9, 1.1, 0.9, 1.1, 0, 360), arc(3.5, 4.9, 0.9, 1.1, 0, 360), [[0.2, 6], [4.2, 0]]),
  A: g(4.4, [[0, 6], [2.2, 0], [4.4, 6]], [[0.75, 4], [3.65, 4]]),
  B: g(4, [[0, 3], [0, 0], [2.4, 0], ...arc(2.4, 1.5, 1.4, 1.5, -90, 90), [0, 3], [2.6, 3], ...arc(2.6, 4.5, 1.4, 1.5, -90, 90), [0, 6], [0, 3]]),
  C: g(4.2, arc(2.3, 3, 2.3, 3, -40, -320)),
  D: g(4.2, [[0, 0], [1.4, 0], ...arc(1.4, 3, 2.8, 3, -90, 90), [0, 6], [0, 0]]),
  E: g(3.6, [[3.6, 0], [0, 0], [0, 6], [3.6, 6]], [[0, 3], [3, 3]]),
  F: g(3.6, [[3.6, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]),
  G: g(4.4, [...arc(2.3, 3, 2.3, 3, -40, -360), [2.5, 3]]),
  H: g(4, [[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]),
  I: g(1, [[0.5, 0], [0.5, 6]]),
  J: g(3.6, [[3.6, 0], [3.6, 4.2], ...arc(1.8, 4.2, 1.8, 1.8, 0, 180)]),
  K: g(4, [[0, 0], [0, 6]], [[4, 0], [0, 3.8]], [[1.4, 2.8], [4, 6]]),
  L: g(3.6, [[0, 0], [0, 6], [3.6, 6]]),
  M: g(5, [[0, 6], [0, 0], [2.5, 4], [5, 0], [5, 6]]),
  N: g(4, [[0, 6], [0, 0], [4, 6], [4, 0]]),
  O: g(4.6, arc(2.3, 3, 2.3, 3, 0, 360)),
  P: g(4, [[0, 6], [0, 0], [2.4, 0], ...arc(2.4, 1.6, 1.6, 1.6, -90, 90), [0, 3.2]]),
  Q: g(4.6, arc(2.3, 3, 2.3, 3, 0, 360), [[2.9, 4.4], [4.7, 6.4]]),
  R: g(4, [[0, 6], [0, 0], [2.4, 0], ...arc(2.4, 1.6, 1.6, 1.6, -90, 90), [0, 3.2]], [[2, 3.2], [4, 6]]),
  S: g(4, [...arc(2, 1.5, 1.9, 1.5, -20, -270), ...arc(2, 4.5, 2, 1.5, -90, 160)]),
  T: g(4, [[0, 0], [4, 0]], [[2, 0], [2, 6]]),
  U: g(4, [[0, 0], [0, 4], ...arc(2, 4, 2, 2, 180, 0), [4, 0]]),
  V: g(4.4, [[0, 0], [2.2, 6], [4.4, 0]]),
  W: g(6, [[0, 0], [1.5, 6], [3, 1.5], [4.5, 6], [6, 0]]),
  X: g(4, [[0, 0], [4, 6]], [[4, 0], [0, 6]]),
  Y: g(4.4, [[0, 0], [2.2, 3], [4.4, 0]], [[2.2, 3], [2.2, 6]]),
  Z: g(4, [[0, 0], [4, 0], [0, 6], [4, 6]]),
};

/** Glyph of a character: case and accents folded (È → E); unknown characters are a space. */
export function glyphOf(char: string): Glyph {
  const folded = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return GLYPHS[folded] ?? GLYPHS[' ']!;
}

export const DIGIT_ADVANCE = 4;

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** Coverage 0-255, row by row. */
  readonly alpha: Uint8Array;
  /** Where the glyph origin (top-left of the 6-unit box) sits in the bitmap. */
  readonly originX: number;
  readonly originY: number;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/** Rasterizes a glyph: `unit` px per grid unit, strokes `halfWidth` px from their center line. */
export function rasterize(glyph: Glyph, unit: number, halfWidth: number): Bitmap {
  const pad = Math.ceil(halfWidth + 1);
  const width = Math.ceil(glyph.advance * unit) + pad * 2;
  const height = Math.ceil(6.8 * unit) + pad * 2;
  const alpha = new Uint8Array(width * height);
  const segments: number[] = [];
  for (const stroke of glyph.strokes) {
    const points = stroke.map(([x, y]) => [pad + x * unit, pad + y * unit] as const);
    if (points.length === 1) segments.push(points[0]![0], points[0]![1], points[0]![0], points[0]![1]);
    for (let i = 1; i < points.length; i += 1) segments.push(points[i - 1]![0], points[i - 1]![1], points[i]![0], points[i]![1]);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = Infinity;
      for (let s = 0; s < segments.length; s += 4) {
        const d = segmentDistance(x + 0.5, y + 0.5, segments[s]!, segments[s + 1]!, segments[s + 2]!, segments[s + 3]!);
        if (d < best) best = d;
      }
      const coverage = halfWidth + 0.5 - best;
      if (coverage > 0) alpha[y * width + x] = Math.round(Math.min(1, coverage) * 255);
    }
  }
  return { width, height, alpha, originX: pad, originY: pad };
}
