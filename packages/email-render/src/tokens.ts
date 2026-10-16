import { containsLiquidDelimiters } from './liquid-syntax';

/**
 * React escapes every quote in text and attributes, which would corrupt Liquid
 * source such as `default: "there"`. Liquid snippets are therefore swapped for
 * opaque ASCII tokens while React renders, then restored verbatim. The nonce
 * makes tokens unguessable, so text typed by an author cannot forge one.
 */
export class LiquidTokens {
  readonly #parts: string[] = [];
  readonly #prefix: string;
  readonly #pattern: RegExp;

  constructor() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    this.#prefix = `%%AMBLQ${nonce}_`;
    this.#pattern = new RegExp(`%%AMBLQ${nonce}_(\\d+)%%`, 'g');
  }

  /** Emits `source` verbatim in the final template. */
  raw(source: string): string {
    const index = this.#parts.push(source) - 1;
    return `${this.#prefix}${String(index)}%%`;
  }

  /**
   * Author text that happens to contain `{{` or `{%` must not become Liquid:
   * the brace is emitted as an HTML entity, which Liquid does not recognise.
   */
  text(value: string): string {
    if (!containsLiquidDelimiters(value)) return value;
    const brace = this.raw('&#123;');
    return value.replace(/\{(?=[{%])/g, brace);
  }

  /**
   * A value (link target, image source, preheader) that may mix literal text
   * and Liquid output tags. Literal parts are HTML-escaped here because the
   * whole value bypasses React's escaping; `{% %}` tags are neutralised.
   */
  mixed(value: string): string {
    if (!containsLiquidDelimiters(value)) return value;
    const source = value
      .split(/(\{\{[\s\S]*?\}\})/g)
      .map((part, index) =>
        index % 2 === 1 ? part : escapeAttribute(part.replace(/\{(?=[{%])/g, '')),
      )
      .join('');
    return this.raw(source);
  }

  restore(html: string): string {
    return html.replace(this.#pattern, (_match, index: string) => this.#parts[Number(index)] ?? '');
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
