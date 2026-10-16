import {
  type ElementNode,
  type ControlDef,
  type StyleVariant,
  type Breakpoint,
  BREAKPOINT_MAXWIDTH,
  sectionsForType,
} from "./schema";

/** Escape a string for safe insertion into HTML text/attribute context. */
export function esc(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The generated wrapper class for a node id. */
export function wrapperClass(id: string): string {
  return `b-${id}`;
}

/**
 * Neutralize URLs that could run script: only http(s), mailto, tel, in-page
 * anchors and relative URLs pass; anything else (javascript:, data:, vbscript:
 * …) becomes "".
 */
export function safeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  const compact = url.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact);
  if (!scheme) return url;
  return ["http", "https", "mailto", "tel"].includes(scheme[1] ?? "") ? url : "";
}

/** Map a media-url control value (string | {url}) to a safe URL string. */
export function mediaUrl(value: unknown): string {
  if (typeof value === "string") return safeUrl(value);
  if (value && typeof value === "object" && "url" in value) {
    const u = (value as { url?: unknown }).url;
    return typeof u === "string" ? safeUrl(u) : "";
  }
  return "";
}

/**
 * Media resolver that rewrites amable media URLs (`…/m/<slug>/<file>`) onto
 * `mediaBaseUrl`, so a page serves its media from the host it is published on.
 */
export function mediaResolver(mediaBaseUrl: string | undefined): (value: unknown) => string {
  if (!mediaBaseUrl) return mediaUrl;
  const base = mediaBaseUrl.endsWith("/") ? mediaBaseUrl : `${mediaBaseUrl}/`;
  return (value) => {
    const url = mediaUrl(value);
    const m = /^(?:https?:\/\/[^/]+)?\/m\/[^/]+\/([^?#]+)$/.exec(url);
    return m ? base + m[1] : url;
  };
}

/** Make generated CSS safe to embed in a <style> element (no "</style>" breakout). */
export function cssForStyleTag(css: string): string {
  return css.replace(/</g, "\\3c ");
}

function unitPart(v: unknown, unit: unknown): string {
  if (v === "" || v === null || v === undefined) return "";
  const u = typeof unit === "string" ? unit : "px";
  return `${v}${u}`;
}

/** Build the CSS declarations for a single style control value. */
function declarationsFor(def: ControlDef, value: unknown, media: (value: unknown) => string): string {
  if (value === undefined || value === null || value === "") return "";

  switch (def.type) {
    case "typography": {
      const t = value as Record<string, unknown>;
      const d: string[] = [];
      if (t.fontFamily) d.push(`font-family:${t.fontFamily}`);
      const fs = t.fontSize as { size?: unknown; unit?: unknown } | undefined;
      if (fs && fs.size !== undefined && fs.size !== "")
        d.push(`font-size:${unitPart(fs.size, fs.unit ?? "px")}`);
      if (t.fontWeight) d.push(`font-weight:${t.fontWeight}`);
      if (t.textTransform) d.push(`text-transform:${t.textTransform}`);
      if (t.fontStyle) d.push(`font-style:${t.fontStyle}`);
      if (t.textDecoration) d.push(`text-decoration:${t.textDecoration}`);
      const lh = t.lineHeight as { size?: unknown; unit?: unknown } | undefined;
      if (lh && lh.size !== undefined && lh.size !== "")
        d.push(`line-height:${unitPart(lh.size, lh.unit ?? "")}`);
      const ls = t.letterSpacing as { size?: unknown; unit?: unknown } | undefined;
      if (ls && ls.size !== undefined && ls.size !== "")
        d.push(`letter-spacing:${unitPart(ls.size, ls.unit ?? "px")}`);
      return d.join(";");
    }
    case "boxShadow": {
      const s = value as Record<string, unknown>;
      const x = unitPart(s.x ?? 0, "px");
      const y = unitPart(s.y ?? 0, "px");
      const blur = unitPart(s.blur ?? 0, "px");
      const spread = unitPart(s.spread ?? 0, "px");
      const col = typeof s.color === "string" ? s.color : "rgba(0,0,0,.2)";
      const inset = s.inset ? "inset " : "";
      // "Text shadow" (cssTemplate=text-shadow): shadow on the GLYPHS, not on
      // the element box. text-shadow has neither spread nor inset.
      if (def.cssTemplate === "text-shadow") {
        return `text-shadow:${x || "0"} ${y || "0"} ${blur || "0"} ${col}`;
      }
      return `box-shadow:${inset}${x || "0"} ${y || "0"} ${blur || "0"} ${spread || "0"} ${col}`;
    }
    case "gradient": {
      const g = value as Record<string, unknown>;
      const from = typeof g.from === "string" ? g.from : "";
      const to = typeof g.to === "string" ? g.to : "";
      if (!from || !to) return "";
      const pct = (v: unknown, fallback: number) =>
        typeof v === "number" && Number.isFinite(v) ? v : fallback;
      const stops = `${from} ${pct(g.fromStop, 0)}%,${to} ${pct(g.toStop, 100)}%`;
      if (g.type === "radial") return `background-image:radial-gradient(circle,${stops})`;
      return `background-image:linear-gradient(${pct(g.angle, 180)}deg,${stops})`;
    }
    case "slider": {
      const s = value as { size?: unknown; unit?: unknown };
      if (s.size === undefined || s.size === "") return "";
      const tpl = def.cssTemplate ?? "";
      return tpl
        .replace(/\{\{SIZE\}\}/g, String(s.size))
        .replace(/\{\{UNIT\}\}/g, typeof s.unit === "string" ? s.unit : "px");
    }
    case "dimensions": {
      const d = value as Record<string, unknown>;
      const unit = typeof d.unit === "string" ? d.unit : "px";
      const side = (k: string) =>
        d[k] === "" || d[k] === undefined || d[k] === null ? "0" : `${d[k]}${unit}`;
      const tpl = def.cssTemplate ?? "";
      return tpl
        .replace(/\{\{TOP\}\}/g, side("top"))
        .replace(/\{\{RIGHT\}\}/g, side("right"))
        .replace(/\{\{BOTTOM\}\}/g, side("bottom"))
        .replace(/\{\{LEFT\}\}/g, side("left"));
    }
    case "media": {
      const u = media(value).replace(/["\\\n\r]/g, encodeURIComponent);
      if (!u) return "";
      // Position/repeat are legacy defaults: the dedicated controls, emitted
      // later in the same rule (see ordering in buildNodeCss), win.
      return `background-image:url("${u}");background-position:center;background-repeat:no-repeat`;
    }
    default: {
      // color / select / choose / switcher with a {{VALUE}} template.
      const tpl = def.cssTemplate ?? "";
      if (!tpl) return "";
      // Select/choose have a closed list: values outside it (leftovers of
      // removed options, e.g. _position:"sticky") must not emit CSS the panel
      // does not show.
      if (
        (def.type === "select" || def.type === "choose") &&
        def.options &&
        !def.options.some((o) => o.value === value)
      )
        return "";
      return tpl.replace(/\{\{VALUE\}\}/g, String(value));
    }
  }
}

/** Collect the style-group control definitions for a node type, keyed by key. */
export function styleDefsForType(type: string): Map<string, ControlDef> {
  const map = new Map<string, ControlDef>();
  for (const section of sectionsForType(type)) {
    for (const ctrl of section.controls) {
      if (ctrl.group === "style") map.set(ctrl.key, ctrl);
    }
  }
  return map;
}

function selectorFor(def: ControlDef, wrapSel: string, state: string): string {
  const base = (def.selector ?? "{{WRAPPER}}").replace(/\{\{WRAPPER\}\}/g, wrapSel);
  if (state === "hover") {
    // Apply hover to the wrapper token position.
    return base.includes(wrapSel)
      ? base.replace(wrapSel, `${wrapSel}:hover`)
      : `${base}:hover`;
  }
  return base;
}

/** Widest to narrowest: the order media queries must be emitted in. */
const BREAKPOINT_ORDER: Record<Breakpoint, number> = {
  desktop: 0,
  laptop: 1,
  tablet: 2,
  mobile: 3,
  mobilesm: 4,
};

/**
 * Order of declarations inside one rule. Controls that carry defaults meant to
 * be overridable (the background image's position/repeat, sticky's edge offset)
 * are emitted first, so the dedicated controls win at equal specificity.
 */
function cssOrderOf(def: ControlDef | undefined): number {
  if (!def) return 10;
  return def.cssOrder ?? (def.type === "media" ? 0 : 10);
}

function mediaWrap(bp: Breakpoint, rule: string): string {
  if (bp === "desktop") return rule;
  const max = BREAKPOINT_MAXWIDTH[bp];
  return `@media(max-width:${max}px){${rule}}`;
}

/**
 * In the editor, hidden-per-breakpoint elements stay visible but faded and
 * badged, so the author can still see (and select) them. Public render uses
 * display:none.
 */
function hiddenRule(wrapSel: string, editable: boolean, label: string): string {
  if (!editable) return `${wrapSel}{display:none}`;
  return (
    `${wrapSel}{opacity:.35;filter:grayscale(60%)}` +
    `${wrapSel}::before{content:"hidden on ${label}";position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:9997;background:#475569;color:#fff;font:600 10px/1 system-ui;padding:3px 8px;border-radius:999px;pointer-events:none;white-space:nowrap}`
  );
}

/** Generate all scoped CSS rules for a node (style variants + advanced specials). */
export function buildNodeCss(
  node: ElementNode,
  opts: { editable?: boolean; media?: (value: unknown) => string } = {},
): string {
  const editable = opts.editable ?? false;
  const media = opts.media ?? mediaUrl;
  const wrapSel = `.${wrapperClass(node.id)}`;
  const defs = styleDefsForType(node.type);
  const out: string[] = [];

  // Breakpoints use max-width, so on a narrow screen both the tablet and
  // mobile rules match: at equal specificity the last one written wins.
  // Variants are therefore emitted widest to narrowest (hover after
  // normal), not in the order the author created them.
  const orderOf = (v: StyleVariant) =>
    BREAKPOINT_ORDER[v.breakpoint] * 2 + (v.state === "hover" ? 1 : 0);
  const variants = [...(node.styles as StyleVariant[])].sort((a, b) => orderOf(a) - orderOf(b));

  // "Sticky" active on any variant: the z-index must not emit its
  // supporting position:relative (it would come AFTER position:sticky in the
  // same rule and cancel it). Sticky is already positioned, so the plain
  // z-index is enough.
  const hasSticky = (node.styles as StyleVariant[]).some(
    (v) => v.props._sticky === "top" || v.props._sticky === "bottom",
  );

  for (const variant of variants) {
    // Group declarations by resolved selector so one rule carries many props.
    const bySelector = new Map<string, string[]>();
    const entries = Object.entries(variant.props).sort(
      (a, b) => cssOrderOf(defs.get(a[0])) - cssOrderOf(defs.get(b[0])),
    );
    for (const [key, value] of entries) {
      const def = defs.get(key);
      if (!def) continue;
      let decls = declarationsFor(def, value, media);
      if (key === "_zIndex" && hasSticky) {
        decls = decls.replace("position: relative;", "");
      }
      if (!decls) continue;
      const sel = selectorFor(def, wrapSel, variant.state);
      const list = bySelector.get(sel) ?? [];
      list.push(decls);
      bySelector.set(sel, list);
    }
    for (const [sel, decls] of bySelector) {
      out.push(mediaWrap(variant.breakpoint, `${sel}{${decls.join(";")}}`));
    }
  }

  // Advanced: responsive hide flags.
  const s = node.settings;
  if (s._hideDesktop === "yes")
    out.push(
      `@media(min-width:${BREAKPOINT_MAXWIDTH.tablet + 1}px){${hiddenRule(wrapSel, editable, "desktop")}}`,
    );
  if (s._hideTablet === "yes")
    out.push(
      `@media(min-width:${BREAKPOINT_MAXWIDTH.mobile + 1}px) and (max-width:${BREAKPOINT_MAXWIDTH.tablet}px){${hiddenRule(wrapSel, editable, "tablet")}}`,
    );
  if (s._hideMobile === "yes")
    out.push(`@media(max-width:${BREAKPOINT_MAXWIDTH.mobile}px){${hiddenRule(wrapSel, editable, "mobile")}}`);

  // Advanced: free-form CSS, `selector` token scoped to this element.
  if (typeof s._customCss === "string" && s._customCss.trim()) {
    out.push(s._customCss.replace(/selector/g, wrapSel));
  }

  // Responsive default: row containers stack into a column on mobile,
  // unless _direction is explicitly overridden for mobile.
  if (node.type === "container") {
    const dirAt = (bp: Breakpoint): string | undefined => {
      const v = (node.styles as StyleVariant[]).find(
        (x) => x.breakpoint === bp && x.state === "normal",
      );
      const d = v?.props?._direction;
      return typeof d === "string" ? d : undefined;
    };
    const mobile = dirAt("mobile") ?? dirAt("mobilesm");
    const effective = dirAt("tablet") ?? dirAt("laptop") ?? dirAt("desktop");
    if (!mobile && effective && effective.startsWith("row")) {
      out.push(
        `@media(max-width:${BREAKPOINT_MAXWIDTH.mobile}px){${wrapSel}{flex-direction:column}}`,
      );
    }
  }

  return out.join("\n");
}
