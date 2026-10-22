import {
  type WidgetDef,
  type ControlSection,
  text,
  textarea,
  richtext,
  select,
  choose,
  switcher,
  media,
  url,
  gradient,
  iconControl,
  repeater,
  codeControl,
  color,
  slider,
  dimensions,
  typography,
  boxShadow,
  chooseAlign,
  popupSelect,
  shapeDivider,
} from "./controls";

const H_TAGS = [
  { value: "h1", label: "H1" },
  { value: "h2", label: "H2" },
  { value: "h3", label: "H3" },
  { value: "h4", label: "H4" },
  { value: "h5", label: "H5" },
  { value: "h6", label: "H6" },
  { value: "div", label: "div" },
  { value: "span", label: "span" },
  { value: "p", label: "p" },
];

/** Shown on every image picker that accepts a different file per device. */
const RESPONSIVE_MEDIA_HINT =
  "To use a different one on tablet or mobile switch device in the top bar and pick the file. Left empty, the one of the larger device applies.";

/** Content section shorthand. */
const content = (id: string, label: string, controls: ControlSection["controls"]): ControlSection => ({
  id,
  label,
  tab: "content",
  controls,
});
/** Style section shorthand. */
const style = (id: string, label: string, controls: ControlSection["controls"]): ControlSection => ({
  id,
  label,
  tab: "style",
  controls,
});

// --- Container --------------------------------------------------------------

const container: WidgetDef = {
  type: "container",
  title: "Container",
  icon: "square",
  category: "layout",
  isContainer: true,
  defaults: {
    settings: { _containerType: "flex", _direction: "column", contentWidth: "boxed", htmlTag: "div" },
  },
  sections: [
    content("container_layout", "Layout", [
      choose("_containerType", "Type", [
        { value: "flex", label: "Flex", icon: "columns-2" },
        { value: "grid", label: "Grid", icon: "grid-3x3" },
      ]),
      select("contentWidth", "Content width", [
        { value: "boxed", label: "Boxed" },
        { value: "full", label: "Full width" },
      ]),
      select("htmlTag", "HTML tag", [
        { value: "div", label: "div" },
        { value: "section", label: "section" },
        { value: "header", label: "header" },
        { value: "footer", label: "footer" },
        { value: "main", label: "main" },
        { value: "article", label: "article" },
      ]),
      choose(
        "_direction",
        "Direction",
        [
          { value: "row", label: "Row", icon: "arrow-right" },
          { value: "column", label: "Column", icon: "arrow-down" },
          { value: "row-reverse", label: "Row reversed", icon: "arrow-left" },
          { value: "column-reverse", label: "Column reversed", icon: "arrow-up" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "flex-direction: {{VALUE}}",
          responsive: true,
          condition: { _containerType: "flex" },
        },
      ),
      choose(
        "_justify",
        "Justify content",
        [
          { value: "flex-start", label: "Start", icon: "align-horizontal-justify-start" },
          { value: "center", label: "Center", icon: "align-horizontal-justify-center" },
          { value: "flex-end", label: "End", icon: "align-horizontal-justify-end" },
          { value: "space-between", label: "Space between", icon: "align-horizontal-space-between" },
          { value: "space-around", label: "Space around", icon: "align-horizontal-space-around" },
          { value: "space-evenly", label: "Space evenly", icon: "align-horizontal-distribute-center" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "justify-content: {{VALUE}}",
          responsive: true,
        },
      ),
      choose(
        "_align",
        "Align items",
        [
          { value: "flex-start", label: "Start", icon: "align-start-horizontal" },
          { value: "center", label: "Center", icon: "align-center-horizontal" },
          { value: "flex-end", label: "End", icon: "align-end-horizontal" },
          { value: "stretch", label: "Stretch", icon: "stretch-horizontal" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "align-items: {{VALUE}}",
          responsive: true,
        },
      ),
      choose(
        "_wrap",
        "Wrap",
        [
          { value: "nowrap", label: "No wrap", icon: "arrow-right-to-line" },
          { value: "wrap", label: "Wrap", icon: "wrap-text" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "flex-wrap: {{VALUE}}",
          responsive: true,
          condition: { _containerType: "flex" },
          description:
            "Items can stay on a single line (No wrap) or break onto several lines (Wrap).",
        },
      ),
      slider("_gridColumns", "Columns (grid)", "{{WRAPPER}}", "grid-template-columns", {
        units: [""],
        max: 8,
        min: 1,
        step: 1,
        cssTemplate: "grid-template-columns: repeat({{SIZE}},minmax(0,1fr))",
        condition: { _containerType: "grid" },
        responsive: true,
      }),
      slider("_gap", "Spacing (gap)", "{{WRAPPER}}", "gap", {
        max: 200,
        responsive: true,
      }),
      slider("_minHeight", "Min height", "{{WRAPPER}}", "min-height", {
        units: ["px", "vh", "%"],
        max: 1200,
        responsive: true,
      }),
      slider("_width", "Width", "{{WRAPPER}}", "width", {
        units: ["%", "px", "vw"],
        max: 1600,
        responsive: true,
        // Same template as the Advanced control of the same name: never overflow
        // the parent container on narrow screens.
        cssTemplate: "width: {{SIZE}}{{UNIT}};max-width:100%",
        description:
          "A container inside another container takes 100% by default. With Wrap enabled on the parent, set the children's size here (e.g. 32% for three cards side by side); switch device to give tablet and mobile a different value.",
      }),
    ]),
    style("container_style", "Style", [
      color("_bg", "Background color", "{{WRAPPER}}", "background-color"),
    ]),
    // Layer above the background and below the content: RGBA color, gradient
    // or image, with opacity and blend mode. Rendered as the container's
    // ::before (class b-has-overlay).
    style("container_overlay", "Background overlay", [
      color("_ovColor", "Overlay color", "{{WRAPPER}}::before", "background-color", {
        description: "Use the color opacity slider for RGBA (e.g. black at 40%).",
      }),
      gradient("_ovGradient", "Overlay gradient", "{{WRAPPER}}::before"),
      media("_ovImage", "Overlay image", {
        group: "style",
        selector: "{{WRAPPER}}::before",
        responsive: true,
        description: "Image above the background and below the content (e.g. a texture).",
      }),
      select(
        "_ovSize",
        "Image size",
        [
          { value: "cover", label: "Cover" },
          { value: "contain", label: "Contain" },
          { value: "auto", label: "Auto" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}::before",
          cssTemplate: "background-size: {{VALUE}}",
          condition: { "_ovImage!": "" },
          responsive: true,
        },
      ),
      select(
        "_ovPosition",
        "Image position",
        [
          { value: "center center", label: "Center center" },
          { value: "center top", label: "Center top" },
          { value: "center bottom", label: "Center bottom" },
          { value: "left top", label: "Left top" },
          { value: "left center", label: "Left center" },
          { value: "left bottom", label: "Left bottom" },
          { value: "right top", label: "Right top" },
          { value: "right center", label: "Right center" },
          { value: "right bottom", label: "Right bottom" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}::before",
          cssTemplate: "background-position: {{VALUE}}",
          condition: { "_ovImage!": "" },
          responsive: true,
        },
      ),
      select(
        "_ovRepeat",
        "Image repeat",
        [
          { value: "no-repeat", label: "None" },
          { value: "repeat", label: "Repeat" },
          { value: "repeat-x", label: "Repeat horizontally" },
          { value: "repeat-y", label: "Repeat vertically" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}::before",
          cssTemplate: "background-repeat: {{VALUE}}",
          condition: { "_ovImage!": "" },
          responsive: true,
        },
      ),
      select(
        "_ovAttachment",
        "Image attachment",
        [
          { value: "scroll", label: "Scroll (default)" },
          { value: "fixed", label: "Fixed (parallax effect)" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}::before",
          cssTemplate: "background-attachment: {{VALUE}}",
          condition: { "_ovImage!": "" },
          responsive: true,
          description: "Safari on iPhone/iPad ignores fixed (browser limitation).",
        },
      ),
      slider("_ovOpacity", "Overlay opacity", "{{WRAPPER}}::before", "opacity", {
        max: 1,
        step: 0.05,
        units: [""],
        cssTemplate: "opacity: {{SIZE}}",
        states: ["normal", "hover"],
      }),
      select(
        "_ovBlend",
        "Blend mode",
        [
          { value: "normal", label: "Normal" },
          { value: "multiply", label: "Multiply" },
          { value: "screen", label: "Screen" },
          { value: "overlay", label: "Overlay" },
          { value: "darken", label: "Darken" },
          { value: "lighten", label: "Lighten" },
          { value: "color-burn", label: "Color burn" },
          { value: "saturation", label: "Saturation" },
          { value: "color", label: "Color" },
          { value: "luminosity", label: "Luminosity" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}::before",
          cssTemplate: "mix-blend-mode: {{VALUE}}",
        },
      ),
    ]),
    style("container_shape", "Shape divider", [
      shapeDivider("_shapeTop", "Top"),
      shapeDivider("_shapeBottom", "Bottom"),
    ]),
  ],
};

// --- Popup ------------------------------------------------------------------

const popup: WidgetDef = {
  type: "popup",
  title: "Popup",
  icon: "square-mouse-pointer",
  category: "layout",
  isContainer: true,
  defaults: {
    settings: { name: "Popup", width: "md", showClose: "yes", trigger: "none", frequency: "always" },
  },
  sections: [
    content("popup_content", "Popup", [
      text("name", "Name (internal)", { placeholder: "E.g. Newsletter signup" }),
      select("width", "Width", [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
        { value: "full", label: "Extra large" },
      ]),
      switcher("showClose", "Show close button", { default: "yes" }),
    ]),
    content("popup_trigger", "Automatic opening", [
      select("trigger", "Trigger", [
        { value: "none", label: "Only from a button/image" },
        { value: "delay", label: "After a delay" },
        { value: "scroll", label: "After page scroll" },
        { value: "exit_intent", label: "On exit (exit intent)" },
      ]),
      text("triggerValue", "Value", {
        condition: { trigger: ["delay", "scroll"] },
        placeholder: "3000",
        description: "Milliseconds for the delay, percentage (0-100) for the scroll.",
      }),
      select("frequency", "Frequency", [
        { value: "always", label: "Always" },
        { value: "once_session", label: "Once per session" },
        { value: "once_days", label: "Once every N days" },
      ], { condition: { "trigger!": "none" } }),
      text("frequencyDays", "Days", {
        condition: { frequency: "once_days" },
        placeholder: "7",
        default: "7",
      }),
    ]),
    style("popup_style", "Style", [
      color("_bg", "Background color", "{{WRAPPER}} .b-popup__box", "background-color"),
      // Box background: the advanced controls (_bgImage etc.) target the popup
      // wrapper, which sits BEHIND the overlay and is invisible: the box needs
      // dedicated controls with this selector.
      gradient("bgGradient", "Background gradient", "{{WRAPPER}} .b-popup__box", {
        description:
          "Two-color gradient (linear or radial) for the popup box. When set it covers the background image.",
      }),
      media("bgImage", "Background image", {
        group: "style",
        selector: "{{WRAPPER}} .b-popup__box",
        responsive: true,
        description:
          "Background image of the popup box. Switch device in the top bar to upload a different one per device.",
      }),
      select(
        "bgSize",
        "Background size",
        [
          { value: "cover", label: "Cover" },
          { value: "contain", label: "Contain" },
          { value: "auto", label: "Auto" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}} .b-popup__box",
          cssTemplate: "background-size: {{VALUE}}",
          condition: { "bgImage!": "" },
          responsive: true,
        },
      ),
      select(
        "bgPosition",
        "Background position",
        [
          { value: "center center", label: "Center center" },
          { value: "center top", label: "Center top" },
          { value: "center bottom", label: "Center bottom" },
          { value: "left top", label: "Left top" },
          { value: "left center", label: "Left center" },
          { value: "left bottom", label: "Left bottom" },
          { value: "right top", label: "Right top" },
          { value: "right center", label: "Right center" },
          { value: "right bottom", label: "Right bottom" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}} .b-popup__box",
          cssTemplate: "background-position: {{VALUE}}",
          condition: { "bgImage!": "" },
          responsive: true,
        },
      ),
      select(
        "bgRepeat",
        "Background repeat",
        [
          { value: "no-repeat", label: "None" },
          { value: "repeat", label: "Repeat" },
          { value: "repeat-x", label: "Repeat horizontally" },
          { value: "repeat-y", label: "Repeat vertically" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}} .b-popup__box",
          cssTemplate: "background-repeat: {{VALUE}}",
          condition: { "bgImage!": "" },
          responsive: true,
        },
      ),
      dimensions("padding", "Padding", "{{WRAPPER}} .b-popup__box", "padding"),
      dimensions("radius", "Border radius", "{{WRAPPER}} .b-popup__box", "border-radius"),
      color("overlayColor", "Overlay color", "{{WRAPPER}} .b-popup__overlay", "background-color"),
      // Close X button: hover with a dedicated selector (the generic hover state
      // would apply to the popup wrapper, not to the button).
      color("closeColor", "Close X color", "{{WRAPPER}} .b-popup__close", "color", {
        states: ["normal"],
        description: "Useful on dark popups, where the default grey X is not visible.",
      }),
      color(
        "closeColorHover",
        "Close X hover color",
        "{{WRAPPER}} .b-popup__close:hover",
        "color",
        { states: ["normal"] },
      ),
      color(
        "closeBg",
        "Close X background",
        "{{WRAPPER}} .b-popup__close",
        "background-color",
        { states: ["normal"] },
      ),
    ]),
  ],
};

// --- Nav menu ----------------------------------------------------------------

const navMenu: WidgetDef = {
  type: "nav-menu",
  title: "Navigation menu",
  icon: "menu",
  category: "layout",
  defaults: {
    settings: {
      logoText: "Logo",
      collapse: "mobile",
      items: [
        { label: "Section 1", link: "#sezione-1" },
        { label: "Section 2", link: "#sezione-2" },
      ],
    },
  },
  sections: [
    content("nav_logo", "Logo", [
      media("logo", "Logo image", { responsive: true, description: RESPONSIVE_MEDIA_HINT }),
      text("logoText", "Logo text (when there is no image)", { placeholder: "Brand name" }),
      url("logoLink", "Logo link"),
      slider("logoHeight", "Logo height", "{{WRAPPER}} .b-nav__logo img", "height", {
        max: 120,
        default: { size: 40, unit: "px" },
      }),
    ]),
    content("nav_items", "Menu items", [
      repeater("items", "Items", [
        text("label", "Label"),
        url("link", "Link"),
      ]),
      select("collapse", "Hamburger from", [
        { value: "mobile", label: "Mobile (≤767px)" },
        { value: "tablet", label: "Tablet (≤1024px)" },
        { value: "never", label: "Never (always expanded)" },
      ]),
    ]),
    content("nav_cta", "CTA button (optional)", [
      text("ctaText", "Text", { placeholder: "Sign up now" }),
      url("ctaLink", "Link"),
    ]),
    style("nav_style", "Style", [
      color("itemColor", "Items color", "{{WRAPPER}} .b-nav__item", "color", {
        states: ["normal", "hover"],
      }),
      typography("{{WRAPPER}} .b-nav__item"),
      color("ctaBg", "CTA background", "{{WRAPPER}} .b-nav__cta", "background-color"),
      color("ctaColor", "CTA color", "{{WRAPPER}} .b-nav__cta", "color"),
      color("burgerColor", "Hamburger color", "{{WRAPPER}} .b-nav__burger", "color"),
      color("panelBg", "Mobile panel background", "{{WRAPPER}} .b-nav__items", "background-color"),
      slider("itemsGap", "Space between items", "{{WRAPPER}} .b-nav__items", "gap", { max: 80 }),
    ]),
  ],
};

// --- Anchor -------------------------------------------------------------------

const anchor: WidgetDef = {
  type: "anchor",
  title: "Anchor",
  icon: "anchor",
  category: "layout",
  defaults: { settings: { anchorId: "sezione" } },
  sections: [
    content("anchor_content", "Anchor", [
      text("anchorId", "Anchor ID (without #)", {
        placeholder: "e.g. pricing",
        description: "Links with href \"#<id>\" scroll to this point.",
      }),
    ]),
  ],
};

// --- Heading ----------------------------------------------------------------

const heading: WidgetDef = {
  type: "heading",
  title: "Heading",
  icon: "heading",
  category: "basic",
  defaults: { settings: { title: "Add your heading", htmlTag: "h2" } },
  sections: [
    content("heading_content", "Heading", [
      textarea("title", "Text", {
        description:
          "Inline HTML allowed: <br> for a line break, <strong>/<em> for bold and italic, <span>word</span> for the part to highlight (set its color in Style → <span> parts color).",
      }),
      select("htmlTag", "HTML tag", H_TAGS),
      url("link", "Link"),
    ]),
    style("heading_style", "Style", [
      chooseAlign("align", "{{WRAPPER}} .b-heading"),
      color("color", "Color", "{{WRAPPER}} .b-heading", "color"),
      // Colors only the parts wrapped in <span> inside the text: the quick way
      // to highlight a word without writing inline styles.
      color("spanColor", "<span> parts color", "{{WRAPPER}} .b-heading span", "color", {
        description:
          "Applies to the text you wrap in <span>…</span> in the Text field. Useful to highlight a word.",
      }),
      typography("{{WRAPPER}} .b-heading"),
      boxShadow("textShadow", "Text shadow", "{{WRAPPER}} .b-heading", {
        // Glyph shadow (text-shadow), not the element box's.
        cssTemplate: "text-shadow",
      }),
    ]),
  ],
};

// --- Text editor ------------------------------------------------------------

const textEditor: WidgetDef = {
  type: "text",
  title: "Text",
  icon: "type",
  category: "basic",
  defaults: {
    settings: {
      editor:
        "<p>Write your text here. Describe the product, the service or the main message.</p>",
    },
  },
  sections: [
    content("text_content", "Text", [richtext("editor", "Content")]),
    style("text_style", "Style", [
      chooseAlign("align", "{{WRAPPER}} .b-text"),
      color("color", "Text color", "{{WRAPPER}} .b-text", "color"),
      color("linkColor", "Link color", "{{WRAPPER}} .b-text a", "color"),
      typography("{{WRAPPER}} .b-text"),
    ]),
  ],
};

// --- Button -----------------------------------------------------------------

const button: WidgetDef = {
  type: "button",
  title: "Button",
  icon: "mouse-pointer-click",
  category: "basic",
  defaults: { settings: { text: "Click here", action: "link", link: { url: "#" }, size: "md" } },
  sections: [
    content("button_content", "Button", [
      text("text", "Text", {
        description:
          "Inline HTML allowed: <br> for a line break, <span>word</span> for the part to highlight (set its color in Style → <span> parts color).",
      }),
      select("action", "Click action", [
        { value: "link", label: "Open a link" },
        { value: "open_popup", label: "Open a popup" },
      ], { default: "link" }),
      url("link", "Link", { condition: { "action!": "open_popup" } }),
      popupSelect("popupId", "Popup to open", { condition: { action: "open_popup" } }),
      select("size", "Size", [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
      ]),
      iconControl("icon", "Icon"),
      select("iconAlign", "Icon position", [
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ], { condition: { "icon!": "" } }),
      chooseAlign("align", "{{WRAPPER}}"),
    ]),
    style("button_style", "Style", [
      typography("{{WRAPPER}} .b-btn"),
      color("textColor", "Text color", "{{WRAPPER}} .b-btn", "color"),
      color("spanColor", "<span> parts color", "{{WRAPPER}} .b-btn__label span", "color", {
        description:
          "Applies to the text you wrap in <span>…</span> in the Text field. Useful to highlight a word.",
      }),
      color("bgColor", "Background color", "{{WRAPPER}} .b-btn", "background-color"),
      gradient("bgGradient", "Background gradient", "{{WRAPPER}} .b-btn", {
        description:
          "When set, the gradient covers the background color. You can set a different one for hover.",
      }),
      dimensions("radius", "Border radius", "{{WRAPPER}} .b-btn", "border-radius"),
      dimensions("padding", "Padding", "{{WRAPPER}} .b-btn", "padding"),
      boxShadow("shadow", "Shadow", "{{WRAPPER}} .b-btn"),
    ]),
  ],
};

// --- Image ------------------------------------------------------------------

const image: WidgetDef = {
  type: "image",
  title: "Image",
  icon: "image",
  category: "media",
  defaults: { settings: {} },
  sections: [
    content("image_content", "Image", [
      media("image", "Image", { responsive: true, description: RESPONSIVE_MEDIA_HINT }),
      text("alt", "Alt text"),
      text("caption", "Caption"),
      select("action", "Click action", [
        { value: "link", label: "Open a link" },
        { value: "open_popup", label: "Open a popup" },
      ], { default: "link" }),
      url("link", "Link", { condition: { "action!": "open_popup" } }),
      popupSelect("popupId", "Popup to open", { condition: { action: "open_popup" } }),
    ]),
    style("image_style", "Style", [
      chooseAlign("align", "{{WRAPPER}}"),
      slider("width", "Width", "{{WRAPPER}} img", "width", {
        units: ["px", "%"],
        max: 100,
        responsive: true,
      }),
      slider("height", "Height", "{{WRAPPER}} img", "height", {
        units: ["px", "vh"],
        max: 1200,
        responsive: true,
        description:
          "Fixed image height: combine it with Object fit (Cover/Contain) for cropping.",
      }),
      select("objectFit", "Object fit", [
        { value: "cover", label: "Cover" },
        { value: "contain", label: "Contain" },
        { value: "fill", label: "Fill" },
      ], {
        group: "style",
        selector: "{{WRAPPER}} img",
        cssTemplate: "object-fit: {{VALUE}}",
      }),
      dimensions("radius", "Border radius", "{{WRAPPER}} img", "border-radius"),
      boxShadow("shadow", "Shadow", "{{WRAPPER}} img"),
    ]),
  ],
};

// --- Icon -------------------------------------------------------------------

const icon: WidgetDef = {
  type: "icon",
  title: "Icon",
  icon: "star",
  category: "basic",
  defaults: { settings: { icon: "star", view: "default" } },
  sections: [
    content("icon_content", "Icon", [
      iconControl("icon", "Icon"),
      media("image", "Image (PNG/SVG)", {
        description: "When set it replaces the library icon.",
      }),
      select("view", "View", [
        { value: "default", label: "Default" },
        { value: "stacked", label: "Stacked" },
        { value: "framed", label: "Framed" },
      ]),
      url("link", "Link"),
    ]),
    style("icon_style", "Style", [
      chooseAlign("align", "{{WRAPPER}}"),
      color("color", "Primary color", "{{WRAPPER}} .b-icon", "color"),
      color("bgColor", "Secondary color", "{{WRAPPER}} .b-icon", "background-color", {
        condition: { "view!": "default" },
      }),
      slider("size", "Size", "{{WRAPPER}} .b-icon", "font-size", { max: 300 }),
      dimensions("padding", "Padding", "{{WRAPPER}} .b-icon", "padding", {
        condition: { "view!": "default" },
      }),
    ]),
  ],
};

// --- Icon box ---------------------------------------------------------------

const iconBox: WidgetDef = {
  type: "icon-box",
  title: "Icon box",
  icon: "square-stack",
  category: "content",
  defaults: {
    settings: {
      icon: "star",
      title: "Title",
      description: "Describe the benefit or the feature here.",
      titleTag: "h3",
    },
  },
  sections: [
    content("iconbox_content", "Content", [
      iconControl("icon", "Icon"),
      media("image", "Image (PNG/SVG)", {
        description: "When set it replaces the library icon.",
      }),
      text("title", "Title"),
      textarea("description", "Description"),
      select("titleTag", "Title tag", H_TAGS),
      url("link", "Link"),
      choose("position", "Icon position", [
        { value: "top", label: "Top", icon: "align-center" },
        { value: "left", label: "Left", icon: "align-left" },
        { value: "right", label: "Right", icon: "align-right" },
      ]),
    ]),
    style("iconbox_style", "Style", [
      color("iconColor", "Icon color", "{{WRAPPER}} .b-iconbox__icon", "color"),
      slider("iconSize", "Icon size", "{{WRAPPER}} .b-iconbox__icon", "font-size", { max: 200 }),
      color("titleColor", "Title color", "{{WRAPPER}} .b-iconbox__title", "color"),
      typography("{{WRAPPER}} .b-iconbox__title", { key: "titleTypography", label: "Title typography" }),
      slider("titleSpacing", "Space below the title", "{{WRAPPER}} .b-iconbox__title", "margin-bottom", { max: 80 }),
      color("descColor", "Description color", "{{WRAPPER}} .b-iconbox__desc", "color"),
      typography("{{WRAPPER}} .b-iconbox__desc", { key: "descTypography", label: "Description typography" }),
    ]),
  ],
};

// --- Image box --------------------------------------------------------------

const imageBox: WidgetDef = {
  type: "image-box",
  title: "Image box",
  icon: "image-plus",
  category: "content",
  defaults: {
    settings: {
      title: "Title",
      description: "Write the description here.",
      titleTag: "h3",
    },
  },
  sections: [
    content("imagebox_content", "Content", [
      media("image", "Image", { responsive: true, description: RESPONSIVE_MEDIA_HINT }),
      text("title", "Title"),
      textarea("description", "Description"),
      select("titleTag", "Title tag", H_TAGS),
      url("link", "Link"),
    ]),
    style("imagebox_style", "Style", [
      chooseAlign("align", "{{WRAPPER}} .b-imagebox"),
      dimensions("imageRadius", "Image radius", "{{WRAPPER}} .b-imagebox__img img", "border-radius"),
      color("titleColor", "Title color", "{{WRAPPER}} .b-imagebox__title", "color"),
      typography("{{WRAPPER}} .b-imagebox__title", { key: "titleTypography", label: "Title typography" }),
      slider("titleSpacing", "Space below the title", "{{WRAPPER}} .b-imagebox__title", "margin-bottom", { max: 80 }),
      color("descColor", "Description color", "{{WRAPPER}} .b-imagebox__desc", "color"),
      typography("{{WRAPPER}} .b-imagebox__desc", { key: "descTypography", label: "Description typography" }),
    ]),
  ],
};

// --- Video ------------------------------------------------------------------

const video: WidgetDef = {
  type: "video",
  title: "Video",
  icon: "play",
  category: "media",
  defaults: {
    settings: {
      videoType: "youtube",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      aspectRatio: "169",
    },
  },
  sections: [
    content("video_content", "Video", [
      select("videoType", "Source", [
        { value: "youtube", label: "YouTube" },
        { value: "vimeo", label: "Vimeo" },
        { value: "hosted", label: "File (MP4)" },
      ]),
      text("url", "URL", { condition: { videoType: ["youtube", "vimeo"] } }),
      media("videoFile", "MP4 file (upload)", { condition: { videoType: "hosted" } }),
      select("aspectRatio", "Aspect ratio", [
        { value: "169", label: "16:9" },
        { value: "43", label: "4:3" },
        { value: "11", label: "1:1" },
        { value: "219", label: "21:9" },
      ]),
      switcher("autoplay", "Autoplay"),
      switcher("controls", "Show controls", { default: "yes" }),
    ]),
    style("video_style", "Style", [
      // The player always fills the block: centering is max-width + auto margins.
      slider("videoWidth", "Max width", "{{WRAPPER}}", "max-width", {
        units: ["%", "px"],
        max: 1600,
        responsive: true,
      }),
      choose(
        "videoAlign",
        "Alignment",
        // Values are margin-inline (start end) directly.
        [
          { value: "0 auto", label: "Left", icon: "align-left" },
          { value: "auto", label: "Center", icon: "align-center" },
          { value: "auto 0", label: "Right", icon: "align-right" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "margin-inline: {{VALUE}}",
          responsive: true,
          description: "Active when a max width is set.",
        },
      ),
      dimensions("radius", "Border radius", "{{WRAPPER}} .b-video", "border-radius"),
      boxShadow("shadow", "Shadow", "{{WRAPPER}} .b-video"),
    ]),
  ],
};


// --- Divider ----------------------------------------------------------------

const divider: WidgetDef = {
  type: "divider",
  title: "Divider",
  icon: "minus",
  category: "basic",
  defaults: { settings: { dividerStyle: "solid" } },
  sections: [
    content("divider_content", "Divider", [
      select("dividerStyle", "Style", [
        { value: "solid", label: "Solid" },
        { value: "dashed", label: "Dashed" },
        { value: "dotted", label: "Dotted" },
        { value: "double", label: "Double" },
      ]),
      slider("width", "Width", "{{WRAPPER}} .b-divider", "width", {
        units: ["%", "px"],
        max: 100,
        group: "style",
      }),
    ]),
    style("divider_style", "Style", [
      color("color", "Color", "{{WRAPPER}} .b-divider", "border-top-color"),
      slider("weight", "Weight", "{{WRAPPER}} .b-divider", "border-top-width", { max: 40, units: ["px"] }),
    ]),
  ],
};

// --- Spacer -----------------------------------------------------------------

const spacer: WidgetDef = {
  type: "spacer",
  title: "Spacer",
  icon: "move-vertical",
  category: "basic",
  defaults: { settings: {}, styles: [{ breakpoint: "desktop", state: "normal", props: { space: { size: 50, unit: "px" } } }] },
  sections: [
    style("spacer_style", "Spacer", [
      slider("space", "Height", "{{WRAPPER}} .b-spacer", "height", { max: 600, units: ["px", "vh"] }),
    ]),
  ],
};

// --- Icon list --------------------------------------------------------------

const iconList: WidgetDef = {
  type: "icon-list",
  title: "Icon list",
  icon: "list",
  category: "content",
  defaults: {
    settings: {
      items: [
        { text: "First item", icon: "check" },
        { text: "Second item", icon: "check" },
        { text: "Third item", icon: "check" },
      ],
    },
  },
  sections: [
    content("iconlist_content", "Items", [
      repeater(
        "items",
        "Items",
        [
          text("text", "Text"),
          iconControl("icon", "Icon"),
          {
            key: "color",
            type: "color",
            label: "Icon color",
            group: "content",
            description: "Color of this icon only (empty = general Style color).",
          },
          media("image", "Image (PNG/SVG)", {
            description: "When set it replaces the library icon.",
          }),
          url("link", "Link"),
        ],
        { titleField: "text" },
      ),
    ]),
    style("iconlist_style", "Style", [
      color("iconColor", "Icons color", "{{WRAPPER}} .b-iconlist__icon", "color"),
      color("textColor", "Text color", "{{WRAPPER}} .b-iconlist__text", "color"),
      slider("iconSize", "Icon/image size", "{{WRAPPER}} .b-iconlist__icon svg, {{WRAPPER}} .b-iconlist__icon img", "width", {
        max: 96,
        cssTemplate: "width:{{SIZE}}{{UNIT}};height:{{SIZE}}{{UNIT}}",
      }),
      slider("gap", "Space between items", "{{WRAPPER}} .b-iconlist", "gap", { max: 60 }),
      typography("{{WRAPPER}} .b-iconlist__text"),
    ]),
  ],
};

// --- Counter ----------------------------------------------------------------

const counter: WidgetDef = {
  type: "counter",
  title: "Counter",
  icon: "hash",
  category: "content",
  defaults: { settings: { start: 0, end: 100, duration: 2000, title: "Happy customers" } },
  sections: [
    content("counter_content", "Counter", [
      text("start", "Starting number", { default: "0" }),
      text("end", "Ending number", { default: "100" }),
      text("prefix", "Prefix"),
      text("suffix", "Suffix"),
      text("duration", "Duration (ms)", { default: "2000" }),
      text("title", "Title"),
    ]),
    style("counter_style", "Style", [
      color("numberColor", "Number color", "{{WRAPPER}} .b-counter__num", "color"),
      typography("{{WRAPPER}} .b-counter__num", { key: "numberTypography", label: "Number typography" }),
      color("titleColor", "Title color", "{{WRAPPER}} .b-counter__title", "color"),
    ]),
  ],
};

// --- Progress bar -----------------------------------------------------------

const progress: WidgetDef = {
  type: "progress",
  title: "Progress bar",
  icon: "loader",
  category: "content",
  defaults: { settings: { title: "Skill", percent: 75, showPercent: "yes" } },
  sections: [
    content("progress_content", "Progress", [
      text("title", "Title"),
      slider("percent", "Percentage", "{{WRAPPER}} .b-progress__bar", "width", {
        units: ["%"],
        max: 100,
        group: "content",
      }),
      switcher("showPercent", "Show percentage", { default: "yes" }),
    ]),
    style("progress_style", "Style", [
      color("barColor", "Bar color", "{{WRAPPER}} .b-progress__bar", "background-color"),
      color("bgColor", "Background color", "{{WRAPPER}} .b-progress", "background-color"),
      slider("height", "Height", "{{WRAPPER}} .b-progress", "height", { max: 80 }),
    ]),
  ],
};

// --- Star rating ------------------------------------------------------------

const starRating: WidgetDef = {
  type: "star-rating",
  title: "Star rating",
  icon: "star",
  category: "content",
  defaults: { settings: { scale: "5", rating: 5, title: "" } },
  sections: [
    content("rating_content", "Star rating", [
      select("scale", "Scale", [
        { value: "5", label: "0-5" },
        { value: "10", label: "0-10" },
      ]),
      text("rating", "Rating", { default: "5" }),
      text("title", "Title"),
    ]),
    style("rating_style", "Style", [
      color("starColor", "Stars color", "{{WRAPPER}} .b-rating__star.is-on", "color"),
      color("emptyColor", "Empty stars color", "{{WRAPPER}} .b-rating__star", "color"),
      slider("size", "Size", "{{WRAPPER}} .b-rating", "font-size", { max: 80 }),
    ]),
  ],
};

// --- Testimonial ------------------------------------------------------------

const testimonial: WidgetDef = {
  type: "testimonial",
  title: "Testimonial",
  icon: "quote",
  category: "content",
  defaults: {
    settings: {
      content: "An outstanding service that exceeded all our expectations.",
      name: "Jane Doe",
      role: "CEO, Company",
    },
  },
  sections: [
    content("testimonial_content", "Testimonial", [
      textarea("content", "Text"),
      media("image", "Photo", { responsive: true, description: RESPONSIVE_MEDIA_HINT }),
      text("name", "Name"),
      text("role", "Role"),
    ]),
    style("testimonial_style", "Style", [
      color("contentColor", "Text color", "{{WRAPPER}} .b-testimonial__content", "color"),
      color("nameColor", "Name color", "{{WRAPPER}} .b-testimonial__name", "color"),
      slider("imageSize", "Photo size", "{{WRAPPER}} .b-testimonial__img", "width", { max: 200 }),
    ]),
  ],
};

// --- Tabs -------------------------------------------------------------------

const tabs: WidgetDef = {
  type: "tabs",
  title: "Tabs",
  icon: "panel-top",
  category: "content",
  defaults: {
    settings: {
      items: [
        { title: "Tab 1", content: "<p>Content of the first tab.</p>" },
        { title: "Tab 2", content: "<p>Content of the second tab.</p>" },
      ],
    },
  },
  sections: [
    content("tabs_content", "Tabs", [
      repeater("items", "Tabs", [text("title", "Title"), richtext("content", "Content")], {
        titleField: "title",
      }),
    ]),
    style("tabs_style", "Style", [
      color("tabColor", "Titles color", "{{WRAPPER}} .b-tabs__tab", "color"),
      color("activeColor", "Active tab color", "{{WRAPPER}} .b-tabs__tab.is-active", "color"),
      color("borderColor", "Borders color", "{{WRAPPER}} .b-tabs", "border-color"),
    ]),
  ],
};

// --- Accordion --------------------------------------------------------------

const accordion: WidgetDef = {
  type: "accordion",
  title: "Accordion",
  icon: "chevrons-down-up",
  category: "content",
  defaults: {
    settings: {
      items: [
        { title: "Question 1?", content: "<p>Answer to the first question.</p>" },
        { title: "Question 2?", content: "<p>Answer to the second question.</p>" },
      ],
    },
  },
  sections: [
    content("accordion_content", "Items", [
      repeater("items", "Items", [text("title", "Title"), richtext("content", "Content")], {
        titleField: "title",
      }),
    ]),
    style("accordion_style", "Style", [
      color("titleColor", "Titles color", "{{WRAPPER}} .b-accordion__title", "color"),
      color("contentColor", "Content color", "{{WRAPPER}} .b-accordion__content", "color"),
      color("borderColor", "Borders color", "{{WRAPPER}} .b-accordion__item", "border-color"),
    ]),
  ],
};

// --- Social icons -----------------------------------------------------------

const socialIcons: WidgetDef = {
  type: "social-icons",
  title: "Social icons",
  icon: "share-2",
  category: "content",
  defaults: {
    settings: {
      items: [
        { network: "facebook", link: { url: "#" } },
        { network: "instagram", link: { url: "#" } },
      ],
    },
  },
  sections: [
    content("social_content", "Icons", [
      repeater(
        "items",
        "Social",
        [
          select("network", "Network", [
            { value: "facebook", label: "Facebook" },
            { value: "instagram", label: "Instagram" },
            { value: "x", label: "X (Twitter)" },
            { value: "linkedin", label: "LinkedIn" },
            { value: "youtube", label: "YouTube" },
            { value: "whatsapp", label: "WhatsApp" },
            { value: "telegram", label: "Telegram" },
          ]),
          url("link", "Link"),
        ],
        { titleField: "network" },
      ),
      choose("align", "Alignment", [
        { value: "flex-start", label: "Left", icon: "align-left" },
        { value: "center", label: "Center", icon: "align-center" },
        { value: "flex-end", label: "Right", icon: "align-right" },
      ], { group: "style", selector: "{{WRAPPER}} .b-social", cssTemplate: "justify-content: {{VALUE}}" }),
    ]),
    style("social_style", "Style", [
      color("iconColor", "Icons color", "{{WRAPPER}} .b-social__link", "color"),
      color("bgColor", "Background color", "{{WRAPPER}} .b-social__link", "background-color"),
      slider("size", "Size", "{{WRAPPER}} .b-social__link", "font-size", { max: 80 }),
    ]),
  ],
};

// --- Alert ------------------------------------------------------------------

const alert: WidgetDef = {
  type: "alert",
  title: "Alert",
  icon: "triangle-alert",
  category: "content",
  defaults: {
    settings: { alertType: "info", title: "Warning", description: "This is an informational message." },
  },
  sections: [
    content("alert_content", "Alert", [
      select("alertType", "Type", [
        { value: "info", label: "Info" },
        { value: "success", label: "Success" },
        { value: "warning", label: "Warning" },
        { value: "danger", label: "Error" },
      ]),
      text("title", "Title"),
      textarea("description", "Description"),
    ]),
    style("alert_style", "Style", [
      color("bgColor", "Background color", "{{WRAPPER}} .b-alert", "background-color"),
      color("titleColor", "Title color", "{{WRAPPER}} .b-alert__title", "color"),
      color("textColor", "Text color", "{{WRAPPER}} .b-alert__desc", "color"),
    ]),
  ],
};

// --- HTML -------------------------------------------------------------------

const html: WidgetDef = {
  type: "html",
  title: "HTML",
  icon: "code",
  category: "basic",
  defaults: { settings: { html: "<!-- Inserisci qui il tuo HTML -->" } },
  sections: [content("html_content", "HTML", [codeControl("html", "HTML code")])],
};

// --- Image gallery ----------------------------------------------------------

const imageGallery: WidgetDef = {
  type: "image-gallery",
  title: "Gallery",
  icon: "images",
  category: "media",
  defaults: { settings: { items: [], columns: "3" } },
  sections: [
    content("gallery_content", "Gallery", [
      repeater("items", "Images", [media("image", "Image"), text("alt", "Alt")], {
        titleField: "alt",
      }),
      select("columns", "Columns", [
        { value: "2", label: "2" },
        { value: "3", label: "3" },
        { value: "4", label: "4" },
        { value: "5", label: "5" },
      ]),
    ]),
    style("gallery_style", "Style", [
      slider("gap", "Spacing", "{{WRAPPER}} .b-gallery", "gap", { max: 60 }),
      dimensions("radius", "Border radius", "{{WRAPPER}} .b-gallery img", "border-radius"),
    ]),
  ],
};

// --- Image carousel ---------------------------------------------------------

const imageCarousel: WidgetDef = {
  type: "image-carousel",
  title: "Carousel",
  icon: "gallery-horizontal",
  category: "media",
  defaults: { settings: { items: [], slidesToShow: "3", autoplay: "yes" } },
  sections: [
    content("carousel_content", "Carousel", [
      repeater("items", "Images", [media("image", "Image"), text("alt", "Alt")], {
        titleField: "alt",
      }),
      select("slidesToShow", "Visible slides", [
        { value: "1", label: "1" },
        { value: "2", label: "2" },
        { value: "3", label: "3" },
        { value: "4", label: "4" },
      ]),
      switcher("autoplay", "Autoplay", { default: "yes" }),
    ]),
    style("carousel_style", "Style", [
      slider("gap", "Spacing", "{{WRAPPER}} .b-carousel", "gap", { max: 60 }),
      dimensions("radius", "Border radius", "{{WRAPPER}} .b-carousel img", "border-radius"),
    ]),
  ],
};

// --- Google maps ------------------------------------------------------------

const googleMaps: WidgetDef = {
  type: "google-maps",
  title: "Map",
  icon: "map-pin",
  category: "media",
  defaults: { settings: { address: "Rome, Italy", zoom: 12 } },
  sections: [
    content("map_content", "Map", [
      text("address", "Address"),
      text("zoom", "Zoom (1-20)", { default: "12" }),
      text("apiKey", "Google Maps API key (optional)", {
        placeholder: "AIza...",
        description: "With a key the official Embed API is used, without limitations.",
      }),
    ]),
    style("map_style", "Style", [
      slider("height", "Height", "{{WRAPPER}} .b-map", "height", { max: 900, units: ["px"] }),
      dimensions("radius", "Border radius", "{{WRAPPER}} .b-map", "border-radius"),
    ]),
  ],
};

// --- Form and booking (native amable embeds) ---------------------------------

const form: WidgetDef = {
  type: "form",
  title: "Form",
  icon: "text-cursor-input",
  category: "form",
  defaults: { settings: {} },
  sections: [
    content("form_content", "Form", [
      text("formId", "Form ID", {
        description: "Pick one of the forms created in the Forms section.",
      }),
    ]),
  ],
};

const booking: WidgetDef = {
  type: "booking",
  title: "Booking",
  icon: "calendar-check",
  category: "form",
  defaults: { settings: {} },
  sections: [
    content("booking_content", "Booking", [
      text("eventSlug", "Event type", {
        description: "The slug of one of the event types created in the Bookings section.",
      }),
    ]),
  ],
};

// --- Checkout (native amable embeds) ----------------------------------------

const checkout: WidgetDef = {
  type: "checkout",
  title: "Checkout",
  icon: "shopping-cart",
  category: "form",
  defaults: { settings: {} },
  sections: [
    content("checkout_content", "Checkout", [
      text("checkoutId", "Checkout ID", {
        description: "Pick one of the checkouts created in the E-commerce section.",
      }),
    ]),
  ],
};

const checkoutOffer: WidgetDef = {
  type: "checkout-offer",
  title: "Post-purchase offer",
  icon: "gift",
  category: "form",
  defaults: { settings: { display: "full" } },
  sections: [
    content("offer_content", "Offer", [
      select("display", "Display", [
        { value: "full", label: "Offer and buttons" },
        { value: "buttons", label: "Buttons only" },
      ]),
      text("buttonColor", "Button color", {
        placeholder: "#4f46e5",
        description: "Shows the upsell or downsell the buyer reached after paying (one-click accept or decline).",
      }),
    ]),
  ],
};

export const WIDGET_LIST: WidgetDef[] = [
  container,
  popup,
  navMenu,
  anchor,
  heading,
  textEditor,
  button,
  image,
  icon,
  iconBox,
  imageBox,
  video,
  divider,
  spacer,
  iconList,
  counter,
  progress,
  starRating,
  testimonial,
  tabs,
  accordion,
  socialIcons,
  alert,
  html,
  imageGallery,
  imageCarousel,
  googleMaps,
  form,
  booking,
  checkout,
  checkoutOffer,
];

export const WIDGETS: Record<string, WidgetDef> = Object.fromEntries(
  WIDGET_LIST.map((w) => [w.type, w]),
);

export function getWidgetDef(type: string): WidgetDef | undefined {
  return WIDGETS[type];
}
