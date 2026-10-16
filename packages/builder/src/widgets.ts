import { BREAKPOINT_MAXWIDTH, responsiveSettingKey } from "./schema";
import { esc, mediaUrl, safeUrl } from "./css";
import { sanitizeInlineHtml } from "./inline-html";
import { icon, socialIcon } from "./icons";

type S = Record<string, unknown>;

/** Native amable embeds a page needs the script of (added once per page). */
export type EmbedKind = "forms" | "booking";

/** Per-render state shared by the widget renderers. */
export interface WidgetContext {
  /** Editor canvas: native embeds render as labelled placeholders. */
  editable: boolean;
  /** Tenant slug written in the forms/booking embed markup. */
  tenantSlug: string;
  /** Landing page id, forwarded to the forms widget for attribution. */
  pageId: string | null;
  /** Resolves a media control value to the URL to emit. */
  media: (value: unknown) => string;
  /** Collected while rendering: which embed scripts the page must load. */
  embeds: Set<EmbedKind>;
}

export function defaultWidgetContext(): WidgetContext {
  return { editable: false, tenantSlug: "", pageId: null, media: mediaUrl, embeds: new Set() };
}

/** Uploaded PNG/SVG wins over the library icon, sized to 1em like the SVGs. */
function iconOrImage(ctx: WidgetContext, s: S): string {
  const src = ctx.media(s.image);
  if (src) return `<img class="b-icon__img" src="${esc(src)}" alt="" loading="lazy"/>`;
  return icon(s.icon) || icon("star");
}

/**
 * `<img>` for a responsive media setting. When the author picked a different
 * file for tablet/mobile the tag becomes a `<picture>`: the browser downloads
 * only the first `<source>` that matches, so sources go narrowest first.
 * Without overrides the markup is the plain `<img>` it has always been.
 */
function imgHtml(
  ctx: WidgetContext,
  s: S,
  key: string,
  o: { alt?: string; cls?: string; lazy?: boolean } = {},
): string {
  const src = ctx.media(s[key]);
  if (!src) return "";
  const cls = o.cls ? ` class="${o.cls}"` : "";
  const lazy = o.lazy === false ? "" : ' loading="lazy"';
  const img = `<img${cls} src="${esc(src)}" alt="${esc(o.alt ?? "")}"${lazy}/>`;

  const sources = (["mobilesm", "mobile", "tablet", "laptop"] as const)
    .map((bp) => ({ bp, url: ctx.media(s[responsiveSettingKey(key, bp)]) }))
    .filter(({ url }) => url && url !== src)
    .map(
      ({ bp, url }) =>
        `<source media="(max-width:${BREAKPOINT_MAXWIDTH[bp]}px)" srcset="${esc(url)}"/>`,
    )
    .join("");

  return sources ? `<picture>${sources}${img}</picture>` : img;
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);

const arr = (v: unknown): S[] => (Array.isArray(v) ? (v as S[]) : []);

/** Build href + target/rel attributes from a url control value. */
function linkAttrs(link: unknown): string {
  let urlStr = "";
  let target = "";
  let nofollow = false;
  if (typeof link === "string") urlStr = link;
  else if (link && typeof link === "object") {
    const l = link as S;
    urlStr = str(l.url);
    target = str(l.target);
    nofollow = l.nofollow === "yes" || l.nofollow === true;
  }
  urlStr = safeUrl(urlStr);
  if (!urlStr) return "";
  const rel = [nofollow ? "nofollow" : "", target === "_blank" ? "noopener" : ""]
    .filter(Boolean)
    .join(" ");
  return `href="${esc(urlStr)}"${target ? ` target="${esc(target)}"` : ""}${
    rel ? ` rel="${esc(rel)}"` : ""
  }`;
}

function hasLink(link: unknown): boolean {
  if (typeof link === "string") return !!link;
  return !!(link && typeof link === "object" && str((link as S).url));
}

/** When a widget's click action opens a popup, the `data-b-open-popup` attr. */
function openPopupAttr(s: S): string {
  return str(s.action) === "open_popup" && str(s.popupId)
    ? ` data-b-open-popup="${esc(str(s.popupId))}"`
    : "";
}
function opensPopup(s: S): boolean {
  return str(s.action) === "open_popup" && !!str(s.popupId);
}

const ASPECT: Record<string, string> = {
  "169": "16/9",
  "43": "4/3",
  "11": "1/1",
  "219": "21/9",
};

function youtubeId(u: string): string {
  const m = u.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{6,})/);
  return m?.[1] ?? "";
}
function vimeoId(u: string): string {
  const m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return m?.[1] ?? "";
}

const BURGER_ICON =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>';
const BURGER_CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const render: Record<string, (s: S, ctx: WidgetContext) => string> = {
  "nav-menu"(s, ctx) {
    const collapse = ["tablet", "never"].includes(str(s.collapse)) ? str(s.collapse) : "mobile";
    const logoInner =
      imgHtml(ctx, s, "logo", { alt: str(s.logoText, "Logo"), lazy: false }) ||
      (str(s.logoText)
        ? `<span class="b-nav__logotext">${esc(str(s.logoText))}</span>`
        : "");
    const logo = logoInner
      ? hasLink(s.logoLink)
        ? `<a class="b-nav__logo" ${linkAttrs(s.logoLink)}>${logoInner}</a>`
        : `<span class="b-nav__logo">${logoInner}</span>`
      : "";
    const items = arr(s.items)
      .map((it) => {
        const label = esc(str(it.label, "Item"));
        const attrs = hasLink(it.link) ? linkAttrs(it.link) : 'href="#"';
        return `<a class="b-nav__item" ${attrs}>${label}</a>`;
      })
      .join("");
    const cta = str(s.ctaText)
      ? `<a class="b-nav__cta" ${hasLink(s.ctaLink) ? linkAttrs(s.ctaLink) : 'href="#"'}>${esc(str(s.ctaText))}</a>`
      : "";
    const burger =
      collapse === "never"
        ? ""
        : `<button type="button" class="b-nav__burger" aria-label="Open menu" aria-expanded="false"><span class="b-nav__burger-open">${BURGER_ICON}</span><span class="b-nav__burger-close">${BURGER_CLOSE_ICON}</span></button>`;
    return `<nav class="b-nav b-nav--collapse-${collapse}">${logo}<div class="b-nav__items">${items}${cta}</div>${burger}</nav>`;
  },

  anchor(s) {
    const id = str(s.anchorId).trim().replace(/^#/, "");
    return `<span class="b-anchor"${id ? ` id="${esc(id)}"` : ""} data-b-anchor="${esc(id)}"></span>`;
  },

  heading(s) {
    const tag = /^(h[1-6]|div|span|p)$/.test(str(s.htmlTag)) ? str(s.htmlTag) : "h2";
    const inner = sanitizeInlineHtml(str(s.title, "Title"));
    const el = `<${tag} class="b-heading">${inner}</${tag}>`;
    return hasLink(s.link) ? `<a ${linkAttrs(s.link)}>${el}</a>` : el;
  },

  text(s) {
    return `<div class="b-text">${str(s.editor)}</div>`;
  },

  button(s) {
    const size = ["sm", "md", "lg"].includes(str(s.size)) ? str(s.size) : "md";
    const ic = icon(s.icon);
    const iconLeft = ic && str(s.iconAlign) !== "right" ? `<span class="b-btn__icon">${ic}</span>` : "";
    const iconRight = ic && str(s.iconAlign) === "right" ? `<span class="b-btn__icon">${ic}</span>` : "";
    const label = sanitizeInlineHtml(str(s.text, "Button"));
    // The wrapper keeps the label as a single inline block: without it the
    // author's spans would become separate flex items (gaps between words)
    // and <br> would not work.
    const inner = `${iconLeft}<span class="b-btn__label">${label}</span>${iconRight}`;
    if (opensPopup(s)) {
      return `<button type="button" class="b-btn b-btn--${size}"${openPopupAttr(s)}>${inner}</button>`;
    }
    const attrs = hasLink(s.link) ? linkAttrs(s.link) : 'href="#"';
    return `<a class="b-btn b-btn--${size}" ${attrs}>${inner}</a>`;
  },

  image(s, ctx) {
    const img =
      imgHtml(ctx, s, "image", { alt: str(s.alt) }) || `<div class="b-image__ph">Image</div>`;
    const linked = opensPopup(s)
      ? `<a class="b-image__link" href="#"${openPopupAttr(s)}>${img}</a>`
      : hasLink(s.link)
        ? `<a ${linkAttrs(s.link)}>${img}</a>`
        : img;
    const cap = str(s.caption) ? `<figcaption class="b-image__cap">${esc(str(s.caption))}</figcaption>` : "";
    return `<figure class="b-image">${linked}${cap}</figure>`;
  },

  icon(s, ctx) {
    const view = ["stacked", "framed"].includes(str(s.view)) ? str(s.view) : "default";
    const el = `<span class="b-icon b-icon--${view}">${iconOrImage(ctx, s)}</span>`;
    return hasLink(s.link) ? `<a ${linkAttrs(s.link)}>${el}</a>` : el;
  },

  "icon-box"(s, ctx) {
    const pos = ["left", "right"].includes(str(s.position)) ? str(s.position) : "top";
    const tag = /^(h[1-6]|div|span|p)$/.test(str(s.titleTag)) ? str(s.titleTag) : "h3";
    const svg = iconOrImage(ctx, s);
    const body = `<div class="b-iconbox__body"><${tag} class="b-iconbox__title">${esc(
      str(s.title, "Title"),
    )}</${tag}><p class="b-iconbox__desc">${esc(str(s.description))}</p></div>`;
    const inner = `<div class="b-iconbox b-iconbox--${pos}"><div class="b-iconbox__icon">${svg}</div>${body}</div>`;
    return hasLink(s.link) ? `<a class="b-iconbox__link" ${linkAttrs(s.link)}>${inner}</a>` : inner;
  },

  "image-box"(s, ctx) {
    const tag = /^(h[1-6]|div|span|p)$/.test(str(s.titleTag)) ? str(s.titleTag) : "h3";
    const boxImg = imgHtml(ctx, s, "image", { alt: str(s.title) });
    const img = boxImg ? `<div class="b-imagebox__img">${boxImg}</div>` : "";
    const inner = `<div class="b-imagebox">${img}<div class="b-imagebox__body"><${tag} class="b-imagebox__title">${esc(
      str(s.title, "Title"),
    )}</${tag}><p class="b-imagebox__desc">${esc(str(s.description))}</p></div></div>`;
    return hasLink(s.link) ? `<a class="b-imagebox__link" ${linkAttrs(s.link)}>${inner}</a>` : inner;
  },

  video(s, ctx) {
    const type = str(s.videoType, "youtube");
    const u = str(s.url);
    const ratio = ASPECT[str(s.aspectRatio)] ?? "16/9";
    const autoplay = s.autoplay === "yes";
    const controls = s.controls !== "" && s.controls !== "no";
    let media = "";
    if (type === "youtube") {
      const id = youtubeId(u);
      const params = `rel=0${autoplay ? "&autoplay=1&mute=1" : ""}${controls ? "" : "&controls=0"}`;
      media = id
        ? `<iframe src="https://www.youtube.com/embed/${esc(id)}?${params}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`
        : "";
    } else if (type === "vimeo") {
      const id = vimeoId(u);
      media = id
        ? `<iframe src="https://player.vimeo.com/video/${esc(id)}${autoplay ? "?autoplay=1&muted=1" : ""}" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>`
        : "";
    } else {
      const fileUrl = ctx.media(s.videoFile) || u;
      media = fileUrl
        ? `<video src="${esc(fileUrl)}"${controls ? " controls" : ""}${autoplay ? " autoplay muted loop playsinline" : ""}></video>`
        : "";
    }
    return `<div class="b-video" style="aspect-ratio:${ratio}">${media}</div>`;
  },

  divider(s) {
    const style = ["dashed", "dotted", "double"].includes(str(s.dividerStyle))
      ? str(s.dividerStyle)
      : "solid";
    return `<div class="b-divider" style="border-top-style:${style}"></div>`;
  },

  spacer() {
    return `<div class="b-spacer"></div>`;
  },

  "icon-list"(s, ctx) {
    const items = arr(s.items)
      .map((it) => {
        // An uploaded image (PNG/SVG from media) replaces the library icon;
        // icon="none" = item without icon (text only, aligned).
        const imgUrl = ctx.media(it.image);
        const noIcon = str(it.icon) === "none" && !imgUrl;
        const visual = imgUrl
          ? `<img src="${esc(imgUrl)}" alt="" loading="lazy"/>`
          : noIcon
            ? ""
            : icon(it.icon) || icon("check");
        // Per-item color: inline on the span (library icons use currentColor);
        // wins over the general color set in Style.
        const itemColor = str(it.color).trim();
        const colorAttr = itemColor ? ` style="color:${esc(itemColor)}"` : "";
        const text = `<span class="b-iconlist__text">${esc(str(it.text))}</span>`;
        const body = `${visual ? `<span class="b-iconlist__icon"${colorAttr}>${visual}</span>` : ""}${text}`;
        return `<li class="b-iconlist__item">${
          hasLink(it.link) ? `<a ${linkAttrs(it.link)}>${body}</a>` : body
        }</li>`;
      })
      .join("");
    return `<ul class="b-iconlist">${items}</ul>`;
  },

  counter(s) {
    const end = str(s.end, "0");
    const start = str(s.start, "0");
    const dur = str(s.duration, "2000");
    const num = `<span class="b-counter__num" data-to="${esc(end)}" data-from="${esc(
      start,
    )}" data-dur="${esc(dur)}">${esc(str(s.prefix))}${esc(start)}${esc(str(s.suffix))}</span>`;
    const title = str(s.title) ? `<span class="b-counter__title">${esc(str(s.title))}</span>` : "";
    return `<div class="b-counter" data-prefix="${esc(str(s.prefix))}" data-suffix="${esc(
      str(s.suffix),
    )}">${num}${title}</div>`;
  },

  progress(s) {
    const pctRaw = Number(s.percent);
    const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 50;
    const title = str(s.title) ? `<div class="b-progress__title">${esc(str(s.title))}</div>` : "";
    const label = s.showPercent === "yes" ? `<span class="b-progress__label">${pct}%</span>` : "";
    return `${title}<div class="b-progress"><div class="b-progress__bar" style="width:${pct}%">${label}</div></div>`;
  },

  "star-rating"(s) {
    const scale = str(s.scale) === "10" ? 10 : 5;
    const val = Math.max(0, Math.min(scale, Number(s.rating) || 0));
    const title = str(s.title) ? `<div class="b-rating__title">${esc(str(s.title))}</div>` : "";
    const stars = Array.from({ length: scale }, (_, i) => {
      const on = i < Math.round(val) ? " is-on" : "";
      return `<span class="b-rating__star${on}">${icon("star")}</span>`;
    }).join("");
    return `${title}<div class="b-rating">${stars}</div>`;
  },

  testimonial(s, ctx) {
    const img = imgHtml(ctx, s, "image", {
      alt: str(s.name),
      cls: "b-testimonial__img",
      lazy: false,
    });
    return `<div class="b-testimonial"><div class="b-testimonial__content">${esc(
      str(s.content),
    )}</div><div class="b-testimonial__meta">${img}<div><div class="b-testimonial__name">${esc(
      str(s.name),
    )}</div><div class="b-testimonial__role">${esc(str(s.role))}</div></div></div></div>`;
  },

  tabs(s) {
    const items = arr(s.items);
    const nav = items
      .map(
        (it, i) =>
          `<button type="button" class="b-tabs__tab${i === 0 ? " is-active" : ""}" data-tab="${i}">${esc(
            str(it.title, `Tab ${i + 1}`),
          )}</button>`,
      )
      .join("");
    const panels = items
      .map(
        (it, i) =>
          `<div class="b-tabs__panel${i === 0 ? " is-active" : ""}" data-panel="${i}">${str(
            it.content,
          )}</div>`,
      )
      .join("");
    return `<div class="b-tabs"><div class="b-tabs__nav">${nav}</div><div class="b-tabs__panels">${panels}</div></div>`;
  },

  accordion(s) {
    const items = arr(s.items)
      .map(
        (it, i) =>
          `<details class="b-accordion__item"${i === 0 ? " open" : ""}><summary class="b-accordion__title">${esc(
            str(it.title, "Item"),
          )}<span class="b-accordion__chevron">${icon("chevron-down")}</span></summary><div class="b-accordion__content">${str(
            it.content,
          )}</div></details>`,
      )
      .join("");
    return `<div class="b-accordion">${items}</div>`;
  },

  "social-icons"(s) {
    const items = arr(s.items)
      .map((it) => {
        const net = str(it.network, "facebook");
        return `<a class="b-social__link b-social__link--${esc(net)}" ${
          hasLink(it.link) ? linkAttrs(it.link) : 'href="#"'
        } aria-label="${esc(net)}">${socialIcon(net)}</a>`;
      })
      .join("");
    return `<div class="b-social">${items}</div>`;
  },

  alert(s) {
    const type = ["success", "warning", "danger"].includes(str(s.alertType))
      ? str(s.alertType)
      : "info";
    return `<div class="b-alert b-alert--${type}"><div class="b-alert__title">${esc(
      str(s.title, "Alert"),
    )}</div><div class="b-alert__desc">${esc(str(s.description))}</div></div>`;
  },

  html(s) {
    return str(s.html);
  },

  "image-gallery"(s, ctx) {
    const cols = str(s.columns, "3");
    const imgs = arr(s.items)
      .map((it) => {
        const src = ctx.media(it.image);
        return src ? `<img src="${esc(src)}" alt="${esc(str(it.alt))}" loading="lazy"/>` : "";
      })
      .join("");
    return `<div class="b-gallery" style="grid-template-columns:repeat(${esc(
      cols,
    )},minmax(0,1fr))">${imgs}</div>`;
  },

  "image-carousel"(s, ctx) {
    const per = str(s.slidesToShow, "3");
    const imgs = arr(s.items)
      .map((it) => {
        const src = ctx.media(it.image);
        return src
          ? `<div class="b-carousel__slide"><img src="${esc(src)}" alt="${esc(
              str(it.alt),
            )}" loading="lazy"/></div>`
          : "";
      })
      .join("");
    return `<div class="b-carousel" style="--b-per:${esc(per)}"${
      s.autoplay === "yes" ? ' data-autoplay="1"' : ""
    }>${imgs}</div>`;
  },

  "google-maps"(s) {
    const q = encodeURIComponent(str(s.address, "Rome, Italy"));
    const zoom = Number(s.zoom) || 12;
    const key = str(s.apiKey).trim();
    const src = key
      ? `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${q}&zoom=${zoom}`
      : `https://www.google.com/maps?q=${q}&z=${zoom}&output=embed`;
    return `<iframe class="b-map" src="${src}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>`;
  },

  form(s, ctx) {
    const id = str(s.formId).trim();
    if (!id) return `<div class="b-form-ph">Select a form</div>`;
    if (ctx.editable) return `<div class="b-form-ph" data-b-embed-ph="form">Form: ${esc(id)}</div>`;
    ctx.embeds.add("forms");
    return `<div data-amable-form="${esc(id)}" data-amable-tenant="${esc(ctx.tenantSlug)}"${pageAttr(ctx)}></div>`;
  },

  booking(s, ctx) {
    const slug = str(s.eventSlug).trim();
    if (!slug) return `<div class="b-form-ph">Select an event type</div>`;
    if (ctx.editable) return `<div class="b-form-ph" data-b-embed-ph="booking">Booking: ${esc(slug)}</div>`;
    ctx.embeds.add("booking");
    return `<div data-amable-booking="${esc(slug)}" data-amable-tenant="${esc(ctx.tenantSlug)}"${pageAttr(ctx)}></div>`;
  },
};

function pageAttr(ctx: WidgetContext): string {
  return ctx.pageId ? ` data-amable-page="${esc(ctx.pageId)}"` : "";
}

/** Render a leaf widget's inner HTML from its settings. Unknown types render "". */
export function renderWidgetInner(type: string, settings: S, ctx: WidgetContext = defaultWidgetContext()): string {
  const fn = render[type];
  return fn ? fn(settings, ctx) : "";
}

/** Widget types that have an HTML renderer. */
export const WIDGET_HTML_TYPES = Object.keys(render);
