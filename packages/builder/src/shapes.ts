/**
 * Shape dividers for canvas sections. Every shape is an SVG with viewBox
 * 0 0 1200 120 drawn with the filled area resting on the BOTTOM edge of the
 * box: the renderer uses it as is for the bottom divider and rotates it 180
 * degrees for the top one. The color comes from CSS via `currentColor`;
 * layers use fill-opacity.
 */

export interface ShapeDivider {
  id: string;
  label: string;
  /** Full `<svg ...>...</svg>` markup with fill="currentColor". */
  svg: string;
}

const VB = 'viewBox="0 0 1200 120" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"';

function svgOf(inner: string): string {
  return `<svg ${VB} fill="currentColor">${inner}</svg>`;
}

/** Zigzag regolare: denti triangolari lungo tutta la larghezza. */
function zigzagPath(teeth: number, height: number): string {
  const w = 1200 / teeth;
  let d = `M0,120 L0,${120 - height}`;
  for (let i = 0; i < teeth; i++) {
    d += ` l${w / 2},${height} l${w / 2},${-height}`;
  }
  d += ` L1200,120 Z`;
  return d;
}

/** Dense zigzag dash pattern (waves-pattern). */
function wavesPatternPath(): string {
  const w = 1200 / 60;
  let d = `M0,120 L0,60`;
  for (let i = 0; i < 60; i++) {
    const h = i % 2 === 0 ? 46 : 30;
    d += ` l${w / 2},${h} l${w / 2},${-h}`;
  }
  d += ` L1200,120 Z`;
  return d;
}

/** Drops: rounded fingers of alternating height rising from the edge. */
function dropsPath(): string {
  const heights = [70, 34, 55, 26, 78, 40, 62, 30, 72, 46, 58, 36];
  const w = 100;
  let d = `M0,120`;
  heights.forEach((h, i) => {
    const x = i * w;
    const r = w / 2 - 6;
    d += ` L${x + 6},120 L${x + 6},${120 - h + r} A${r},${r} 0 0 1 ${x + 6 + 2 * r},${120 - h + r} L${x + 6 + 2 * r},120`;
  });
  d += ` L1200,120 Z`;
  return d;
}

/** Clouds: overlapping circular bumps along the edge. */
function cloudsInner(): string {
  const bumps: Array<[number, number]> = [
    [40, 42], [150, 58], [280, 38], [390, 62], [520, 44], [640, 66],
    [770, 40], [880, 58], [1010, 46], [1120, 60], [1200, 38],
  ];
  const circles = bumps
    .map(([cx, r]) => `<circle cx="${cx}" cy="120" r="${r}"/>`)
    .join("");
  return `${circles}<rect x="0" y="96" width="1200" height="24"/>`;
}

export const SHAPE_DIVIDERS: ShapeDivider[] = [
  {
    id: "waves",
    label: "Waves",
    svg: svgOf(
      '<path fill-opacity="0.25" d="M0,64 C200,20 400,100 600,60 C800,20 1000,90 1200,50 L1200,120 L0,120 Z"/>' +
        '<path fill-opacity="0.5" d="M0,80 C200,40 450,110 650,75 C850,40 1050,100 1200,70 L1200,120 L0,120 Z"/>' +
        '<path d="M0,95 C250,60 500,115 750,90 C950,70 1100,105 1200,88 L1200,120 L0,120 Z"/>',
    ),
  },
  {
    id: "wave-brush",
    label: "Wave brush",
    svg: svgOf(
      '<path d="M0,70 C60,50 90,90 150,72 C190,60 210,85 260,70 C330,48 360,95 430,75 C480,62 520,88 580,68 C650,45 690,92 760,72 C820,55 850,86 910,70 C970,52 1010,90 1080,72 C1130,60 1170,80 1200,68 L1200,120 L0,120 Z"/>',
    ),
  },
  { id: "waves-pattern", label: "Waves pattern", svg: svgOf(`<path d="${wavesPatternPath()}"/>`) },
  { id: "drops", label: "Drops", svg: svgOf(`<path d="${dropsPath()}"/>`) },
  { id: "clouds", label: "Clouds", svg: svgOf(cloudsInner()) },
  { id: "zigzag", label: "Zigzag", svg: svgOf(`<path d="${zigzagPath(24, 34)}"/>`) },
  {
    id: "mountains",
    label: "Mountains",
    svg: svgOf(
      '<path fill-opacity="0.5" d="M0,120 L180,45 L340,95 L520,30 L700,90 L880,40 L1050,85 L1200,55 L1200,120 Z"/>' +
        '<path d="M0,120 L250,70 L450,110 L650,55 L850,105 L1050,70 L1200,95 L1200,120 Z"/>',
    ),
  },
  {
    id: "pyramids",
    label: "Pyramids",
    svg: svgOf(
      '<path fill-opacity="0.4" d="M0,120 L900,15 L1200,120 Z"/>' +
        '<path d="M0,120 L600,45 L1200,120 Z"/>',
    ),
  },
  { id: "triangle", label: "Triangle", svg: svgOf('<path d="M0,120 L600,25 L1200,120 Z"/>') },
  {
    id: "triangle-asym",
    label: "Asymmetric triangle",
    svg: svgOf('<path d="M0,120 L850,20 L1200,120 Z"/>'),
  },
  { id: "tilt", label: "Tilt", svg: svgOf('<path d="M0,120 L1200,25 L1200,120 Z"/>') },
  {
    id: "tilt-opacity",
    label: "Tilt opacity",
    svg: svgOf(
      '<path fill-opacity="0.4" d="M0,120 L1200,10 L1200,120 Z"/>' +
        '<path d="M0,120 L1200,55 L1200,120 Z"/>',
    ),
  },
  {
    id: "fan-opacity",
    label: "Fan opacity",
    svg: svgOf(
      '<path fill-opacity="0.3" d="M0,120 L1200,0 L1200,120 Z"/>' +
        '<path fill-opacity="0.5" d="M0,120 L1200,45 L1200,120 Z"/>' +
        '<path d="M0,120 L1200,85 L1200,120 Z"/>',
    ),
  },
  { id: "curve", label: "Curve", svg: svgOf('<path d="M0,120 C400,20 800,20 1200,120 Z"/>') },
  {
    id: "curve-asym",
    label: "Asymmetric curve",
    svg: svgOf('<path d="M0,120 C200,15 700,25 1200,120 Z"/>'),
  },
  {
    id: "arrow",
    label: "Arrow",
    svg: svgOf('<path d="M0,120 L0,85 L540,85 L600,45 L660,85 L1200,85 L1200,120 Z"/>'),
  },
  {
    id: "split",
    label: "Split",
    svg: svgOf('<path d="M0,120 L0,100 L570,100 L600,40 L630,100 L1200,100 L1200,120 Z"/>'),
  },
  {
    id: "book",
    label: "Book",
    svg: svgOf('<path d="M0,120 C250,30 500,30 600,105 C700,30 950,30 1200,120 Z"/>'),
  },
];

export function shapeDividerById(id: string): ShapeDivider | undefined {
  return SHAPE_DIVIDERS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Custom SVG sanitization (upload) by reconstruction: only an allowlist of
// geometric tags/attributes is kept and the markup is rewritten from
// scratch, so scripts, event handlers, external references and CSS cannot
// survive. Works both in the worker and in the browser (no DOM).
// ---------------------------------------------------------------------------

const MAX_SVG_BYTES = 50 * 1024;

const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "polygon",
  "polyline",
  "rect",
  "circle",
  "ellipse",
  "line",
]);

const DRAWING_TAGS = new Set(["path", "polygon", "polyline", "rect", "circle", "ellipse", "line"]);

const ALLOWED_ATTRS = new Set([
  "d",
  "points",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "width",
  "height",
  "transform",
  "opacity",
  "fill",
  "fill-opacity",
  "fill-rule",
  "clip-rule",
]);

function escAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  closing: boolean;
}

/** Tokenizes the next tag starting at `<`; null when malformed. */
function parseTag(src: string, start: number): { tag: ParsedTag; end: number } | null {
  const end = src.indexOf(">", start);
  if (end === -1) return null;
  let inner = src.slice(start + 1, end).trim();
  const closing = inner.startsWith("/");
  if (closing) inner = inner.slice(1).trim();
  let selfClosing = false;
  if (inner.endsWith("/")) {
    selfClosing = true;
    inner = inner.slice(0, -1).trim();
  }
  const nameMatch = inner.match(/^[a-zA-Z][\w:-]*/);
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  const rest = inner.slice(nameMatch[0].length);
  while ((m = attrRe.exec(rest))) {
    attrs[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? "";
  }
  return { tag: { name, attrs, selfClosing, closing }, end: end + 1 };
}

export interface SanitizedShape {
  svg: string;
}

/**
 * Sanitizes an arbitrary SVG and normalizes it as a divider: viewBox kept
 * (or derived from width/height), `preserveAspectRatio="none"`,
 * `fill="currentColor"` on the root and explicit fills rewritten so the
 * color is controlled from CSS. Null when the file is unusable.
 */
export function sanitizeSvgShape(raw: string): SanitizedShape | null {
  if (!raw || raw.length > MAX_SVG_BYTES) return null;

  // Strip comments/CDATA/doctype before parsing.
  const src = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<[!?][^>]*>/g, "");

  const svgStart = src.search(/<svg[\s>]/i);
  if (svgStart === -1) return null;

  let out = "";
  let drawingCount = 0;
  const openStack: string[] = [];
  // A tag NOT in the allowlist drops its whole subtree.
  let mutedDepth = 0;
  let mutedTag = "";
  let rootAttrs: Record<string, string> | null = null;

  let i = svgStart;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    const parsed = parseTag(src, lt);
    if (!parsed) {
      i = lt + 1;
      continue;
    }
    const { tag } = parsed;
    i = parsed.end;

    if (mutedDepth > 0) {
      // Inside a dropped subtree: only track the nesting of the muted tag.
      if (tag.name === mutedTag) {
        if (tag.closing) mutedDepth--;
        else if (!tag.selfClosing) mutedDepth++;
      }
      continue;
    }

    if (tag.closing) {
      if (openStack.length > 0 && openStack[openStack.length - 1] === tag.name) {
        openStack.pop();
        out += `</${tag.name}>`;
        if (tag.name === "svg") break;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag.name) || (tag.name === "svg" && rootAttrs !== null)) {
      if (!tag.selfClosing) {
        mutedDepth = 1;
        mutedTag = tag.name;
      }
      continue;
    }

    const kept: string[] = [];
    for (const [k, v] of Object.entries(tag.attrs)) {
      if (!ALLOWED_ATTRS.has(k)) continue;
      if (k === "fill") {
        kept.push(`fill="${v.trim().toLowerCase() === "none" ? "none" : "currentColor"}"`);
        continue;
      }
      kept.push(`${k}="${escAttr(v)}"`);
    }

    if (tag.name === "svg") {
      rootAttrs = tag.attrs;
      const vb = (tag.attrs["viewbox"] ?? "").trim();
      const w = Number.parseFloat(tag.attrs["width"] ?? "");
      const h = Number.parseFloat(tag.attrs["height"] ?? "");
      const viewBox = /^[\d.\s-]+$/.test(vb) && vb.split(/\s+/).length === 4
        ? vb
        : Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
          ? `0 0 ${w} ${h}`
          : "0 0 1200 120";
      out += `<svg viewBox="${escAttr(viewBox)}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" fill="currentColor">`;
      openStack.push("svg");
      continue;
    }

    if (DRAWING_TAGS.has(tag.name)) drawingCount++;
    out += `<${tag.name}${kept.length ? " " + kept.join(" ") : ""}${tag.selfClosing ? "/>" : ">"}`;
    if (!tag.selfClosing) openStack.push(tag.name);
  }

  // Close tags left open (malformed but recoverable input).
  while (openStack.length > 0) out += `</${openStack.pop()}>`;

  if (rootAttrs === null || drawingCount === 0) return null;
  if (out.length > MAX_SVG_BYTES) return null;
  return { svg: out };
}
