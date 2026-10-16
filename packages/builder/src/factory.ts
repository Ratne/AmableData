import {
  type ElementNode,
  type BuilderDocument,
  newElementId,
  builderDocumentSchema,
  clone,
} from "./document";
import { type ControlSection } from "./controls";
import { getWidgetDef, WIDGETS } from "./catalog";
import { ADVANCED_SECTIONS } from "./advanced";

/** Build a fresh node of the given widget type with its default settings/styles. */
export function createNode(type: string): ElementNode {
  const def = getWidgetDef(type);
  return {
    id: newElementId(),
    type,
    settings: def?.defaults?.settings ? clone(def.defaults.settings) : {},
    styles: def?.defaults?.styles ? clone(def.defaults.styles) : [],
    children: def?.defaults?.children ? clone(def.defaults.children) : [],
    locked: false,
  };
}

/** A blank canvas document with one empty boxed container to drop into. */
export function emptyBuilderDocument(): BuilderDocument {
  const root = createNode("container");
  return builderDocumentSchema.parse({
    editorKind: "canvas",
    body: [root],
  });
}

/**
 * Full ordered list of control sections for a node type: the widget's own
 * content/style sections followed by the shared Advanced tab. Used by the
 * controls panel.
 */
export function sectionsForType(type: string): ControlSection[] {
  const def = getWidgetDef(type);
  if (!def) return [...ADVANCED_SECTIONS];
  return [...def.sections, ...ADVANCED_SECTIONS];
}

/** Whether a node type can contain children. */
export function isContainerType(type: string): boolean {
  return !!getWidgetDef(type)?.isContainer;
}

/** Palette entries grouped by category, in declaration order. */
export function paletteByCategory(): Record<string, typeof WIDGETS[string][]> {
  const out: Record<string, typeof WIDGETS[string][]> = {};
  for (const def of Object.values(WIDGETS)) {
    (out[def.category] ??= []).push(def);
  }
  return out;
}
