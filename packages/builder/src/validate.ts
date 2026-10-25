import {
  type BuilderDocument,
  type ElementNode,
  type PageDocument,
  builderDocumentSchema,
  htmlDocumentSchema,
  isHtmlDocument,
} from "./document";
import { type ControlDef } from "./controls";
import { getWidgetDef } from "./catalog";
import { sectionsForType } from "./factory";

/** Hard limits of a stored document (keep the TenantDb row and the SSR bounded). */
export const BUILDER_LIMITS = { maxNodes: 5000, maxDepth: 32 } as const;

export interface BuilderIssue {
  path: string;
  message: string;
}

export type BuilderValidation =
  | { ok: true; document: BuilderDocument }
  | { ok: false; issues: BuilderIssue[] };

/**
 * Validate stored/incoming JSON as a builder document: the Zod schema plus the
 * structural rules the schema cannot express (known widget types, unique node
 * ids, only containers/popups have children, size and depth limits).
 */
export function validateBuilderDocument(json: unknown): BuilderValidation {
  const parsed = builderDocumentSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 50).map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    };
  }
  const issues: BuilderIssue[] = [];
  const ids = new Set<string>();
  let count = 0;
  const walk = (nodes: ElementNode[], path: string, depth: number) => {
    nodes.forEach((n, i) => {
      const at = `${path}.${i}`;
      count++;
      if (issues.length >= 50) return;
      const def = getWidgetDef(n.type);
      if (!def) issues.push({ path: `${at}.type`, message: `unknown widget type "${n.type}"` });
      if (ids.has(n.id)) issues.push({ path: `${at}.id`, message: `duplicate node id "${n.id}"` });
      ids.add(n.id);
      if (n.children.length > 0 && def && !def.isContainer) {
        issues.push({ path: `${at}.children`, message: `"${n.type}" cannot have children` });
      }
      if (depth > BUILDER_LIMITS.maxDepth) {
        issues.push({ path: at, message: `nesting deeper than ${BUILDER_LIMITS.maxDepth}` });
        return;
      }
      walk(n.children, `${at}.children`, depth + 1);
    });
  };
  walk(parsed.data.body, "body", 1);
  if (count > BUILDER_LIMITS.maxNodes) {
    issues.push({ path: "body", message: `more than ${BUILDER_LIMITS.maxNodes} nodes` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, document: parsed.data };
}

export type PageDocumentValidation =
  | { ok: true; document: PageDocument }
  | { ok: false; issues: BuilderIssue[] };

/** Validate a page document: `editorKind: "html"` → raw HTML page, anything else → canvas. */
export function validatePageDocument(json: unknown): PageDocumentValidation {
  if (!isHtmlDocument(json)) return validateBuilderDocument(json);
  const parsed = htmlDocumentSchema.safeParse(json);
  if (parsed.success) return { ok: true, document: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.slice(0, 50).map((i) => ({
      path: i.path.map(String).join("."),
      message: i.message,
    })),
  };
}

function richtextKeys(controls: readonly ControlDef[]): { direct: string[]; repeaters: Map<string, string[]> } {
  const direct: string[] = [];
  const repeaters = new Map<string, string[]>();
  for (const c of controls) {
    if (c.type === "richtext") direct.push(c.key);
    if (c.type === "repeater" && c.fields) {
      const inner = c.fields.filter((f) => f.type === "richtext").map((f) => f.key);
      if (inner.length > 0) repeaters.set(c.key, inner);
    }
  }
  return { direct, repeaters };
}

/**
 * Apply `sanitize` to every rich-text value of the document (controls of type
 * `richtext`, also inside repeaters, e.g. the text editor, tab and accordion
 * contents), returning a new document. The renderer emits those values as
 * HTML, so the server sanitizes them before storing. The `html` widget is
 * author-written HTML by design and is left untouched.
 */
export function sanitizeBuilderDocument(
  doc: BuilderDocument,
  sanitize: (html: string) => string,
): BuilderDocument {
  const visit = (node: ElementNode): ElementNode => {
    const def = getWidgetDef(node.type);
    let settings = node.settings;
    if (def) {
      const { direct, repeaters } = richtextKeys(sectionsForType(node.type).flatMap((s) => s.controls));
      if (direct.length > 0 || repeaters.size > 0) {
        settings = { ...node.settings };
        for (const key of direct) {
          const v = settings[key];
          if (typeof v === "string") settings[key] = sanitize(v);
        }
        for (const [key, fields] of repeaters) {
          const rows = settings[key];
          if (!Array.isArray(rows)) continue;
          settings[key] = rows.map((row: unknown) => {
            if (!row || typeof row !== "object") return row;
            const copy = { ...(row as Record<string, unknown>) };
            for (const f of fields) {
              const v = copy[f];
              if (typeof v === "string") copy[f] = sanitize(v);
            }
            return copy;
          });
        }
      }
    }
    return { ...node, settings, children: node.children.map(visit) };
  };
  return { ...doc, body: doc.body.map(visit) };
}
