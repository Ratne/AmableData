/**
 * Sanitization of the inline HTML allowed in plain text fields (headings,
 * button labels): the author can highlight a word with <span>, <strong>,
 * break lines with <br>, etc. Anything not allowlisted is shown as literal
 * text, so a bad paste cannot inject script or break the layout.
 *
 * Sanitization by reconstruction (no DOM: works in the worker and in the
 * browser), output always balanced.
 */

/** Tag inline consentiti; `br` e' void. */
const ALLOWED_TAGS = new Set([
  "span",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "small",
  "mark",
  "sub",
  "sup",
  "br",
]);

const VOID_TAGS = new Set(["br"]);

/** A valid HTML entity reference, passed through untouched. */
const ENTITY_RE = /^&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/** Escapes text, preserving entities written by the author (e.g. &nbsp;). */
function escText(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "&") {
      const m = ENTITY_RE.exec(input.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
      out += "&amp;";
      continue;
    }
    if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else out += ch;
  }
  return out;
}

function escAttrValue(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Simple class names only: no selectors or odd characters. */
function safeClass(value: string): string {
  const kept = value
    .split(/\s+/)
    .filter((c) => /^[A-Za-z0-9_-]+$/.test(c))
    .slice(0, 10);
  return kept.join(" ");
}

/**
 * Allowed inline style: `prop: value` declarations with simple values.
 * Excludes url()/expression() and anything with suspicious parentheses, so
 * text cannot load external resources.
 */
function safeStyle(value: string): string {
  const out: string[] = [];
  for (const decl of value.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!/^[a-z-]{2,40}$/.test(prop) || !val) continue;
    if (/url\s*\(|expression\s*\(|javascript:|@import|\/\*/i.test(val)) continue;
    // Valori: parole, numeri, %, #hex, virgole, spazi, funzioni consentite.
    if (!/^[A-Za-z0-9\s.,%#()_-]+$/.test(val)) continue;
    if (/\(/.test(val) && !/^(var|rgb|rgba|hsl|hsla|calc|clamp|min|max)\s*\(/i.test(val)) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(";");
}

interface ParsedTag {
  name: string;
  closing: boolean;
  attrs: Record<string, string>;
}

/** Tokenizes a tag starting at `<`; null when it is not a well-formed tag. */
function parseTag(src: string, start: number): { tag: ParsedTag; end: number } | null {
  const gt = src.indexOf(">", start);
  if (gt === -1) return null;
  let inner = src.slice(start + 1, gt).trim();
  const closing = inner.startsWith("/");
  if (closing) inner = inner.slice(1).trim();
  if (inner.endsWith("/")) inner = inner.slice(0, -1).trim();
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9]*/.exec(inner);
  if (!nameMatch) return null;
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const rest = inner.slice(nameMatch[0].length);
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(rest))) {
    attrs[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? "";
  }
  return { tag: { name: nameMatch[0].toLowerCase(), closing, attrs }, end: gt + 1 };
}

/**
 * Safe markup for a text field: allowlisted inline tags are kept (with only
 * filtered class/style), everything else becomes visible text.
 */
export function sanitizeInlineHtml(raw: unknown): string {
  const src = String(raw ?? "");
  if (!src.includes("<") && !src.includes("&")) return escText(src);

  let out = "";
  const open: string[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out += escText(src.slice(i));
      break;
    }
    if (lt > i) out += escText(src.slice(i, lt));

    const parsed = parseTag(src, lt);
    if (!parsed || !ALLOWED_TAGS.has(parsed.tag.name)) {
      // Not an allowed tag: show it as text (including <script ...>).
      const gt = src.indexOf(">", lt);
      const literalEnd = gt === -1 ? src.length : gt + 1;
      out += escText(src.slice(lt, literalEnd));
      i = literalEnd;
      continue;
    }

    const { name, closing, attrs } = parsed.tag;
    i = parsed.end;

    if (VOID_TAGS.has(name)) {
      if (!closing) out += `<${name}/>`;
      continue;
    }
    if (closing) {
      // Close only when it matches the innermost open tag.
      if (open[open.length - 1] === name) {
        open.pop();
        out += `</${name}>`;
      }
      continue;
    }

    const kept: string[] = [];
    const cls = attrs["class"] ? safeClass(attrs["class"]) : "";
    if (cls) kept.push(`class="${escAttrValue(cls)}"`);
    const style = attrs["style"] ? safeStyle(attrs["style"]) : "";
    if (style) kept.push(`style="${escAttrValue(style)}"`);
    out += `<${name}${kept.length ? " " + kept.join(" ") : ""}>`;
    open.push(name);
  }

  while (open.length > 0) out += `</${open.pop()}>`;
  return out;
}
