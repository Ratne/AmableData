import {
  type BuilderDocument,
  type ElementNode,
  tokensToCss,
  tokenFontFamilies,
  shapeDividerById,
  sanitizeSvgShape,
  canonicalFontFamily,
} from "./schema";
import { esc, wrapperClass, buildNodeCss, cssForStyleTag, mediaResolver, safeUrl } from "./css";
import { renderWidgetInner, type EmbedKind, type WidgetContext } from "./widgets";

/** "Hamburger" rules of the nav menu below the chosen collapse breakpoint. */
function navCollapsedCss(collapse: "mobile" | "tablet", maxWidth: number): string {
  const n = `.b-nav--collapse-${collapse}`;
  return `@media(max-width:${maxWidth}px){
${n} .b-nav__burger{display:inline-flex}
${n} .b-nav__items{display:none;position:absolute;top:100%;left:0;right:0;z-index:1000;flex-direction:column;align-items:stretch;gap:0;background:var(--b-color-background,#fff);color:var(--b-color-text,#334155);border-radius:var(--b-radius);box-shadow:0 12px 32px rgba(0,0,0,.18);padding:8px;margin-left:0}
${n}.is-open .b-nav__items{display:flex}
${n} .b-nav__item{padding:12px 14px;border-radius:calc(var(--b-radius) - 2px);white-space:normal}
${n} .b-nav__item:hover{background:var(--b-color-muted,#f1f5f9)}
${n} .b-nav__cta{margin:8px 14px 6px;justify-content:center}
}`;
}

export const BASE_CSS = `
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:var(--b-font-body,Inter),system-ui,sans-serif;background:var(--b-color-background,#fff);color:var(--b-color-text,#334155);line-height:1.6;-webkit-font-smoothing:antialiased}
/* Defense against third-party embeds (e.g. video players) injecting global
   styles into the host page: body{overflow-x:hidden;height:100%} breaks
   position:sticky, html{font-size:62.5%} rescales every rem unit,
   body{font-size:1.6rem;...} alters the texts. overflow-x:clip cuts the
   horizontal overflow WITHOUT creating a scroll container, so sticky keeps
   working. */
html{font-size:100% !important}
body{overflow-x:clip !important;height:auto !important;margin:0 !important;padding:0 !important;font-size:16px !important;font-weight:400 !important}
img{max-width:100%;display:block}
a{color:inherit}
h1,h2,h3,h4,h5,h6{font-family:var(--b-font-heading,Poppins),system-ui,sans-serif;color:var(--b-color-heading,#0f172a);line-height:1.2;margin:0}
.b-el{min-width:0}
/* container */
/* relative: anchors absolutely positioned children (Advanced > Position) */
.b-container{display:flex;flex-direction:column;gap:16px;padding:20px;position:relative}
.b-container--grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
.b-container--boxed{max-width:var(--b-container,1140px);margin-inline:auto;width:100%}
.b-container--full{width:100%}
/* Background overlay: ::before layer above the background and below the
   content. The content is lifted ONLY with position:relative (no z-index, no
   isolation): positioned elements paint in tree order, so ::before (first in
   the subtree) sits below the children, and the "sandwich" across sections
   stays possible. :where() = zero specificity, per-node styles win. */
.b-has-overlay::before{content:"";position:absolute;inset:0;z-index:0;pointer-events:none;border-radius:inherit}
:where(.b-has-overlay)>*{position:relative}
/* shape divider */
.b-has-shape{position:relative;isolation:isolate}
.b-shape{position:absolute;left:0;right:0;overflow:hidden;line-height:0;pointer-events:none;z-index:-1}
.b-shape--top{top:-1px}
.b-shape--bottom{bottom:-1px}
.b-shape--front{z-index:2}
.b-shape svg{width:calc(100% + 1.3px);height:100%;display:block}
/* heading / text */
.b-heading{font-size:2rem}
.b-text{color:inherit}
.b-text :first-child{margin-top:0}.b-text :last-child{margin-bottom:0}
.b-text a{color:var(--b-color-primary);text-decoration:underline}
/* button */
.b-btn{display:inline-flex;align-items:center;gap:.5em;text-decoration:none;font-weight:600;border-radius:var(--b-radius);background:var(--b-color-primary);color:#fff;border:0;cursor:pointer;transition:transform .15s,box-shadow .15s;line-height:1}
.b-btn:hover{transform:translateY(-1px)}
.b-btn--sm{padding:8px 16px;font-size:.9rem}
.b-btn--md{padding:12px 24px;font-size:1rem}
.b-btn--lg{padding:16px 32px;font-size:1.1rem}
.b-btn__icon{display:inline-flex}
/* The Width control (Advanced) writes on the widget wrapper: the inner
   button INHERITS it, otherwise 100%/100vw/300px would only widen the
   invisible div. With auto width (default) inherit changes nothing.
   :where() keeps specificity low so per-node styles always win. */
.b-widget-button>:where(.b-btn){width:inherit;max-width:100%;justify-content:center}
.b-svg{width:1em;height:1em;display:inline-block}
/* image */
/* picture only picks the source per resolution: it must not create a box
   that alters flex/grid or the percentages of the image inside. */
picture{display:contents}
.b-image{margin:0}
.b-image img{border-radius:var(--b-radius)}
.b-image__ph{background:var(--b-color-muted);border-radius:var(--b-radius);aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:var(--b-color-text);opacity:.6}
.b-image__cap{font-size:.85rem;opacity:.7;margin-top:8px;text-align:center}
/* icon */
.b-icon{display:inline-flex;font-size:2.5rem;color:var(--b-color-primary);line-height:1}
.b-icon--stacked{background:var(--b-color-primary);color:#fff;padding:.5em;border-radius:var(--b-radius)}
.b-icon--framed{border:2px solid currentColor;padding:.5em;border-radius:var(--b-radius)}
/* icon-box */
.b-iconbox{display:flex;gap:16px}
.b-iconbox--top{flex-direction:column;align-items:center;text-align:center}
.b-iconbox--right{flex-direction:row-reverse}
.b-iconbox__icon{font-size:2.5rem;color:var(--b-color-primary);display:inline-flex;flex:none}
.b-iconbox__icon .b-svg{width:1em;height:1em}
.b-icon__img{width:1em;height:1em;object-fit:contain;display:block}
.b-iconbox__title{font-size:1.25rem;margin:0 0 6px}
.b-iconbox__desc{margin:0;opacity:.8}
.b-iconbox__link{text-decoration:none;color:inherit}
/* image-box */
.b-imagebox{text-align:center}
.b-imagebox__img{margin-bottom:16px}
.b-imagebox__img img{border-radius:var(--b-radius);width:100%}
.b-imagebox__title{font-size:1.25rem;margin:0 0 6px}
.b-imagebox__desc{margin:0;opacity:.8}
.b-imagebox__link{text-decoration:none;color:inherit}
/* video */
/* The video block always takes the available width: otherwise, in a
   container centering its items, the wrapper would shrink to its content and
   the player collapse to zero. Center it with "Max width" + "Alignment". */
.b-widget-video{width:100%}
.b-video{position:relative;width:100%;overflow:hidden;border-radius:var(--b-radius);background:#000}
.b-video iframe,.b-video video{position:absolute;inset:0;width:100%;height:100%;border:0;object-fit:cover}
/* divider */
.b-divider{border-top:1px solid var(--b-color-border);width:100%;margin:0 auto}
/* spacer */
.b-spacer{height:50px}
/* icon-list */
.b-iconlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.b-iconlist__item a{display:flex;text-decoration:none;color:inherit}
.b-iconlist__item{display:flex;align-items:center;gap:10px}
.b-iconlist__icon{color:var(--b-color-primary);display:inline-flex}
.b-iconlist__icon img{width:1.25em;height:1.25em;object-fit:contain;display:block}
/* counter */
.b-counter{text-align:center}
.b-counter__num{font-family:var(--b-font-heading);font-size:3rem;font-weight:700;color:var(--b-color-primary);display:block}
.b-counter__title{opacity:.8}
/* progress */
.b-progress__title{margin-bottom:6px;font-weight:600}
.b-progress{background:var(--b-color-muted);border-radius:999px;height:20px;overflow:hidden}
.b-progress__bar{height:100%;background:var(--b-color-primary);color:#fff;font-size:.75rem;display:flex;align-items:center;justify-content:flex-end;padding-right:8px;border-radius:999px;transition:width .6s}
/* rating */
.b-rating{display:inline-flex;gap:4px;font-size:1.5rem;color:var(--b-color-border)}
.b-rating__title{margin-bottom:6px}
.b-rating__star.is-on{color:var(--b-color-accent)}
/* testimonial */
.b-testimonial{background:var(--b-color-background);border:1px solid var(--b-color-border);border-radius:var(--b-radius-lg);padding:28px}
.b-testimonial__content{font-size:1.1rem;font-style:italic;margin-bottom:16px}
.b-testimonial__meta{display:flex;align-items:center;gap:12px}
.b-testimonial__img{width:52px;height:52px;border-radius:999px;object-fit:cover}
.b-testimonial__name{font-weight:600}
.b-testimonial__role{opacity:.7;font-size:.9rem}
/* tabs */
.b-tabs__nav{display:flex;gap:4px;border-bottom:1px solid var(--b-color-border);flex-wrap:wrap}
.b-tabs__tab{background:none;border:0;padding:12px 18px;cursor:pointer;font:inherit;color:var(--b-color-text);border-bottom:2px solid transparent;margin-bottom:-1px}
.b-tabs__tab.is-active{color:var(--b-color-primary);border-bottom-color:var(--b-color-primary);font-weight:600}
.b-tabs__panel{display:none;padding:20px 0}
.b-tabs__panel.is-active{display:block}
/* accordion */
.b-accordion{display:flex;flex-direction:column}
.b-accordion__item{border-bottom:1px solid var(--b-color-border)}
.b-accordion__title{cursor:pointer;padding:16px 0;font-weight:600;display:flex;justify-content:space-between;align-items:center;list-style:none}
.b-accordion__title::-webkit-details-marker{display:none}
.b-accordion__chevron{transition:transform .2s;display:inline-flex}
.b-accordion__item[open] .b-accordion__chevron{transform:rotate(180deg)}
.b-accordion__content{padding:0 0 16px;opacity:.85}
/* social */
.b-social{display:flex;gap:10px;flex-wrap:wrap}
.b-social__link{width:2.4em;height:2.4em;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--b-radius);background:var(--b-color-primary);color:#fff;font-size:1rem;text-decoration:none}
/* alert */
.b-alert{border-radius:var(--b-radius);padding:16px 20px;border-left:4px solid}
.b-alert--info{background:#eff6ff;border-color:#3b82f6}
.b-alert--success{background:#ecfdf5;border-color:#10b981}
.b-alert--warning{background:#fffbeb;border-color:#f59e0b}
.b-alert--danger{background:#fef2f2;border-color:#ef4444}
.b-alert__title{font-weight:700;margin-bottom:4px}
.b-alert__desc{opacity:.85}
/* gallery / carousel */
.b-gallery{display:grid;gap:16px}
.b-gallery img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:var(--b-radius)}
.b-carousel{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:8px}
.b-carousel__slide{flex:0 0 calc((100% - (var(--b-per) - 1) * 16px) / var(--b-per));scroll-snap-align:start}
.b-carousel__slide img{width:100%;border-radius:var(--b-radius)}
/* map / form */
.b-map{width:100%;height:400px;border:0;border-radius:var(--b-radius)}
.b-form-ph,.b-image__ph{font-size:.9rem}
/* nav menu */
.b-nav{display:flex;align-items:center;gap:24px;width:100%;position:relative}
.b-nav__logo{display:inline-flex;align-items:center;text-decoration:none;flex:none}
.b-nav__logo img{height:40px;width:auto;display:block}
.b-nav__logotext{font-family:var(--b-font-heading);font-weight:700;font-size:1.3rem;color:var(--b-color-heading)}
.b-nav__items{display:flex;align-items:center;gap:28px;margin-left:auto}
.b-nav__item{text-decoration:none;font-weight:500;color:inherit;white-space:nowrap}
.b-nav__item:hover{color:var(--b-color-primary)}
.b-nav__cta{display:inline-flex;align-items:center;text-decoration:none;font-weight:600;background:var(--b-color-primary);color:#fff;padding:10px 22px;border-radius:var(--b-radius);white-space:nowrap}
.b-nav__burger{display:none;margin-left:auto;background:none;border:0;cursor:pointer;color:inherit;padding:6px;line-height:0}
.b-nav__burger-close{display:none}
.b-nav.is-open .b-nav__burger-open{display:none}
.b-nav.is-open .b-nav__burger-close{display:inline}
${navCollapsedCss("mobile", 767)}
${navCollapsedCss("tablet", 1024)}
/* anchor (invisible on public pages) */
.b-anchor{display:block;height:0;scroll-margin-top:80px}
/* popup */
.b-popup{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}
.b-popup[hidden]{display:none}
.b-popup__overlay{position:absolute;inset:0;background:rgba(15,23,42,.6);cursor:pointer}
.b-popup__box{position:relative;z-index:1;width:100%;max-height:90vh;overflow:auto;background:var(--b-color-background,#fff);color:var(--b-color-text,#334155);border-radius:var(--b-radius-lg,16px);padding:32px;box-shadow:0 24px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:16px}
.b-popup__box--sm{max-width:400px}
.b-popup__box--md{max-width:520px}
.b-popup__box--lg{max-width:720px}
.b-popup__box--full{max-width:960px}
.b-popup__close{position:absolute;top:10px;right:10px;width:32px;height:32px;border:0;background:transparent;color:#64748b;cursor:pointer;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;padding:0;z-index:5}
.b-popup__close:hover{background:var(--b-color-muted,#f1f5f9);color:var(--b-color-text,#334155)}
.b-popup__content{display:flex;flex-direction:column;gap:16px}
body.b-popup-open{overflow:hidden}
.b-popup--edit{position:static;display:block;z-index:auto;padding:0;inset:auto}
.b-popup--edit .b-popup__box{position:relative;max-width:none;max-height:none;min-height:60px;overflow:visible;box-shadow:none;border:2px dashed color-mix(in srgb,var(--b-color-primary,#2563eb) 60%,transparent)}
.b-popup__editlabel{display:flex;align-items:center;gap:6px;font:600 12px/1.4 system-ui;color:var(--b-color-primary,#2563eb);padding:4px 2px 8px}
@media(max-width:1024px){.b-container--grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:767px){
.b-container{padding:16px}
.b-container--grid{grid-template-columns:1fr}
.b-iconbox--left,.b-iconbox--right{flex-direction:column;align-items:center;text-align:center}
.b-heading{font-size:1.6rem}
}
`;

const EDIT_OVERLAY_CSS = `
[data-b-id]{position:relative}
[data-b-id]:hover{outline:1px dashed color-mix(in srgb,var(--b-color-primary,#2563eb) 70%,transparent);outline-offset:-1px}
[data-b-id][data-b-selected="1"]{outline:2px solid var(--b-color-primary,#2563eb);outline-offset:-2px}
[data-b-type="container"]{min-height:40px}
[data-b-type="container"]:empty::after,[data-b-container-empty]::after{content:"Empty container";display:block;text-align:center;color:#94a3b8;font:13px/1.4 system-ui;padding:24px;border:1px dashed #cbd5e1;border-radius:8px}
#b-move-handle{position:fixed;z-index:99999;height:22px;padding:0 6px;border-radius:6px;background:var(--b-color-primary,#2563eb);color:#fff;display:none;align-items:center;gap:4px;cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,.3);font:600 11px/1 system-ui}
#b-move-handle.on{display:inline-flex}
#b-move-handle:active{cursor:grabbing}
#b-delete-handle{position:fixed;z-index:99999;height:22px;padding:0 6px;border-radius:6px;background:#dc2626;color:#fff;display:none;align-items:center;gap:4px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);font:600 11px/1 system-ui;border:0}
#b-delete-handle.on{display:inline-flex}
#b-delete-handle:hover{background:#b91c1c}
@keyframes b-spin{to{transform:rotate(360deg)}}
.b-working-overlay{position:absolute;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(1px);border-radius:inherit}
.b-working-overlay.b-full{position:fixed}
.b-working-spinner{width:40px;height:40px;border-radius:999px;border:4px solid color-mix(in srgb,var(--b-color-primary,#2563eb) 25%,transparent);border-top-color:var(--b-color-primary,#2563eb);animation:b-spin .8s linear infinite}
[data-b-lockedby]{outline:2px solid #f59e0b !important;outline-offset:-2px}
/* Anchor visible (and selectable) in the editor only */
.b-widget-anchor .b-anchor{height:auto}
.b-widget-anchor .b-anchor::before{content:"⚓ " attr(data-b-anchor);display:inline-flex;align-items:center;background:#0ea5e9;color:#fff;font:600 10px/1 system-ui;padding:4px 8px;border-radius:999px;margin:2px 0}
/* Spacing overlay (padding green, margin orange) on the selected element */
.b-space{position:fixed;z-index:9996;pointer-events:none}
.b-space--pad{background:rgba(16,185,129,.18)}
.b-space--marg{background:rgba(249,115,22,.16)}
.b-space__label{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 9px/1 system-ui;color:#065f46;white-space:nowrap;overflow:hidden}
.b-space--marg .b-space__label{color:#9a3412}
.b-lock-badge{position:fixed;z-index:9998;background:#f59e0b;color:#111;font:600 10px/1 system-ui;padding:3px 8px;border-radius:999px;pointer-events:none;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.3);display:inline-flex;align-items:center;gap:4px}
/* Resize grip between adjacent columns */
.b-col-grip{position:fixed;z-index:99997;width:14px;margin-left:-7px;cursor:col-resize;display:flex;align-items:center;justify-content:center;touch-action:none}
.b-col-grip::before{content:"";width:5px;height:40px;max-height:70%;border-radius:999px;background:var(--b-color-primary,#2563eb);opacity:.4;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:opacity .15s}
.b-col-grip:hover::before,.b-col-grip.b-drag::before{opacity:1}
.b-col-label{position:fixed;z-index:99999;background:#111827;color:#fff;font:600 10px/1 system-ui;padding:4px 7px;border-radius:5px;pointer-events:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35)}
`;

/** Public runtime (nav, tabs, counters, carousel, popups, sticky). Inline, hashed by the CSP. */
export const RUNTIME_JS = `
(function(){
  // Nav menu (hamburger)
  document.addEventListener("click",function(e){
    var b=e.target.closest(".b-nav__burger");
    if(b){
      var nav=b.closest(".b-nav");
      var open=nav.classList.toggle("is-open");
      b.setAttribute("aria-expanded",open?"true":"false");
      return;
    }
    // Close the panel when an item is clicked (anchor navigation).
    var it=e.target.closest(".b-nav__item,.b-nav__cta");
    if(it){var n=it.closest(".b-nav.is-open");if(n)n.classList.remove("is-open")}
  });
  // Tabs
  document.querySelectorAll(".b-tabs").forEach(function(t){
    t.querySelectorAll(".b-tabs__tab").forEach(function(btn){
      btn.addEventListener("click",function(){
        var i=btn.getAttribute("data-tab");
        t.querySelectorAll(".b-tabs__tab").forEach(function(b){b.classList.toggle("is-active",b===btn)});
        t.querySelectorAll(".b-tabs__panel").forEach(function(p){p.classList.toggle("is-active",p.getAttribute("data-panel")===i)});
      });
    });
  });
  // Counters
  function animate(el){
    var to=parseFloat(el.getAttribute("data-to"))||0,from=parseFloat(el.getAttribute("data-from"))||0;
    var dur=parseFloat(el.getAttribute("data-dur"))||2000,t0=null;
    var box=el.closest(".b-counter")||{};var pre=box.getAttribute?box.getAttribute("data-prefix")||"":"";var suf=box.getAttribute?box.getAttribute("data-suffix")||"":"";
    function step(ts){if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/dur);var v=Math.floor(from+(to-from)*p);el.textContent=pre+v.toLocaleString(document.documentElement.lang||undefined)+suf;if(p<1)requestAnimationFrame(step)}
    requestAnimationFrame(step);
  }
  if("IntersectionObserver" in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){animate(e.target);io.unobserve(e.target)}})});
    document.querySelectorAll(".b-counter__num").forEach(function(n){io.observe(n)});
  } else { document.querySelectorAll(".b-counter__num").forEach(animate); }
  // Carousel autoplay
  document.querySelectorAll('.b-carousel[data-autoplay="1"]').forEach(function(c){
    setInterval(function(){
      var slide=c.querySelector(".b-carousel__slide");if(!slide)return;
      var w=slide.getBoundingClientRect().width+16;
      if(c.scrollLeft+c.clientWidth>=c.scrollWidth-5)c.scrollTo({left:0,behavior:"smooth"});
      else c.scrollBy({left:w,behavior:"smooth"});
    },3500);
  });
  // Popups
  (function(){
    var openCount=0;
    function lockScroll(){document.body.classList.toggle("b-popup-open",openCount>0)}
    function openPopup(p){if(!p||!p.hasAttribute("hidden"))return;p.removeAttribute("hidden");openCount++;lockScroll()}
    function closePopup(p){if(!p||p.hasAttribute("hidden"))return;p.setAttribute("hidden","");openCount=Math.max(0,openCount-1);lockScroll()}
    function esc(id){return window.CSS&&CSS.escape?CSS.escape(id):id}
    function byId(id){return document.querySelector('.b-popup[data-b-popup-id="'+esc(id)+'"]')}
    document.addEventListener("click",function(e){
      var t=e.target.closest("[data-b-open-popup]");
      if(t){e.preventDefault();var p=byId(t.getAttribute("data-b-open-popup"));if(p)openPopup(p);return}
      var c=e.target.closest("[data-b-popup-close]");
      if(c){var pp=c.closest(".b-popup");if(pp)closePopup(pp)}
    });
    document.addEventListener("keydown",function(e){
      if(e.key==="Escape")document.querySelectorAll('.b-popup[data-b-popup-id]:not([hidden])').forEach(closePopup);
    });
    function key(id){return "b-popup:"+id}
    function canAuto(p){
      var id=p.getAttribute("data-b-popup-id"),freq=p.getAttribute("data-b-frequency")||"always";
      try{
        if(freq==="once_session"){if(sessionStorage.getItem(key(id)))return false}
        else if(freq==="once_days"){var days=parseFloat(p.getAttribute("data-b-frequency-days"))||1;var last=parseFloat(localStorage.getItem(key(id))||"0");if(last&&Date.now()-last<days*864e5)return false}
      }catch(_){}
      return true;
    }
    function markAuto(p){
      var id=p.getAttribute("data-b-popup-id"),freq=p.getAttribute("data-b-frequency")||"always";
      try{
        if(freq==="once_session")sessionStorage.setItem(key(id),"1");
        else if(freq==="once_days")localStorage.setItem(key(id),String(Date.now()));
      }catch(_){}
    }
    function autoOpen(p){if(canAuto(p)){markAuto(p);openPopup(p)}}
    document.querySelectorAll(".b-popup[data-b-trigger]").forEach(function(p){
      var trig=p.getAttribute("data-b-trigger"),val=parseFloat(p.getAttribute("data-b-trigger-value"))||0;
      if(trig==="delay"){setTimeout(function(){autoOpen(p)},val>0?val:3000)}
      else if(trig==="scroll"){
        var pct=val>0?val:50,done=false;
        var onScroll=function(){
          if(done)return;
          var h=document.documentElement.scrollHeight-window.innerHeight;
          var sc=h>0?(window.scrollY/h)*100:100;
          if(sc>=pct){done=true;window.removeEventListener("scroll",onScroll);autoOpen(p)}
        };
        window.addEventListener("scroll",onScroll,{passive:true});
      }
      else if(trig==="exit_intent"){
        var fired=false;
        document.addEventListener("mouseout",function(e){
          if(fired)return;
          if(!e.relatedTarget&&e.clientY<=0){fired=true;autoOpen(p)}
        });
      }
    });
  })();
  // Whole-page sticky: native position:sticky stays bound to its container.
  // Past the threshold the element switches to position:fixed with a
  // placeholder keeping its space in the layout, so it stays fixed for the
  // whole scroll.
  (function(){
    var recs=[];
    function release(r){
      if(r.fixed){
        // The element was moved to the end of the body (see apply): put it
        // back in place of the placeholder before removing that.
        if(r.ph&&r.ph.parentNode)r.ph.parentNode.insertBefore(r.el,r.ph);
        var st=r.el.style;
        st.position="";st.top="";st.bottom="";st.left="";st.width="";st.margin="";
        r.fixed=false;
      }
      if(r.ph&&r.ph.parentNode)r.ph.parentNode.removeChild(r.ph);
      r.ph=null;
    }
    function measure(r){
      var el=r.el;
      // Natural position: without sticky active (if the page is already
      // scrolled the element might be "stuck" and skew the measure).
      var prev=el.style.position;
      el.style.position="static";
      var rect=el.getBoundingClientRect();
      el.style.position=prev;
      var cs=getComputedStyle(el);
      r.active=cs.position==="sticky";
      r.mode=cs.top!=="auto"?"top":"bottom";
      r.off=parseFloat(r.mode==="top"?cs.top:cs.bottom)||0;
      r.natTop=rect.top+window.scrollY;
      r.h=rect.height;r.w=rect.width;r.left=rect.left;
      // The placeholder also copies the margins: the total page height does
      // not change when the element leaves the flow.
      r.margin=cs.margin;
    }
    // Our own mutations, ignored by the observer: the placeholders AND the
    // sticky element itself (moved into the body on fix and back on release;
    // without this filter every move would trigger a rescan → loop).
    function ourNode(n){return !!(n&&n.getAttribute&&(n.hasAttribute("data-b-sticky-ph")||n.hasAttribute("data-b-sticky")))}
    function apply(){
      var sy=window.scrollY,vh=window.innerHeight,dirty=false;
      recs.forEach(function(r){
        if(!document.body.contains(r.el)){dirty=true;return}
        var want=r.mode==="top"?(sy+r.off>=r.natTop):(r.natTop+r.h>=sy+vh-r.off);
        if(want&&!r.fixed){
          var ph=document.createElement("div");
          ph.setAttribute("data-b-sticky-ph","");
          ph.style.height=r.h+"px";ph.style.width=r.w+"px";ph.style.flex="none";
          if(r.margin)ph.style.margin=r.margin;
          r.el.parentNode.insertBefore(ph,r.el);
          r.ph=ph;
          var st=r.el.style;
          st.position="fixed";st.left=r.left+"px";st.width=r.w+"px";st.margin="0";
          if(r.mode==="top"){st.top=r.off+"px";st.bottom="auto"}
          else{st.bottom=r.off+"px";st.top="auto"}
          // Out of the section, at the end of the body: sections with a shape
          // divider are isolation:isolate (stacking context) and a fixed element
          // left INSIDE would be covered by the following sections, z-index or
          // not. At the end of the body it paints above everything; the
          // placeholder keeps its original place.
          document.body.appendChild(r.el);
          r.fixed=true;
        }else if(!want&&r.fixed){release(r)}
      });
      if(dirty)needRescan();
    }
    function rescan(){
      recs.forEach(release);
      recs=[];
      document.querySelectorAll("[data-b-sticky]").forEach(function(el){
        if(el.closest(".b-popup"))return;
        var r={el:el,ph:null,fixed:false};
        measure(r);
        if(r.active)recs.push(r);
      });
      apply();
    }
    var raf=0;
    function onScroll(){if(!raf)raf=requestAnimationFrame(function(){raf=0;apply()})}
    var t=0;
    function needRescan(){clearTimeout(t);t=setTimeout(rescan,120)}
    window.addEventListener("scroll",onScroll,{passive:true});
    window.addEventListener("resize",needRescan);
    if(document.readyState==="complete")rescan();
    else{rescan();window.addEventListener("load",needRescan)}
    // The editor patches the DOM in place and loaded images shift the
    // layout: both require measuring again. Mutations caused by us (only
    // placeholders) are ignored.
    if("MutationObserver" in window){
      new MutationObserver(function(ms){
        for(var i=0;i<ms.length;i++){
          var m=ms[i],ours=true,j;
          for(j=0;j<m.addedNodes.length;j++)if(!ourNode(m.addedNodes[j])){ours=false;break}
          if(ours)for(j=0;j<m.removedNodes.length;j++)if(!ourNode(m.removedNodes[j])){ours=false;break}
          if(!ours){needRescan();return}
        }
      }).observe(document.body,{childList:true,subtree:true});
    }
    if("ResizeObserver" in window){
      var lastH=0;
      new ResizeObserver(function(es){
        var h=es[0]?es[0].contentRect.height:0;
        if(Math.abs(h-lastH)>1){lastH=h;needRescan()}
      }).observe(document.documentElement);
    }
  })();
})();
`;

const EDIT_OVERLAY_JS = `<script>
(function(){
  var lastSelected=null;
  document.addEventListener("click",function(e){
    var el=e.target.closest("[data-b-id]");
    if(!el)return;
    e.preventDefault();e.stopPropagation();
    parent.postMessage({source:"b-preview",type:"select",id:el.getAttribute("data-b-id")},"*");
  },true);
  document.addEventListener("contextmenu",function(e){
    var el=e.target.closest("[data-b-id]");
    if(!el)return;
    e.preventDefault();
    var r=el.getBoundingClientRect();
    parent.postMessage({source:"b-preview",type:"contextmenu",id:el.getAttribute("data-b-id"),x:e.clientX,y:e.clientY},"*");
  });
  var handle=document.createElement("div");
  handle.id="b-move-handle";
  handle.innerHTML='<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg><span>move</span>';
  document.body.appendChild(handle);
  var delHandle=document.createElement("button");
  delHandle.id="b-delete-handle";
  delHandle.type="button";
  delHandle.innerHTML='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg><span>delete</span>';
  document.body.appendChild(delHandle);
  function selectedEl(){return document.querySelector('[data-b-selected="1"]');}
  // Devtools-style spacing overlay: padding (green) and margin (orange) with values.
  var spaceBoxes=[];
  function clearSpacing(){spaceBoxes.forEach(function(n){n.remove()});spaceBoxes=[]}
  function spaceBox(kind,left,top,width,height,value){
    if(width<=0||height<=0)return;
    var d=document.createElement("div");
    d.className="b-space b-space--"+kind;
    d.style.left=left+"px";d.style.top=top+"px";d.style.width=width+"px";d.style.height=height+"px";
    if(value>=8&&Math.min(width,height)>=10){
      var l=document.createElement("span");l.className="b-space__label";l.textContent=Math.round(value);d.appendChild(l);
    }
    document.body.appendChild(d);spaceBoxes.push(d);
  }
  function renderSpacing(){
    clearSpacing();
    var el=selectedEl();if(!el)return;
    var cs=getComputedStyle(el),r=el.getBoundingClientRect();
    var pt=parseFloat(cs.paddingTop)||0,pr=parseFloat(cs.paddingRight)||0,pb=parseFloat(cs.paddingBottom)||0,pl=parseFloat(cs.paddingLeft)||0;
    var mt=parseFloat(cs.marginTop)||0,mr=parseFloat(cs.marginRight)||0,mb=parseFloat(cs.marginBottom)||0,ml=parseFloat(cs.marginLeft)||0;
    if(pt)spaceBox("pad",r.left,r.top,r.width,pt,pt);
    if(pb)spaceBox("pad",r.left,r.bottom-pb,r.width,pb,pb);
    if(pl)spaceBox("pad",r.left,r.top+pt,pl,r.height-pt-pb,pl);
    if(pr)spaceBox("pad",r.right-pr,r.top+pt,pr,r.height-pt-pb,pr);
    if(mt)spaceBox("marg",r.left,r.top-mt,r.width,mt,mt);
    if(mb)spaceBox("marg",r.left,r.bottom,r.width,mb,mb);
    if(ml)spaceBox("marg",r.left-ml,r.top,ml,r.height,ml);
    if(mr)spaceBox("marg",r.right,r.top,mr,r.height,mr);
  }
  // --- Column resize by dragging ------------------------------------------
  // When the selected node is a child of a row flex container, show a vertical
  // grip on the edge with the adjacent siblings: dragging resizes the pair in %
  // (live inline preview, commit via postMessage on release).
  var grips=[];
  var resizing=false;
  function clearGrips(){grips.forEach(function(g){g.remove()});grips=[]}
  function isRowContainer(el){
    if(!el||el.getAttribute("data-b-type")!=="container")return false;
    var cs=getComputedStyle(el);
    return cs.display==="flex"&&(cs.flexDirection==="row"||cs.flexDirection==="row-reverse");
  }
  function renderGrips(){
    if(resizing)return;
    clearGrips();
    var el=selectedEl();if(!el)return;
    var parentEl=el.parentElement?el.parentElement.closest("[data-b-id]"):null;
    if(!isRowContainer(parentEl))return;
    var kids=Array.prototype.filter.call(parentEl.children,function(k){return k.hasAttribute&&k.hasAttribute("data-b-id")});
    var idx=kids.indexOf(el);
    if(idx===-1)return;
    [[kids[idx-1],el],[el,kids[idx+1]]].forEach(function(pair){
      var a=pair[0],b=pair[1];
      if(!a||!b)return;
      var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
      if(rb.left<ra.right-1)return; // wrapped on different rows: no grip
      var g=document.createElement("div");
      g.className="b-col-grip";
      var top=Math.max(ra.top,rb.top);
      var h=Math.min(ra.bottom,rb.bottom)-top;
      if(h<24){top=Math.min(ra.top,rb.top);h=Math.max(24,Math.max(ra.bottom,rb.bottom)-top)}
      g.style.left=((ra.right+rb.left)/2)+"px";
      g.style.top=top+"px";
      g.style.height=h+"px";
      g.addEventListener("pointerdown",function(e){startColResize(e,g,a,b,parentEl)});
      document.body.appendChild(g);grips.push(g);
    });
  }
  function startColResize(e,g,a,b,parentEl){
    e.preventDefault();e.stopPropagation();
    resizing=true;
    g.classList.add("b-drag");
    try{g.setPointerCapture(e.pointerId)}catch(_){}
    var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
    var pairPx=ra.width+rb.width;      // total width of the pair (the gap is unchanged)
    var pcs=getComputedStyle(parentEl);
    var cw=parentEl.clientWidth-(parseFloat(pcs.paddingLeft)||0)-(parseFloat(pcs.paddingRight)||0);
    if(cw<=0||pairPx<=0){resizing=false;g.classList.remove("b-drag");return}
    var reversed=pcs.flexDirection==="row-reverse";
    var startX=e.clientX,startA=ra.width;
    var label=document.createElement("div");label.className="b-col-label";document.body.appendChild(label);
    var last=null;
    function apply(ev){
      var dx=ev.clientX-startX;if(reversed)dx=-dx;
      var min=Math.min(pairPx*0.05,40);
      var wa=Math.max(min,Math.min(pairPx-min,startA+dx));
      var wb=pairPx-wa;
      var pa=Math.round(wa/cw*1000)/10,pb=Math.round(wb/cw*1000)/10;
      a.style.width=pa+"%";a.style.flexGrow="0";a.style.flexShrink="0";
      b.style.width=pb+"%";b.style.flexGrow="0";b.style.flexShrink="0";
      label.textContent=pa+"% \\u2194 "+pb+"%";
      label.style.left=(ev.clientX+14)+"px";
      label.style.top=(ev.clientY-24)+"px";
      g.style.left=((a.getBoundingClientRect().right+b.getBoundingClientRect().left)/2)+"px";
      last={pa:pa,pb:pb};
    }
    apply(e);
    function onMove(ev){apply(ev)}
    function onUp(){
      g.removeEventListener("pointermove",onMove);
      g.removeEventListener("pointerup",onUp);
      g.removeEventListener("pointercancel",onUp);
      label.remove();
      g.classList.remove("b-drag");
      resizing=false;
      if(last){
        parent.postMessage({source:"b-preview",type:"resize",
          leftId:a.getAttribute("data-b-id"),rightId:b.getAttribute("data-b-id"),
          leftPct:last.pa,rightPct:last.pb},"*");
      }
      renderGrips();
    }
    g.addEventListener("pointermove",onMove);
    g.addEventListener("pointerup",onUp);
    g.addEventListener("pointercancel",onUp);
  }
  function positionHandle(){
    var el=selectedEl();
    if(!el){handle.classList.remove("on");delHandle.classList.remove("on");return;}
    var r=el.getBoundingClientRect();
    var top=Math.max(2,r.top-2);
    handle.style.left=Math.max(2,r.left)+"px";
    handle.style.top=top+"px";
    handle.classList.add("on");
    delHandle.style.left="auto";
    delHandle.style.right=Math.max(2,window.innerWidth-r.right)+"px";
    delHandle.style.top=top+"px";
    delHandle.classList.add("on");
  }
  handle.addEventListener("pointerdown",function(e){
    e.preventDefault();e.stopPropagation();
    var el=selectedEl();
    if(el)parent.postMessage({source:"b-preview",type:"startmove",id:el.getAttribute("data-b-id")},"*");
  });
  delHandle.addEventListener("pointerdown",function(e){e.preventDefault();e.stopPropagation();});
  delHandle.addEventListener("click",function(e){
    e.preventDefault();e.stopPropagation();
    var el=selectedEl();
    if(el)parent.postMessage({source:"b-preview",type:"delete",id:el.getAttribute("data-b-id")},"*");
  });
  window.addEventListener("scroll",function(){positionHandle();renderLocks();renderSpacing();renderGrips();},true);
  window.addEventListener("resize",function(){positionHandle();renderLocks();renderSpacing();renderGrips();});
  function clearWorking(){
    document.querySelectorAll(".b-working-overlay").forEach(function(n){n.remove()});
  }
  function spinner(){
    var s=document.createElement("div");s.className="b-working-spinner";return s;
  }
  var curLocks=[];
  function renderLocks(){
    document.querySelectorAll(".b-lock-badge").forEach(function(n){n.remove()});
    document.querySelectorAll("[data-b-lockedby]").forEach(function(n){n.removeAttribute("data-b-lockedby")});
    curLocks.forEach(function(l){
      var host=document.querySelector('[data-b-id="'+l.nodeId+'"]');
      if(!host)return;
      host.setAttribute("data-b-lockedby",l.name||"");
      var b=document.createElement("div");b.className="b-lock-badge";
      b.innerHTML='<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><span>'+(l.name||"editing")+'</span>';
      var r=host.getBoundingClientRect();
      b.style.left=Math.max(2,r.left+6)+"px";
      b.style.top=Math.max(2,r.top+6)+"px";
      document.body.appendChild(b);
    });
  }
  window.addEventListener("message",function(e){
    var d=e.data||{};if(d.source!=="b-editor")return;
    if(d.type==="select"){
      lastSelected=d.id||null;
      document.querySelectorAll("[data-b-id]").forEach(function(n){n.removeAttribute("data-b-selected")});
      var t=d.id&&document.querySelector('[data-b-id="'+d.id+'"]');
      if(t){t.setAttribute("data-b-selected","1");if(d.scroll)t.scrollIntoView({behavior:"smooth",block:"center"})}
      positionHandle();
      renderSpacing();
      renderGrips();
    }
    // In-place patch: replaces body and styles WITHOUT reloading the iframe,
    // so the scroll stays put and edits show in real time.
    if(d.type==="replace"){
      // Live embeds (HTML widget, video, maps): innerHTML would not re-run
      // their scripts, leaving empty boxes until reload. Those with an
      // identical signature are already mounted and are put back as they are;
      // for new or changed ones the scripts are recreated (cloning is not
      // enough: they must be new elements for the browser to run them).
      var mounted={};
      document.querySelectorAll("[data-b-embed]").forEach(function(n){
        mounted[n.getAttribute("data-b-id")+"|"+n.getAttribute("data-b-embed")]=n;
      });
      document.body.innerHTML=d.body;
      document.querySelectorAll("[data-b-embed]").forEach(function(fresh){
        var live=mounted[fresh.getAttribute("data-b-id")+"|"+fresh.getAttribute("data-b-embed")];
        if(live){
          fresh.parentNode.replaceChild(live,fresh);
          return;
        }
        fresh.querySelectorAll("script").forEach(function(old){
          var s=document.createElement("script");
          for(var i=0;i<old.attributes.length;i++){
            s.setAttribute(old.attributes[i].name,old.attributes[i].value);
          }
          if(old.textContent)s.textContent=old.textContent;
          old.parentNode.replaceChild(s,old);
        });
      });
      // The move/delete handles live in the body: re-attach them.
      document.body.appendChild(handle);
      document.body.appendChild(delHandle);
      // Remove/re-add ONLY the builder styles (marked data-b-style): external
      // players inject their CSS in <style> in the head and deleting it left
      // the embed mounted but unstyled, breaking the layout on every edit.
      document.head.querySelectorAll("style[data-b-style]").forEach(function(s){s.remove()});
      (d.styles||[]).forEach(function(css){
        var st=document.createElement("style");st.setAttribute("data-b-style","1");st.textContent=css;document.head.appendChild(st);
      });
      if(lastSelected){
        var sel=document.querySelector('[data-b-id="'+lastSelected+'"]');
        if(sel)sel.setAttribute("data-b-selected","1");
      }
      positionHandle();
      renderLocks();
      renderSpacing();
      renderGrips();
    }
    if(d.type==="working"){
      clearWorking();
      (d.ids||[]).forEach(function(id){
        var host=document.querySelector('[data-b-id="'+id+'"]');
        if(host){var ov=document.createElement("div");ov.className="b-working-overlay";ov.appendChild(spinner());host.appendChild(ov)}
      });
      if(d.full){var f=document.createElement("div");f.className="b-working-overlay b-full";f.appendChild(spinner());document.body.appendChild(f)}
    }
    if(d.type==="locks"){
      curLocks=d.locks||[];
      renderLocks();
    }
  });
})();
</script>`;

/** True when the node has at least one background overlay prop (_ov*). */
function hasOverlay(node: ElementNode): boolean {
  return (node.styles as { props?: Record<string, unknown> }[]).some((v) => {
    const p = v?.props ?? {};
    return Object.keys(p).some(
      (k) => k.startsWith("_ov") && p[k] !== "" && p[k] !== undefined && p[k] !== null,
    );
  });
}

function nodeClasses(node: ElementNode): string {
  const cls = ["b-el", wrapperClass(node.id), `b-widget-${node.type}`];
  if (node.type === "container") {
    cls.push("b-container");
    if (node.settings._containerType === "grid") cls.push("b-container--grid");
    cls.push(node.settings.contentWidth === "full" ? "b-container--full" : "b-container--boxed");
    if (node.settings._shapeTopType || node.settings._shapeBottomType) cls.push("b-has-shape");
    if (hasOverlay(node)) cls.push("b-has-overlay");
  }
  const extra = typeof node.settings._cssClasses === "string" ? node.settings._cssClasses.trim() : "";
  if (extra) cls.push(esc(extra));
  return cls.join(" ");
}

/**
 * Shape divider markup for one side of a container. Catalog shapes are drawn
 * resting on the bottom edge: for the top side the whole box is rotated 180
 * degrees. Custom SVGs are re-sanitized here because the document can come
 * from outside (import, API): unfiltered SVG never reaches public markup.
 */
function shapeDividerHtml(s: Record<string, unknown>, side: "Top" | "Bottom"): string {
  const type = typeof s[`_shape${side}Type`] === "string" ? (s[`_shape${side}Type`] as string).trim() : "";
  if (!type) return "";

  let svg: string;
  if (type === "custom") {
    const raw = typeof s[`_shape${side}Svg`] === "string" ? (s[`_shape${side}Svg`] as string) : "";
    const clean = raw ? sanitizeSvgShape(raw) : null;
    if (!clean) return "";
    svg = clean.svg;
  } else {
    const def = shapeDividerById(type);
    if (!def) return "";
    svg = def.svg;
  }

  const colorRaw = typeof s[`_shape${side}Color`] === "string" ? (s[`_shape${side}Color`] as string).trim() : "";
  const color = colorRaw || "var(--b-color-background,#fff)";
  const hRaw = Number(s[`_shape${side}Height`]);
  const height = Number.isFinite(hRaw) && hRaw > 0 ? Math.min(hRaw, 600) : 80;
  const yes = (v: unknown) => v === "yes" || v === true;

  const transforms: string[] = [];
  if (side === "Top") transforms.push("rotate(180deg)");
  if (yes(s[`_shape${side}Flip`])) transforms.push("scaleX(-1)");
  if (yes(s[`_shape${side}Invert`])) transforms.push("scaleY(-1)");

  const cls = `b-shape b-shape--${side.toLowerCase()}${yes(s[`_shape${side}Front`]) ? " b-shape--front" : ""}`;
  const style =
    `color:${esc(color)};height:${height}px` +
    (transforms.length ? `;transform:${transforms.join(" ")}` : "");
  return `<div class="${cls}" style="${style}" aria-hidden="true">${svg}</div>`;
}

const POPUP_CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const POPUP_EDIT_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>';

const POPUP_WIDTHS = ["sm", "md", "lg", "full"];

/** State of one render pass. */
interface RenderPass {
  editable: boolean;
  cssOut: string[];
  widgets: WidgetContext;
  hasRawHtml: boolean;
}

/**
 * Render a `popup` node. In edit mode it renders inline as a normal editable
 * block (dashed box + label) so its children can be selected/edited on the
 * canvas. In live mode it renders as a hidden modal (overlay + box) that the
 * runtime JS opens via a button/image action or an automatic trigger.
 */
function renderPopup(node: ElementNode, pass: RenderPass): string {
  const { editable } = pass;
  const css = buildNodeCss(node, { editable, media: pass.widgets.media });
  if (css) pass.cssOut.push(css);

  const s = node.settings;
  const cssId = typeof s._cssId === "string" ? s._cssId.trim() : "";
  const idAttr = cssId ? ` id="${esc(cssId)}"` : "";
  const width = POPUP_WIDTHS.includes(String(s.width)) ? String(s.width) : "md";
  const inner = node.children.map((c) => renderNode(c, pass)).join("");
  const extra = typeof s._cssClasses === "string" ? s._cssClasses.trim() : "";

  if (editable) {
    // The element carrying data-b-id (the box) is the DIRECT parent of the
    // children so drag & drop can hit-test and order them like a container.
    const name = esc(typeof s.name === "string" && s.name.trim() ? s.name.trim() : "Popup");
    const wrapCls = ["b-el", wrapperClass(node.id), "b-widget-popup", "b-popup", "b-popup--edit"];
    if (extra) wrapCls.push(esc(extra));
    const label = `<div class="b-popup__editlabel">${POPUP_EDIT_ICON}<span>Popup: ${name}</span></div>`;
    const emptyAttr = node.children.length === 0 ? " data-b-container-empty" : "";
    const box = `<div class="b-popup__box b-popup__box--${width}" data-b-id="${esc(node.id)}" data-b-type="popup"${
      node.locked ? ' data-b-locked="1"' : ""
    }${emptyAttr}>${inner}</div>`;
    return `<div class="${wrapCls.join(" ")}"${idAttr}>${label}${box}</div>`;
  }

  const showClose = s.showClose !== "no" && s.showClose !== false && s.showClose !== "";
  const closeBtn = showClose
    ? `<button type="button" class="b-popup__close" data-b-popup-close aria-label="Close">${POPUP_CLOSE_ICON}</button>`
    : "";
  const box = `<div class="b-popup__box b-popup__box--${width}">${closeBtn}<div class="b-popup__content">${inner}</div></div>`;
  const classes = ["b-el", wrapperClass(node.id), "b-widget-popup", "b-popup"];
  if (extra) classes.push(esc(extra));
  const trigger = String(s.trigger ?? "none");
  const hasTrigger = trigger && trigger !== "none";
  const triggerAttr = hasTrigger ? ` data-b-trigger="${esc(trigger)}"` : "";
  const tv = s.triggerValue === undefined || s.triggerValue === null ? "" : String(s.triggerValue);
  const triggerValueAttr = hasTrigger && tv ? ` data-b-trigger-value="${esc(tv)}"` : "";
  const freq = hasTrigger ? String(s.frequency ?? "always") : "";
  const freqAttr = freq ? ` data-b-frequency="${esc(freq)}"` : "";
  const freqDays = s.frequencyDays === undefined || s.frequencyDays === null ? "" : String(s.frequencyDays);
  const freqDaysAttr = freq === "once_days" && freqDays ? ` data-b-frequency-days="${esc(freqDays)}"` : "";
  const overlay = `<div class="b-popup__overlay" data-b-popup-close></div>`;
  return `<div class="${classes.join(" ")}"${idAttr} data-b-popup-id="${esc(node.id)}"${triggerAttr}${triggerValueAttr}${freqAttr}${freqDaysAttr} hidden>${overlay}${box}</div>`;
}

/**
 * Signature of a "live" widget's markup (embed with script/iframe/video). Only
 * the editor uses it: when the preview is re-patched, a node with the same
 * signature is already mounted and is reused instead of being rebuilt empty
 * (scripts do not re-run through innerHTML). djb2.
 */
function embedSignature(html: string): string {
  let h = 5381;
  for (let i = 0; i < html.length; i++) h = ((h << 5) + h + html.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const LIVE_EMBED_RE = /<(script|iframe|video)\b/i;

/**
 * "Whole page" sticky: native position:sticky stays bound to the parent
 * container, so the runtime promotes the element to position:fixed past the
 * threshold. The "section" scope keeps plain CSS.
 */
function stickyPageAttr(node: ElementNode): string {
  let sticky = false;
  let sectionOnly = false;
  for (const v of node.styles) {
    const p = v.props;
    if (p._sticky === "top" || p._sticky === "bottom") sticky = true;
    if (p._stickyScope === "section") sectionOnly = true;
  }
  return sticky && !sectionOnly ? " data-b-sticky" : "";
}

function renderNode(node: ElementNode, pass: RenderPass): string {
  if (node.type === "popup") return renderPopup(node, pass);
  const { editable } = pass;

  const css = buildNodeCss(node, { editable, media: pass.widgets.media });
  if (css) pass.cssOut.push(css);

  const cssId = typeof node.settings._cssId === "string" ? node.settings._cssId.trim() : "";
  const idAttr = cssId ? ` id="${esc(cssId)}"` : "";
  const dataAttrs = editable
    ? ` data-b-id="${esc(node.id)}" data-b-type="${esc(node.type)}"${node.locked ? ' data-b-locked="1"' : ""}`
    : "";

  let inner: string;
  let tag = "div";
  if (node.type === "container") {
    const t = String(node.settings.htmlTag ?? "div");
    tag = /^(div|section|header|footer|main|article)$/.test(t) ? t : "div";
    inner =
      shapeDividerHtml(node.settings, "Top") +
      node.children.map((c) => renderNode(c, pass)).join("") +
      shapeDividerHtml(node.settings, "Bottom");
  } else {
    if (node.type === "html") pass.hasRawHtml = true;
    inner = renderWidgetInner(node.type, node.settings, pass.widgets);
  }
  const emptyAttr = editable && node.type === "container" && node.children.length === 0
    ? " data-b-container-empty"
    : "";
  const embedAttr =
    editable && node.type !== "container" && LIVE_EMBED_RE.test(inner)
      ? ` data-b-embed="${embedSignature(inner)}"`
      : "";
  const stickyAttr = stickyPageAttr(node);
  return `<${tag} class="${nodeClasses(node)}"${idAttr}${dataAttrs}${emptyAttr}${embedAttr}${stickyAttr}>${inner}</${tag}>`;
}

/** Head metadata of a published page (SEO + social cards). */
export interface PageMeta {
  title?: string;
  description?: string;
  /** Absolute canonical URL. */
  canonical?: string;
  /** Absolute URL of the page (og:url); defaults to the canonical URL. */
  url?: string;
  ogImage?: string;
  noindex?: boolean;
  favicon?: string;
  /** BCP 47 language of the page (html lang). Defaults to "en". */
  lang?: string;
  siteName?: string;
}

export interface RenderOptions {
  /** `editor` adds the canvas overlay (selection, handles) and renders native embeds as placeholders. */
  mode?: "public" | "editor";
  /** Same as `mode: "editor"` (kept for editor ports). */
  editable?: boolean;
  /** Tenant slug written in the forms/booking embeds. */
  tenantSlug?: string;
  /** Base URL media files are served from (e.g. `/m/<slug>/`); rewrites amable media URLs onto it. */
  mediaBaseUrl?: string;
  /** Landing page id (meta `amable-page-id` + `data-amable-page` on the form embeds). */
  pageId?: string | null;
  meta?: PageMeta;
  /** Analytics site id: injects the tracker snippet (public mode only). */
  trackerSiteId?: string | null;
  /** Origin serving `/forms.js`, `/booking.js`, `/s.js`. Defaults to same-origin (""). */
  scriptOrigin?: string;
}

/** A rendered page plus what the caller needs to build its Content-Security-Policy. */
export interface RenderedPage {
  html: string;
  /** Exact text of every inline `<script>` the renderer emitted (to hash for the CSP). */
  inlineScripts: string[];
  /** Native embeds present in the page. */
  embeds: EmbedKind[];
  /** The page contains author-written HTML (html widget): scripts of unknown origin. */
  hasRawHtml: boolean;
  hasTracker: boolean;
}

const EMBED_SCRIPTS: Record<EmbedKind, string> = { forms: "/forms.js", booking: "/booking.js", checkout: "/checkout.js" };

function trackerStub(): string {
  return "window.amable=window.amable||function(){(window.amable.q=window.amable.q||[]).push(arguments)};";
}

function headMeta(meta: PageMeta, pageId: string | null): string {
  const out: string[] = [];
  const url = meta.url ?? meta.canonical;
  if (meta.description) out.push(`<meta name="description" content="${esc(meta.description)}"/>`);
  if (meta.noindex) out.push(`<meta name="robots" content="noindex,nofollow"/>`);
  if (meta.canonical) out.push(`<link rel="canonical" href="${esc(safeUrl(meta.canonical))}"/>`);
  if (meta.favicon && safeUrl(meta.favicon)) out.push(`<link rel="icon" href="${esc(safeUrl(meta.favicon))}"/>`);
  out.push(`<meta property="og:type" content="website"/>`);
  if (meta.title) out.push(`<meta property="og:title" content="${esc(meta.title)}"/>`);
  if (meta.description) out.push(`<meta property="og:description" content="${esc(meta.description)}"/>`);
  if (url) out.push(`<meta property="og:url" content="${esc(safeUrl(url))}"/>`);
  if (meta.siteName) out.push(`<meta property="og:site_name" content="${esc(meta.siteName)}"/>`);
  if (meta.ogImage && safeUrl(meta.ogImage)) {
    out.push(`<meta property="og:image" content="${esc(safeUrl(meta.ogImage))}"/>`);
    out.push(`<meta name="twitter:card" content="summary_large_image"/>`);
  }
  if (pageId) out.push(`<meta name="amable-page-id" content="${esc(pageId)}"/>`);
  return out.join("\n");
}

/** Render a canvas document to a full HTML page, with the data needed for its CSP. */
export function renderBuilderPage(doc: BuilderDocument, opts: RenderOptions = {}): RenderedPage {
  const editable = opts.mode === "editor" || (opts.mode === undefined && opts.editable === true);
  const pageId = opts.pageId ?? null;
  const pass: RenderPass = {
    editable,
    cssOut: [],
    hasRawHtml: false,
    widgets: {
      editable,
      tenantSlug: opts.tenantSlug ?? "",
      pageId,
      media: mediaResolver(opts.mediaBaseUrl),
      embeds: new Set(),
    },
  };
  const body = doc.body.map((n) => renderNode(n, pass)).join("\n");
  const fonts = collectFonts(doc);
  const meta = opts.meta ?? {};
  const origin = opts.scriptOrigin ?? "";
  const inlineScripts = [RUNTIME_JS];
  const tail: string[] = [`<script>${RUNTIME_JS}</script>`];
  for (const kind of pass.widgets.embeds) {
    tail.push(`<script async src="${esc(origin + EMBED_SCRIPTS[kind])}"></script>`);
  }
  const siteId = editable ? null : (opts.trackerSiteId ?? null);
  let tracker = "";
  if (siteId) {
    inlineScripts.push(trackerStub());
    tracker = `<script>${trackerStub()}</script><script defer data-site="${esc(siteId)}" src="${esc(origin)}/s.js"></script>`;
  }
  const customCss = doc.customCss ? `<style data-b-style>${cssForStyleTag(doc.customCss)}</style>` : "";

  const html = `<!doctype html>
<html lang="${esc(meta.lang || "en")}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(meta.title || "Landing")}</title>
${headMeta(meta, pageId)}
${googleFontsLink(fonts)}
<style data-b-style>${cssForStyleTag(tokensToCss(doc.tokens))}${BASE_CSS}${editable ? EDIT_OVERLAY_CSS : ""}
${cssForStyleTag(pass.cssOut.join("\n"))}</style>
${customCss}
${tracker}
</head>
<body>
${body}
${tail.join("\n")}
${editable ? EDIT_OVERLAY_JS : ""}
</body>
</html>`;
  return {
    html,
    inlineScripts,
    embeds: [...pass.widgets.embeds],
    hasRawHtml: pass.hasRawHtml,
    hasTracker: siteId !== null,
  };
}

/** Render a canvas document to a full HTML page (public SSR + editor preview). */
export function renderBuilderDocumentHtml(doc: BuilderDocument, opts: RenderOptions = {}): string {
  return renderBuilderPage(doc, opts).html;
}

/**
 * Content-Security-Policy for a public page. `scriptHashes` are the base64
 * SHA-256 digests of `RenderedPage.inlineScripts`. Pages with author HTML
 * (html widget) cannot be hashed ahead of time, so they allow inline and
 * https scripts/frames instead.
 */
export function builderPageCsp(page: RenderedPage, scriptHashes: readonly string[]): string {
  // The forms widget renders a Turnstile challenge when the form enables it.
  const turnstile = page.embeds.includes("forms") ? " https://challenges.cloudflare.com" : "";
  // The checkout widget loads Stripe.js, which frames the card fields and 3-D Secure.
  const stripe = page.embeds.includes("checkout");
  const script = page.hasRawHtml
    ? "script-src 'self' 'unsafe-inline' https:"
    : `script-src 'self' ${scriptHashes.map((h) => `'sha256-${h}'`).join(" ")}${turnstile}${stripe ? " https://js.stripe.com" : ""}`;
  const frames = page.hasRawHtml
    ? "frame-src https:"
    : `frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com${turnstile}${stripe ? " https://js.stripe.com https://hooks.stripe.com" : ""}`;
  return [
    "default-src 'self'",
    script,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' https: data:",
    "media-src 'self' https:",
    frames,
    `connect-src 'self'${page.hasRawHtml ? " https:" : stripe ? " https://api.stripe.com" : ""}`,
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** All Google Font families used by the document: tokens + per-widget typography. */
function collectFonts(doc: BuilderDocument): string[] {
  const fams = new Set(tokenFontFamilies(doc.tokens));
  const json = JSON.stringify(doc.body);
  for (const m of json.matchAll(/"fontFamily":"([^"]+)"/g)) {
    const fam = m[1];
    if (fam && !fam.startsWith("var(") && !/system-ui|sans-serif|serif|monospace|inherit/.test(fam)) {
      fams.add(fam);
    }
  }
  return [...fams].filter(Boolean);
}

function googleFontsLink(fams: string[]): string {
  if (fams.length === 0) return "";
  // The css2 API is case-sensitive on family names: one wrong name fails the
  // WHOLE stylesheet with a 400. Canonicalize and dedupe.
  const canon = [...new Set(fams.map((f) => canonicalFontFamily(f)))];
  const spec = canon
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@400;500;600;700`)
    .join("&");
  return `<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${esc(spec)}&amp;display=swap"/>`;
}
