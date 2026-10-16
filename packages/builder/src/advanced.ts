import {
  type ControlSection,
  color,
  slider,
  dimensions,
  boxShadow,
  select,
  switcher,
  text,
  media,
  gradient,
  codeControl,
} from "./controls";

/**
 * The Advanced tab, shared by every widget and container (the shared
 * common widget). Rendered generically like any other style/content controls, with a
 * few keys (`_cssId`, `_cssClasses`, `_customCss`, the `_hide*` flags) given
 * special treatment by the renderer.
 */
export const ADVANCED_SECTIONS: ControlSection[] = [
  {
    id: "adv_layout",
    label: "Layout",
    tab: "advanced",
    controls: [
      dimensions("_margin", "Margin", "{{WRAPPER}}", "margin"),
      dimensions("_padding", "Padding", "{{WRAPPER}}", "padding"),
      slider("_width", "Width", "{{WRAPPER}}", "width", {
        units: ["px", "%", "vw"],
        max: 1600,
        responsive: true,
        // max-width: a fixed width (e.g. 650px) must never overflow the parent
        // container on narrow screens: it stops at the parent's inner edge
        // (padding included), with no mobile override needed.
        cssTemplate: "width: {{SIZE}}{{UNIT}};max-width:100%",
      }),
      slider("_zIndex", "Z-index", "{{WRAPPER}}", "z-index", {
        units: [""],
        max: 9999,
        // z-index applies ONLY to positioned elements: without this supporting
        // position:relative it was silently ignored on static widgets. Low
        // cssOrder = emitted first, so an explicit _position (absolute/fixed)
        // declared later wins.
        cssOrder: 5,
        cssTemplate: "position: relative;z-index: {{SIZE}}",
        description: "Stacking order: higher = on top.",
      }),
      select(
        "_flexAlignSelf",
        "Align self (in flex)",
        [
          { value: "auto", label: "Auto" },
          { value: "flex-start", label: "Start" },
          { value: "center", label: "Center" },
          { value: "flex-end", label: "End" },
          { value: "stretch", label: "Stretch" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "align-self: {{VALUE}}",
          responsive: true,
        },
      ),
      slider("_flexGrow", "Grow (in flex)", "{{WRAPPER}}", "flex-grow", {
        units: [""],
        max: 10,
        cssTemplate: "flex-grow: {{SIZE}}",
      }),
    ],
  },
  {
    id: "adv_position",
    label: "Position",
    tab: "advanced",
    controls: [
      select(
        "_position",
        "Position",
        [
          { value: "", label: "Default (in flow)" },
          { value: "relative", label: "Relative" },
          { value: "absolute", label: "Absolute" },
          { value: "fixed", label: "Fixed (relative to the screen)" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "position: {{VALUE}}",
          responsive: true,
          description:
            "Relative: stays in the flow and moves by the offsets. Absolute: leaves the flow and anchors to the parent container. For a bar that follows the scroll use the Sticky section instead. Use Z-index (Layout) to decide what sits on top.",
        },
      ),
      ...(
        [
          ["_offsetTop", "Top offset", "top"],
          ["_offsetRight", "Right offset", "right"],
          ["_offsetBottom", "Bottom offset", "bottom"],
          ["_offsetLeft", "Left offset", "left"],
        ] as const
      ).map(([key, label, prop]) =>
        slider(key, label, "{{WRAPPER}}", prop, {
          units: ["px", "%", "vh", "vw"],
          min: -2000,
          max: 2000,
          condition: { "_position!": "" },
        }),
      ),
    ],
  },
  {
    id: "adv_sticky",
    label: "Sticky",
    tab: "advanced",
    // With a manual position active there would be two conflicting `position`
    // declarations in the same rule: sticky is configured only here.
    condition: { _position: "" },
    controls: [
      select(
        "_sticky",
        "Follows the scroll",
        [
          { value: "", label: "No, stays in place" },
          { value: "top", label: "Yes, at the top (like a header)" },
          { value: "bottom", label: "Yes, at the bottom (like a footer bar)" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          // {{VALUE}} is "top" or "bottom". Offset and z-index are overridable
          // defaults: the dedicated controls have a higher cssOrder and are emitted
          // later. The z-index is needed because a section with a shape divider
          // (position:relative) would otherwise cover the fixed bar.
          cssTemplate: "position: sticky; {{VALUE}}: 0; z-index: 100",
          cssOrder: 1,
          responsive: true,
          description:
            "The element scrolls with the page up to the chosen edge, then stays there for the rest of the scroll. Give it a background color, otherwise the content below shows through. Switch device in the top bar to enable it only on some devices.",
        },
      ),
      select(
        "_stickyScope",
        "Scope",
        [
          { value: "", label: "Whole page" },
          { value: "section", label: "Only within its section" },
        ],
        {
          group: "style",
          condition: { _sticky: ["top", "bottom"] },
          // No cssTemplate: the "page" scope is handled by the runtime JS
          // (position:fixed past the threshold), the "section" scope is native
          // CSS sticky, already emitted by the _sticky control.
          description:
            "With \"Whole page\" the element stays fixed even after its section has scrolled away. With \"Only within its section\" it stays fixed while the section is on screen, then scrolls away with it.",
        },
      ),
      slider("_stickyTop", "Offset from top", "{{WRAPPER}}", "top", {
        units: ["px", "rem", "vh"],
        max: 400,
        condition: { _sticky: "top" },
      }),
      slider("_stickyBottom", "Offset from bottom", "{{WRAPPER}}", "bottom", {
        units: ["px", "rem", "vh"],
        max: 400,
        condition: { _sticky: "bottom" },
      }),
    ],
  },
  {
    id: "adv_background",
    label: "Background",
    tab: "advanced",
    controls: [
      color("_bgColor", "Background color", "{{WRAPPER}}", "background-color", {
        states: ["normal", "hover"],
      }),
      gradient("_bgGradient", "Background gradient", "{{WRAPPER}}", {
        responsive: true,
        description:
          "Two-color gradient (linear or radial). When set it covers the background image.",
      }),
      media("_bgImage", "Background image", {
        group: "style",
        responsive: true,
        description:
          "You can upload a different one for tablet and mobile: switch device in the top bar and pick the image. Left empty, the one of the larger device applies.",
      }),
      select(
        "_bgSize",
        "Background size",
        [
          { value: "cover", label: "Cover" },
          { value: "contain", label: "Contain" },
          { value: "auto", label: "Auto" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "background-size: {{VALUE}}",
          condition: { "_bgImage!": "" },
          responsive: true,
        },
      ),
      select(
        "_bgPosition",
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
          selector: "{{WRAPPER}}",
          cssTemplate: "background-position: {{VALUE}}",
          condition: { "_bgImage!": "" },
          responsive: true,
        },
      ),
      select(
        "_bgRepeat",
        "Background repeat",
        [
          { value: "no-repeat", label: "None" },
          { value: "repeat", label: "Repeat" },
          { value: "repeat-x", label: "Repeat horizontally" },
          { value: "repeat-y", label: "Repeat vertically" },
          { value: "space", label: "Distribute (space)" },
          { value: "round", label: "Fit (round)" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "background-repeat: {{VALUE}}",
          condition: { "_bgImage!": "" },
          responsive: true,
        },
      ),
      select(
        "_bgAttachment",
        "Background attachment",
        [
          { value: "scroll", label: "Scroll (default)" },
          { value: "fixed", label: "Fixed (parallax effect)" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "background-attachment: {{VALUE}}",
          condition: { "_bgImage!": "" },
          responsive: true,
          description:
            "Fixed: the image stays still while the page scrolls. Note: Safari on iPhone/iPad ignores fixed (browser limitation).",
        },
      ),
    ],
  },
  {
    id: "adv_border",
    label: "Border",
    tab: "advanced",
    controls: [
      select(
        "_borderStyle",
        "Border style",
        [
          { value: "none", label: "None" },
          { value: "solid", label: "Solid" },
          { value: "dashed", label: "Dashed" },
          { value: "dotted", label: "Dotted" },
        ],
        {
          group: "style",
          selector: "{{WRAPPER}}",
          cssTemplate: "border-style: {{VALUE}}",
        },
      ),
      slider("_borderWidth", "Border width", "{{WRAPPER}}", "border-width", {
        max: 40,
        units: ["px"],
        condition: { "_borderStyle!": "none" },
      }),
      // Independent width per side: when filled it wins over the uniform width
      // above (sides left empty are 0, e.g. bottom border only). Emitted AFTER
      // the slider, so in the same rule the per-side declaration prevails.
      dimensions("_borderWidthSides", "Width per side", "{{WRAPPER}}", "border-width", {
        units: ["px"],
        responsive: true,
        // After the uniform width (default 10) regardless of the order in which
        // the user touched the two controls: in the same CSS rule the last
        // declaration wins.
        cssOrder: 11,
        condition: { "_borderStyle!": "none" },
        description:
          "Top / right / bottom / left. Setting even a single side makes this control replace the uniform width (empty sides = 0).",
      }),
      color("_borderColor", "Border color", "{{WRAPPER}}", "border-color", {
        condition: { "_borderStyle!": "none" },
      }),
      dimensions("_borderRadius", "Border radius", "{{WRAPPER}}", "border-radius"),
      boxShadow("_boxShadow", "Shadow", "{{WRAPPER}}"),
    ],
  },
  {
    id: "adv_responsive",
    label: "Responsive",
    tab: "advanced",
    controls: [
      switcher("_hideDesktop", "Hide on desktop"),
      switcher("_hideTablet", "Hide on tablet"),
      switcher("_hideMobile", "Hide on mobile"),
    ],
  },
  {
    id: "adv_custom",
    label: "Attributes and CSS",
    tab: "advanced",
    controls: [
      text("_cssId", "CSS ID", { placeholder: "e.g. contacts" }),
      text("_cssClasses", "CSS classes", { placeholder: "e.g. promo highlight" }),
      codeControl("_customCss", "Custom CSS", {
        description:
          "Use selector for the element. Write complete rules, e.g. selector { color: red }. Note: in the button the label is wrapped in .b-btn__label, so selector span hits the whole text — for the highlighted parts only use selector .b-btn__label span.",
      }),
    ],
  },
];
