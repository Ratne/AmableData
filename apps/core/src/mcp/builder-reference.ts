import {
  ADVANCED_SECTIONS,
  BREAKPOINT_MAXWIDTH,
  BREAKPOINTS,
  BUILDER_LIMITS,
  ELEMENT_STATES,
  HTML_DOCUMENT_MAX_BYTES,
  ICON_NAMES,
  WIDGETS,
  builderTokensSchema,
  type ControlDef,
  type ControlSection,
  type ControlType,
  type WidgetDef,
} from '@amable/builder';

/** Where the reference points the embeds: the workspace slug and the edge origin serving the scripts. */
export interface EmbedTarget {
  readonly slug: string;
  readonly edgeOrigin: string;
}

/** JSON shape of the value each control type stores. */
const VALUE_FORMATS: Readonly<Record<ControlType, string>> = {
  text: 'string',
  textarea: 'string',
  richtext: 'HTML string (sanitized on save: no scripts)',
  number: 'number',
  select: 'one of options[].value',
  choose: 'one of options[].value',
  switcher: '"yes" | "" (off)',
  color: 'CSS color string, e.g. "#2563eb" or "var(--b-color-primary)"',
  slider: '{ size: number, unit: string } (unit from units, first = default)',
  dimensions: '{ top, right, bottom, left: number | "", unit: "px" | "%" | "em" | "rem" }',
  media: '{ url: string } (absolute https URL, or the url of a file from upload_media)',
  url: '{ url: string, target?: "_blank", nofollow?: "yes" }',
  icon: 'icon name string (see icons)',
  repeater: 'array of row objects, each with the keys of fields',
  code: 'string (raw, not sanitized)',
  typography:
    '{ fontFamily?: string, fontSize?: {size,unit}, fontWeight?: "400".."900", lineHeight?: {size,unit}, letterSpacing?: {size,unit}, textTransform?, fontStyle?, textDecoration? }',
  boxShadow: '{ x, y, blur, spread: number (px), color: string, inset?: boolean }',
  gradient: '{ type: "linear" | "radial", from: color, to: color, fromStop?: 0-100, toStop?: 0-100, angle?: deg }',
  'popup-select': 'id of a root-level popup node',
  shape: 'shape divider id string',
  hidden: 'internal, leave as is',
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function compact(entries: Record<string, Json | undefined>): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out;
}

function asJson(value: unknown): Json | undefined {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Json);
}

function describeControl(control: ControlDef): { [key: string]: Json } {
  return compact({
    key: control.key,
    type: control.type,
    label: control.label,
    stored_in: control.group === 'content' ? 'settings' : 'styles[].props',
    value: VALUE_FORMATS[control.type],
    default: asJson(control.default),
    options: control.options?.map((o) => o.value),
    units: control.units,
    min: control.min,
    max: control.max,
    step: control.step,
    responsive: control.responsive === true ? true : undefined,
    states: control.states,
    only_when: asJson(control.condition),
    description: control.description,
    fields: control.fields?.map(describeControl),
    default_rows: asJson(control.defaultRows),
  });
}

function describeSection(section: ControlSection): { [key: string]: Json } {
  return compact({
    section: section.label,
    tab: section.tab,
    only_when: asJson(section.condition),
    controls: section.controls.filter((c) => c.type !== 'hidden').map(describeControl),
  });
}

function embedSnippets(target: EmbedTarget): { [key: string]: Json } {
  const edge = target.edgeOrigin;
  const tenant = target.slug;
  return {
    why:
      'Use the CRM embeds instead of hand-written <form> tags: a form submission creates or updates the contact, applies the form tags and fires the automations and integrations tied to the form (same for bookings and checkouts). data-amable-page attributes the submission to this landing page in analytics and reports.',
    form: {
      find_ids: 'list_forms (id of the form).',
      snippet: `<div data-amable-form="<formId>" data-amable-tenant="${tenant}" data-amable-page="<pageId>"></div>\n<script async src="${edge}/forms.js"></script>`,
    },
    booking: {
      find_ids: 'search_operations "booking event types" → slug of the event type.',
      snippet: `<div data-amable-booking="<eventTypeSlug>" data-amable-tenant="${tenant}" data-amable-page="<pageId>"></div>\n<script async src="${edge}/booking.js"></script>`,
    },
    checkout: {
      find_ids: 'search_operations "checkouts" → id of the checkout.',
      snippet: `<div data-amable-checkout="<checkoutId>" data-amable-tenant="${tenant}" data-amable-page="<pageId>"></div>\n<script async src="${edge}/checkout.js"></script>`,
    },
    notes: [
      '<pageId> is the id returned by create_page. Load each script once per page, even with several embeds of the same kind.',
      'The embeds render inside the div and inherit the page fonts; style the surrounding layout freely.',
      'In canvas documents use the form, booking and checkout widgets instead (settings formId, eventSlug, checkoutId): they emit the same markup.',
    ],
  };
}

const CATEGORIES: readonly WidgetDef['category'][] = ['layout', 'basic', 'media', 'content', 'form'];

/** What a client needs before writing a page document: both document kinds, the widget index and the CRM embeds. */
export function builderOverview(target: EmbedTarget): { [key: string]: Json } {
  const widgets = Object.values(WIDGETS);
  return {
    document_kinds: {
      canvas: {
        when: 'Default. Pages built from widgets, editable afterwards in the visual editor of the web app.',
        shape: '{ editorKind: "canvas", tokens: {…}, body: ElementNode[], customCss?: string }',
        custom_html: 'For a block the widgets cannot express, use the "html" widget (settings.html, raw HTML/CSS/JS) inside the canvas.',
      },
      html: {
        when: 'Full control: a page written from scratch as one HTML document. Served exactly as written; only the analytics tracker is added before </body>. Edited in the web app as source code, not on the canvas.',
        shape: '{ editorKind: "html", html: "<!doctype html><html>…</html>" }',
        rules: [
          `Max ${HTML_DOCUMENT_MAX_BYTES} bytes of UTF-8 (accented letters and emoji take 2 to 4 bytes).`,
          'Write the whole document: doctype, <head> (title, meta description, viewport, og tags, fonts, CSS) and <body>. The page SEO fields are not injected.',
          'Inline and https scripts, styles, images and iframes are allowed.',
          'Images: upload_media returns a url to use in <img src>.',
        ],
      },
    },
    crm_embeds: embedSnippets(target),
    canvas: {
      element_node:
        '{ id: string (unique in the document, ≤64 chars, e.g. "el_hero1"), type: widget type, settings: { content control key: value }, styles: StyleVariant[], children: ElementNode[] (containers and popups only), locked?: false }',
      style_variant:
        '{ breakpoint: "desktop" (default), state: "normal" | "hover", props: { style control key: value } }: one per (breakpoint, state) that differs.',
      breakpoints: BREAKPOINTS.map((bp) =>
        bp === 'desktop'
          ? { id: bp, max_width: null }
          : { id: bp, max_width: BREAKPOINT_MAXWIDTH[bp] },
      ),
      breakpoint_inheritance:
        'Styles cascade from desktop down: set desktop first, then override only what changes on tablet/mobile. Responsive content controls use the settings key "<key>__<breakpoint>".',
      states: [...ELEMENT_STATES],
      tokens: {
        defaults: asJson(builderTokensSchema.parse({})) ?? null,
        css_variables:
          'Rendered as --b-color-<name> (primary, secondary, accent, text, heading, background, muted, border), --b-font-heading, --b-font-body, --b-radius, --b-container: use var(--b-color-primary) in colors.',
      },
      limits: { max_nodes: BUILDER_LIMITS.maxNodes, max_depth: BUILDER_LIMITS.maxDepth, custom_css_chars: 100_000 },
      structure:
        'body is a list of root containers (sections); each holds widgets or nested containers (columns: a row container with _direction "row" and child containers). Popups are root-level "popup" nodes opened by buttons.',
      widgets: Object.fromEntries(
        CATEGORIES.map((category) => [
          category,
          widgets
            .filter((w) => w.category === category)
            .map((w) => compact({ type: w.type, title: w.title, container: w.isContainer === true ? true : undefined })),
        ]),
      ),
      advanced_controls:
        'Every widget also has the shared Advanced controls (margin, padding, width, position, background, border, visibility per device, CSS id and classes, custom CSS): see describe_page_builder with a widget type.',
      example: {
        editorKind: 'canvas',
        body: [
          {
            id: 'el_hero',
            type: 'container',
            settings: { _containerType: 'flex', _direction: 'column', contentWidth: 'boxed', htmlTag: 'section' },
            styles: [{ breakpoint: 'desktop', state: 'normal', props: { _padding: { top: 80, right: 24, bottom: 80, left: 24, unit: 'px' } } }],
            children: [
              { id: 'el_title', type: 'heading', settings: { title: 'Grow with us', htmlTag: 'h1' } },
              { id: 'el_cta', type: 'button', settings: { text: 'Get started', link: { url: '#form' } } },
            ],
          },
        ],
      },
    },
    workflow: [
      'describe_page_builder { widget } for the controls of each widget you use (canvas only).',
      'create_page { title, path, document } → returns id and draft_revision.',
      'save_page_draft { id, document, base_revision: draft_revision } to replace the whole document; 409 stale_draft → get_page and retry on the new draft_revision.',
      'preview_page { id } to check the rendered HTML, then publish_page { id } to go live at public_url.',
    ],
  };
}

/** Every control of one widget type (its sections + the shared Advanced tab); unknown types list the valid ones. */
export function widgetReference(type: string): { [key: string]: Json } | null {
  const def = WIDGETS[type];
  if (def === undefined) return null;
  return compact({
    type: def.type,
    title: def.title,
    category: def.category,
    container: def.isContainer === true,
    defaults: asJson(def.defaults),
    sections: def.sections.map(describeSection),
    advanced: ADVANCED_SECTIONS.map(describeSection),
    icons: def.sections.some((s) => s.controls.some((c) => c.type === 'icon' || c.fields?.some((f) => f.type === 'icon')))
      ? ICON_NAMES
      : undefined,
  });
}

export function widgetTypes(): string[] {
  return Object.keys(WIDGETS);
}
