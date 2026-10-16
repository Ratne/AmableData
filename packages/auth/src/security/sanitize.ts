import { Parser } from 'htmlparser2';

/**
 * Server-side HTML sanitizer (whitelist) for user content produced by the rich
 * text editor (notes, templates, form texts). Runs in Workers (no DOM): the
 * input is tokenized with htmlparser2 and rebuilt from allowed tags and
 * attributes only. Everything else is dropped; text is re-escaped.
 */

export interface SanitizeOptions {
  /** Tag → allowed attributes. */
  readonly allowedTags?: Readonly<Record<string, readonly string[]>>;
  /** URL schemes allowed in href/src. */
  readonly allowedSchemes?: readonly string[];
  /** Keep `style` attributes, filtered to `cssProperties` (email templates need inline CSS). */
  readonly allowStyles?: boolean;
  /** CSS properties kept when `allowStyles` is set (default SAFE_CSS_PROPERTIES). */
  readonly cssProperties?: ReadonlySet<string>;
  /** Allow `<img src="data:image/(png|gif|jpeg|webp);…">` (inline images in emails). */
  readonly allowDataImages?: boolean;
  /** Encode `{` as `&#123;` so the output can never be re-interpreted as Liquid. */
  readonly encodeBraces?: boolean;
}

export const SAFE_CSS_PROPERTIES = new Set([
  'color',
  'background-color',
  'text-align',
  'vertical-align',
  'font-weight',
  'font-style',
  'font-size',
  'font-family',
  'line-height',
  'letter-spacing',
  'text-decoration',
  'text-transform',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'width',
  'max-width',
  'height',
  'border',
  'border-radius',
  'border-collapse',
  'display',
]);

/** Inline CSS needed by the email layout (tables, Outlook `mso-*` hints). */
export const EMAIL_CSS_PROPERTIES: ReadonlySet<string> = new Set([
  ...SAFE_CSS_PROPERTIES,
  'background',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-spacing',
  'border-style',
  'border-width',
  'box-sizing',
  'font',
  'list-style',
  'list-style-type',
  'max-height',
  'min-width',
  'mso-font-width',
  'mso-hide',
  'mso-line-height-rule',
  'mso-padding-alt',
  'mso-text-raise',
  'opacity',
  'outline',
  'overflow',
  'table-layout',
  'text-decoration-line',
  'visibility',
  'white-space',
  'word-break',
]);

/** Keeps only whitelisted properties with inert values (no url(), expression(), @import, escapes, comments). */
export function sanitizeStyle(style: string, properties: ReadonlySet<string> = SAFE_CSS_PROPERTIES): string {
  return style
    .split(';')
    .map((decl) => {
      const index = decl.indexOf(':');
      if (index === -1) return null;
      const property = decl.slice(0, index).trim().toLowerCase();
      const value = decl.slice(index + 1).trim();
      if (!properties.has(property)) return null;
      if (
        !/^[#\w\s.,%()'"/!+-]*$/.test(value) ||
        value.includes('/*') ||
        /url\s*\(|expression|javascript|@import/i.test(value)
      ) {
        return null;
      }
      return `${property}: ${value}`;
    })
    .filter((d): d is string => d !== null)
    .join('; ');
}

const GLOBAL_ATTRS = ['class', 'dir', 'lang', 'title', 'data-type', 'data-id', 'data-label'];

export const DEFAULT_ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'target', 'rel'],
  b: [],
  blockquote: [],
  br: [],
  code: [],
  div: ['align'],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  hr: [],
  i: [],
  img: ['src', 'alt', 'width', 'height'],
  li: [],
  mark: [],
  ol: ['start'],
  p: ['align'],
  pre: [],
  s: [],
  span: [],
  strong: [],
  sub: [],
  sup: [],
  table: ['width', 'cellpadding', 'cellspacing', 'border', 'align'],
  tbody: [],
  td: ['colspan', 'rowspan', 'width', 'align', 'valign'],
  th: ['colspan', 'rowspan', 'width', 'align', 'valign'],
  thead: [],
  tr: [],
  u: [],
  ul: [],
};

const EMAIL_TABLE_ATTRS = ['align', 'valign', 'width', 'height', 'border', 'cellpadding', 'cellspacing', 'role', 'bgcolor'];

/** Whole email documents: the rich-text tags plus document structure and table layout attributes. */
export const EMAIL_ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(Object.entries(DEFAULT_ALLOWED_TAGS).map(([tag, attrs]) => [tag, [...attrs, 'align']])),
  html: ['xmlns'],
  head: [],
  meta: ['name', 'content', 'http-equiv', 'charset'],
  title: [],
  body: ['bgcolor'],
  table: EMAIL_TABLE_ATTRS,
  thead: EMAIL_TABLE_ATTRS,
  tbody: EMAIL_TABLE_ATTRS,
  tr: EMAIL_TABLE_ATTRS,
  td: [...EMAIL_TABLE_ATTRS, 'colspan', 'rowspan'],
  th: [...EMAIL_TABLE_ATTRS, 'colspan', 'rowspan'],
  ol: ['start', 'type'],
  img: ['src', 'alt', 'width', 'height', 'border'],
  center: [],
};

const VOID_TAGS = new Set(['br', 'hr', 'img', 'meta']);
/** Content of these is dropped entirely, not just the tags. */
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math']);

export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DATA_IMAGE_RE = /^data:image\/(png|gif|jpeg|webp);base64,[a-z0-9+/=]+$/i;

function safeUrl(value: string, schemes: readonly string[], dataImage: boolean): string | null {
  // Strip control chars and whitespace browsers ignore inside schemes ("java\tscript:").
  const compact = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
  if (scheme === undefined) {
    // Relative URLs, anchors and Liquid placeholders ({{ … }}) are fine.
    return compact.startsWith('//') ? null : value.trim();
  }
  if (scheme === 'data') return dataImage && DATA_IMAGE_RE.test(compact) ? compact : null;
  return schemes.includes(scheme) ? value.trim() : null;
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): string {
  const tags = options.allowedTags ?? DEFAULT_ALLOWED_TAGS;
  const schemes = options.allowedSchemes ?? ['http', 'https', 'mailto', 'tel'];
  const braces = (value: string): string => (options.encodeBraces === true ? value.replace(/\{/g, '&#123;') : value);
  let out = '';
  let dropDepth = 0;
  const open: string[] = [];

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase();
        if (DROP_CONTENT.has(tag)) {
          dropDepth += 1;
          return;
        }
        if (dropDepth > 0) return;
        const allowed = tags[tag];
        if (allowed === undefined) return;
        let attrs = '';
        const blank = tag === 'a' && attributes.target === '_blank';
        for (const [rawKey, rawValue] of Object.entries(attributes)) {
          const key = rawKey.toLowerCase();
          if (key === 'style' && options.allowStyles === true) {
            const style = sanitizeStyle(rawValue, options.cssProperties);
            if (style !== '') attrs += ` style="${braces(escapeHtmlAttr(style))}"`;
            continue;
          }
          if (!allowed.includes(key) && !GLOBAL_ATTRS.includes(key)) continue;
          if (key === 'rel' && blank) continue;
          let value: string | null = rawValue;
          if (key === 'href' || key === 'src') {
            value = safeUrl(rawValue, schemes, key === 'src' && tag === 'img' && options.allowDataImages === true);
          }
          if (key === 'target') value = rawValue === '_blank' ? '_blank' : null;
          if (value === null) continue;
          attrs += ` ${key}="${braces(escapeHtmlAttr(value))}"`;
        }
        if (blank) attrs += ' rel="noopener noreferrer"';
        out += `<${tag}${attrs}>`;
        if (!VOID_TAGS.has(tag)) open.push(tag);
      },
      ontext(text) {
        if (dropDepth === 0) out += braces(escapeHtmlText(text));
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (DROP_CONTENT.has(tag)) {
          dropDepth = Math.max(dropDepth - 1, 0);
          return;
        }
        if (dropDepth > 0 || VOID_TAGS.has(tag) || tags[tag] === undefined) return;
        const index = open.lastIndexOf(tag);
        if (index === -1) return;
        while (open.length > index) out += `</${open.pop() ?? ''}>`;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(input);
  parser.end();
  while (open.length > 0) out += `</${open.pop() ?? ''}>`;
  return out;
}

const DOCTYPE_RE = /^\s*<!DOCTYPE[^>]*>/i;

/**
 * Sanitizes a whole rendered email (applied per recipient, after Liquid): the
 * serializer escapes what it emits, this covers raw Liquid blocks and links
 * whose target comes from contact data. The leading doctype is kept.
 */
export function sanitizeEmailDocument(html: string): string {
  const doctype = DOCTYPE_RE.exec(html)?.[0] ?? '';
  const safeDoctype = /^\s*<!DOCTYPE html[\w\s"'./:-]*>$/i.test(doctype) ? doctype.trim() : '';
  return (
    safeDoctype +
    sanitizeHtml(html.slice(doctype.length), {
      allowedTags: EMAIL_ALLOWED_TAGS,
      allowStyles: true,
      cssProperties: EMAIL_CSS_PROPERTIES,
      allowDataImages: true,
      encodeBraces: true,
    })
  );
}
