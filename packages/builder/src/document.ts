import { z } from "zod";
import { builderTokensSchema } from "./tokens";

/**
 * Editing/rendering breakpoints, widest to narrowest. Laptop and "small
 * mobile" are independent breakpoints: an edit on Laptop does NOT touch
 * Desktop. Inheritance cascades from the widest one (like media queries).
 */
export const BREAKPOINTS = ["desktop", "laptop", "tablet", "mobile", "mobilesm"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Max-width (px) at which a breakpoint's overrides apply. Desktop = base. */
export const BREAKPOINT_MAXWIDTH: Record<Exclude<Breakpoint, "desktop">, number> = {
  laptop: 1366,
  tablet: 1024,
  mobile: 767,
  mobilesm: 389,
};

/** Chain used to resolve an inherited value: [bp, ...wider, "desktop"]. */
export function breakpointChain(bp: Breakpoint): Breakpoint[] {
  const idx = BREAKPOINTS.indexOf(bp);
  return BREAKPOINTS.slice(0, idx + 1).reverse();
}

/** Interaction states a style variant can target. */
export const ELEMENT_STATES = ["normal", "hover"] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

/**
 * A slice of style props for one (breakpoint, state) combination. Props are
 * keyed by the widget/advanced control key; the renderer resolves each key to
 * CSS via the matching control definition.
 */
export interface StyleVariant {
  breakpoint: Breakpoint;
  state: ElementState;
  props: Record<string, unknown>;
}

/**
 * A node in the canvas tree. `container` nodes hold children (flex/grid); every
 * other `type` is a leaf widget whose `settings` feed its HTML renderer.
 */
export interface ElementNode {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  styles: StyleVariant[];
  children: ElementNode[];
  locked: boolean;
}

/** Input shape of a node (defaults applied by `elementNodeSchema`). */
export interface ElementNodeInput {
  id: string;
  type: string;
  settings?: Record<string, unknown>;
  styles?: Array<{ breakpoint?: Breakpoint; state?: ElementState; props?: Record<string, unknown> }>;
  children?: ElementNodeInput[];
  locked?: boolean;
}

/** Structured deep clone that works without the DOM/Node `structuredClone`. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const styleVariantSchema = z.object({
  breakpoint: z.enum(BREAKPOINTS).default("desktop"),
  state: z.enum(ELEMENT_STATES).default("normal"),
  props: z.record(z.string(), z.unknown()).default(() => ({})),
});

export const elementNodeSchema: z.ZodType<ElementNode, ElementNodeInput> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(64),
    settings: z.record(z.string(), z.unknown()).default(() => ({})),
    styles: z.array(styleVariantSchema).default(() => []),
    children: z.array(elementNodeSchema).default(() => []),
    locked: z.boolean().default(false),
  }),
);

/** Full canvas page document. Rendered to HTML+CSS by the renderer. */
export const builderDocumentSchema = z.object({
  /** Discriminator for stored canvas documents. */
  editorKind: z.literal("canvas").default("canvas"),
  tokens: builderTokensSchema.prefault({}),
  /** Root-level element tree (usually a list of top-level containers). */
  body: z.array(elementNodeSchema).default(() => []),
  /** Page-wide CSS (scoped by the author; `<` is neutralized at render time). */
  customCss: z.string().max(100_000).optional(),
});
export type BuilderDocument = z.output<typeof builderDocumentSchema>;
export type BuilderDocumentInput = z.input<typeof builderDocumentSchema>;

/**
 * Max size of the markup of an HTML document, in UTF-8 bytes: the page row holds
 * the whole document and Durable Object SQLite rejects rows over 2 MB, so accented
 * letters, emoji and inline SVG text count for what they weigh.
 */
export const HTML_DOCUMENT_MAX_BYTES = 1_500_000;

/** UTF-8 size of a string (what SQLite stores); a lone surrogate counts as U+FFFD (3 bytes). */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * A page written entirely by its author as one HTML document (`<!doctype html>…`).
 * Served as-is: no builder shell, base CSS or runtime; only the analytics tracker
 * is injected. Not editable on the canvas.
 */
export const htmlDocumentSchema = z.strictObject({
  editorKind: z.literal("html"),
  html: z
    .string()
    // A UTF-16 unit is never less than one UTF-8 byte: cheap rejection before encoding.
    .max(HTML_DOCUMENT_MAX_BYTES)
    .refine((html) => utf8Bytes(html) <= HTML_DOCUMENT_MAX_BYTES, {
      message: `HTML larger than ${HTML_DOCUMENT_MAX_BYTES} bytes (UTF-8: accented letters and emoji take 2 to 4 bytes each)`,
    }),
});
export type HtmlDocument = z.output<typeof htmlDocumentSchema>;

/** What a landing page stores: a canvas document or a raw HTML one. */
export type PageDocument = BuilderDocument | HtmlDocument;

/** Type guard: is this document (or stored JSON) a raw HTML page? */
export function isHtmlDocument(json: unknown): json is HtmlDocument {
  return (
    typeof json === "object" &&
    json !== null &&
    (json as { editorKind?: unknown }).editorKind === "html"
  );
}

/** Type guard: is this stored JSON a canvas document? */
export function isBuilderDocument(json: unknown): boolean {
  return (
    typeof json === "object" &&
    json !== null &&
    (json as { editorKind?: unknown }).editorKind === "canvas"
  );
}

/** Generate a short, unique element id (e.g. "el_1a2b3c4d"). */
export function newElementId(): string {
  const g = globalThis as unknown as { crypto: { randomUUID(): string } };
  return `el_${g.crypto.randomUUID().slice(0, 8)}`;
}

/** Deep-clone a subtree, assigning fresh ids to every node (paste/duplicate). */
export function cloneNodeWithNewIds(node: ElementNode): ElementNode {
  return {
    ...clone(node),
    id: newElementId(),
    children: node.children.map(cloneNodeWithNewIds),
  };
}

/** A popup node's id + display name, for building "open popup" pickers. */
export interface PopupRef {
  id: string;
  name: string;
}

/** Collect every `popup` node in the tree (usually root-level) as {id, name}. */
export function listPopups(nodes: ElementNode[]): PopupRef[] {
  const out: PopupRef[] = [];
  const walk = (list: ElementNode[]) => {
    for (const n of list) {
      if (n.type === "popup") {
        const name = typeof n.settings.name === "string" && n.settings.name.trim()
          ? n.settings.name.trim()
          : "Popup";
        out.push({ id: n.id, name });
      }
      if (n.children.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** A navigable page anchor: CSS id + readable label. */
export interface AnchorRef {
  id: string;
  label: string;
}

/**
 * Anchors reachable with "#id": `anchor` widgets (settings.anchorId) and
 * any node with a CSS id (settings._cssId). Used by "link to section" pickers.
 */
export function listAnchors(nodes: ElementNode[]): AnchorRef[] {
  const out: AnchorRef[] = [];
  const seen = new Set<string>();
  const push = (id: string, label: string) => {
    const clean = id.trim().replace(/^#/, "");
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({ id: clean, label });
  };
  const walk = (list: ElementNode[]) => {
    for (const n of list) {
      if (n.type === "anchor" && typeof n.settings.anchorId === "string") {
        push(n.settings.anchorId, `Anchor "${n.settings.anchorId}"`);
      }
      if (typeof n.settings._cssId === "string" && n.settings._cssId.trim()) {
        push(n.settings._cssId, `${n.type} #${n.settings._cssId.trim()}`);
      }
      if (n.children.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Depth-first find of a node by id. */
export function findNode(nodes: ElementNode[], id: string): ElementNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Immutably map a node by id, returning a new tree. */
export function mapNode(
  nodes: ElementNode[],
  id: string,
  fn: (n: ElementNode) => ElementNode,
): ElementNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children.length === 0) return n;
    return { ...n, children: mapNode(n.children, id, fn) };
  });
}

/** Immutably remove a node by id, returning a new tree. */
export function removeNode(nodes: ElementNode[], id: string): ElementNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) =>
      n.children.length ? { ...n, children: removeNode(n.children, id) } : n,
    );
}

/** Read a style prop for a specific (breakpoint, state), or undefined. */
export function getStyleValue(
  node: ElementNode,
  key: string,
  breakpoint: Breakpoint,
  state: ElementState = "normal",
): unknown {
  const v = node.styles.find(
    (s) => s.breakpoint === breakpoint && s.state === state,
  );
  return v?.props[key];
}

/**
 * Immutably set (or clear, when value is undefined) a style prop for a
 * (breakpoint, state) on a node, returning a new node.
 */
export function setStyleValue(
  node: ElementNode,
  key: string,
  value: unknown,
  breakpoint: Breakpoint,
  state: ElementState = "normal",
): ElementNode {
  const styles = node.styles.map((s) => ({ ...s, props: { ...s.props } }));
  let variant = styles.find(
    (s) => s.breakpoint === breakpoint && s.state === state,
  );
  if (!variant) {
    variant = { breakpoint, state, props: {} };
    styles.push(variant);
  }
  if (value === undefined || value === "" || value === null) {
    delete variant.props[key];
  } else {
    variant.props[key] = value;
  }
  // Drop now-empty variants to keep the JSON tidy.
  const pruned = styles.filter((s) => Object.keys(s.props).length > 0);
  return { ...node, styles: pruned };
}
