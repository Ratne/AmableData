import { BREAKPOINTS, type Breakpoint, type ElementState } from "./document";

/**
 * Control catalog. Content controls store their value in `node.settings[key]`
 * and feed the widget HTML renderer. Style controls store their value in a
 * style variant and are turned into CSS generically by the renderer using
 * the control's `selector` + type (or `cssTemplate`).
 */
export type ControlType =
  | "text"
  | "textarea"
  | "richtext"
  | "number"
  | "select"
  | "choose"
  | "switcher"
  | "color"
  | "slider"
  | "dimensions"
  | "media"
  | "url"
  | "icon"
  | "repeater"
  | "code"
  | "typography"
  | "boxShadow"
  | "gradient"
  | "popup-select"
  | "shape"
  | "hidden";

/** A single {value,label} option for select/choose controls. */
export interface ControlOption {
  value: string;
  label: string;
  /** Optional lucide icon name (choose controls render icons instead of text). */
  icon?: string;
}

/**
 * Simple condition map. Each entry is ANDed together.
 *  - `{ key: "yes" }`      -> settings[key] === "yes"
 *  - `{ "key!": "" }`      -> settings[key] is not ""
 *  - `{ key: ["a","b"] }`  -> settings[key] in ["a","b"]
 */
export type Condition = Record<string, unknown>;

export interface ControlDef {
  key: string;
  type: ControlType;
  label: string;
  /** Where the value lives: `content` -> settings; `style` -> style variant. */
  group: "content" | "style";
  default?: unknown;
  description?: string;
  placeholder?: string;
  /** select / choose options. */
  options?: ControlOption[];
  /** slider / dimensions unit choices (first = default). */
  units?: string[];
  min?: number;
  max?: number;
  step?: number;
  /**
   * Allow per-breakpoint values. Style controls store them in style variants;
   * content controls store them in `settings` under a suffixed key (see
   * `responsiveSettingKey`), so an image can differ per device.
   */
  responsive?: boolean;
  /** Style controls: which interaction states are editable. */
  states?: ElementState[];
  /**
   * Style controls: CSS selector template relative to the element wrapper.
   * `{{WRAPPER}}` is replaced with the element's generated class.
   * Defaults to `{{WRAPPER}}` when omitted.
   */
  selector?: string;
  /**
   * Style controls (primitive types only): CSS declaration template with
   * placeholders `{{VALUE}}`, `{{SIZE}}`, `{{UNIT}}`, `{{TOP}}`, `{{RIGHT}}`,
   * `{{BOTTOM}}`, `{{LEFT}}`. When omitted, a sensible default is derived from
   * the control type by the renderer.
   */
  cssTemplate?: string;
  /**
   * Style controls: emission order inside the generated rule. Declarations of a
   * lower `cssOrder` are written first, so controls with a higher one override
   * them at equal specificity. Defaults to 0 for `media` (which carries legacy
   * position/repeat defaults) and 10 for everything else.
   */
  cssOrder?: number;
  /** Show this control only when the condition matches the node settings. */
  condition?: Condition;
  /** repeater: the fields of each row. */
  fields?: ControlDef[];
  /** repeater: settings key used as the row title in the UI. */
  titleField?: string;
  /** repeater: default rows for a new widget. */
  defaultRows?: Array<Record<string, unknown>>;
}

/** A collapsible group of controls inside a panel tab. */
export interface ControlSection {
  id: string;
  label: string;
  tab: "content" | "style" | "advanced";
  controls: ControlDef[];
  condition?: Condition;
}

export interface WidgetDef {
  /** Node `type` discriminator (e.g. "heading", "container"). */
  type: string;
  /** Human label for the palette / navigator. */
  title: string;
  /** Lucide icon name for the palette. */
  icon: string;
  /** Palette grouping. */
  category: "layout" | "basic" | "media" | "content" | "form";
  /** Container nodes accept children; widgets are leaves. */
  isContainer?: boolean;
  /** Control sections (content/style tabs). Advanced tab is shared + appended. */
  sections: ControlSection[];
  /** Initial settings + styles for a freshly-inserted node. */
  defaults?: {
    settings?: Record<string, unknown>;
    styles?: import("./document").StyleVariant[];
    children?: import("./document").ElementNode[];
  };
}

/** Evaluate a single condition map against a settings object. */
export function evalCondition(
  condition: Condition | undefined,
  settings: Record<string, unknown>,
): boolean {
  if (!condition) return true;
  for (const rawKey of Object.keys(condition)) {
    const negate = rawKey.endsWith("!");
    const key = negate ? rawKey.slice(0, -1) : rawKey;
    const expected = condition[rawKey];
    const actual = settings[key];
    let matches: boolean;
    if (Array.isArray(expected)) {
      matches = expected.includes(actual as never);
    } else {
      matches = actual === expected;
    }
    if (negate ? matches : !matches) return false;
  }
  return true;
}

/**
 * Settings key holding the value of a responsive *content* control for a given
 * breakpoint. Desktop keeps the bare key so existing documents are
 * untouched; narrower devices get a suffix. An absent value means
 * "inherit the wider breakpoint", exactly like CSS overrides.
 */
export function responsiveSettingKey(key: string, bp: Breakpoint): string {
  return bp === "desktop" ? key : `${key}__${bp}`;
}

/** Every settings key a responsive content control can occupy, widest first. */
export function responsiveSettingKeys(key: string): { bp: Breakpoint; key: string }[] {
  return BREAKPOINTS.map((bp) => ({ bp, key: responsiveSettingKey(key, bp) }));
}

// --- Terse helper constructors for building widget definitions -------------

export const text = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "text", label, group: "content", ...o });

export const textarea = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "textarea", label, group: "content", ...o });

export const richtext = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "richtext", label, group: "content", ...o });

export const select = (
  key: string,
  label: string,
  options: ControlOption[],
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "select", label, group: "content", options, ...o });

export const choose = (
  key: string,
  label: string,
  options: ControlOption[],
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "choose", label, group: "content", options, ...o });

export const switcher = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "switcher", label, group: "content", ...o });

export const media = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "media", label, group: "content", ...o });

export const url = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "url", label, group: "content", ...o });

export const iconControl = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "icon", label, group: "content", ...o });

export const repeater = (
  key: string,
  label: string,
  fields: ControlDef[],
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "repeater", label, group: "content", fields, ...o });

export const codeControl = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "code", label, group: "content", ...o });

/** Dropdown populated at edit time with the document's popup nodes (by id). */
export const popupSelect = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "popup-select", label, group: "content", ...o });

/**
 * Shape divider of one side of a container. `key` is the PREFIX of the
 * settings keys handled by the control: `<key>Type`, `<key>Color`,
 * `<key>Height`, `<key>Flip`, `<key>Invert`, `<key>Front`, `<key>Svg`
 * (uploaded custom markup).
 */
export const shapeDivider = (
  key: string,
  label: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({ key, type: "shape", label, group: "content", ...o });

// Style controls -------------------------------------------------------------

export const color = (
  key: string,
  label: string,
  selector: string,
  cssProp: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({
  key,
  type: "color",
  label,
  group: "style",
  selector,
  cssTemplate: `${cssProp}: {{VALUE}}`,
  responsive: false,
  states: ["normal", "hover"],
  ...o,
});

export const slider = (
  key: string,
  label: string,
  selector: string,
  cssProp: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({
  key,
  type: "slider",
  label,
  group: "style",
  selector,
  cssTemplate: `${cssProp}: {{SIZE}}{{UNIT}}`,
  units: ["px", "%", "em", "rem", "vw"],
  min: 0,
  max: 500,
  step: 1,
  responsive: true,
  ...o,
});

export const dimensions = (
  key: string,
  label: string,
  selector: string,
  cssProp: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({
  key,
  type: "dimensions",
  label,
  group: "style",
  selector,
  // cssProp is the shorthand base, e.g. "padding" / "margin" / "border-radius".
  cssTemplate: `${cssProp}: {{TOP}} {{RIGHT}} {{BOTTOM}} {{LEFT}}`,
  units: ["px", "%", "em", "rem"],
  responsive: true,
  ...o,
});

export const typography = (
  selector: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({
  key: "typography",
  type: "typography",
  label: "Typography",
  group: "style",
  selector,
  responsive: true,
  ...o,
});

export const boxShadow = (
  key: string,
  label: string,
  selector: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({
  key,
  type: "boxShadow",
  label,
  group: "style",
  selector,
  states: ["normal", "hover"],
  ...o,
});

/**
 * Gradient background. Composite value:
 * { from, fromStop, to, toStop, type: "linear"|"radial", angle }.
 * Emits `background-image`, so it covers any background color.
 */
export const gradient = (
  key: string,
  label: string,
  selector: string,
  o: Partial<ControlDef> = {},
): ControlDef => ({
  key,
  type: "gradient",
  label,
  group: "style",
  selector,
  states: ["normal", "hover"],
  ...o,
});

export const chooseAlign = (
  key = "align",
  selector = "{{WRAPPER}}",
): ControlDef =>
  choose(
    key,
    "Alignment",
    [
      { value: "left", label: "Left", icon: "align-left" },
      { value: "center", label: "Center", icon: "align-center" },
      { value: "right", label: "Right", icon: "align-right" },
    ],
    {
      group: "style",
      selector,
      cssTemplate: "text-align: {{VALUE}}",
      responsive: true,
    },
  );
