import {
  createLiquid,
  parseLiquid,
  renderLiquid,
  type LiquidSandboxOptions,
  type ParsedLiquid,
} from './liquid';
import { sanitizeEmailHtml } from './sanitize';
import { EMAIL_NODES, type TiptapDocument, type TiptapNode } from './schema';
import { serializeHtml } from './serialize-html';
import { serializeText, tidyText } from './serialize-text';
import { DEFAULT_EMAIL_THEME, type EmailTheme } from './theme';

export * from './schema';
export * from './liquid-syntax';
export * from './liquid-builders';
export * from './liquid-analysis';
export { DEFAULT_EMAIL_THEME, type EmailTheme } from './theme';
export { sanitizeEmailHtml } from './sanitize';
export type { LiquidSandboxOptions } from './liquid';

/**
 * Tiptap JSON → email-safe HTML (tables, inline CSS, fixed width) + plain text.
 *
 * Two steps, so the expensive part runs once per send:
 * 1. `compileEmail` converts the document into Liquid templates (HTML, text, subject);
 * 2. `createRecipientRenderer(...).render(context)` resolves Liquid for one
 *    recipient in the sandbox and sanitizes the resulting HTML.
 *
 * Everything here is runtime-agnostic: it runs in a Worker, in Node and in the browser preview.
 */

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface CompileEmailOptions {
  /** Subject line; may contain Liquid output tags. */
  readonly subject?: string;
  readonly lang?: string;
  readonly theme?: Partial<EmailTheme>;
  /**
   * Marketing email must carry an unsubscribe link. When true (default) and the
   * document has no top-level footer, a default footer is appended; every
   * footer always renders the `{{ unsubscribe_url }}` link.
   */
  readonly requireUnsubscribe?: boolean;
  readonly unsubscribeLabel?: string;
  /** Sender's physical address, printed in the footer (required for broadcasts). */
  readonly footerAddress?: string;
}

export interface CompiledEmail {
  readonly subjectTemplate: string;
  readonly htmlTemplate: string;
  readonly textTemplate: string;
  readonly preheader: string;
  readonly requiresUnsubscribe: boolean;
}

export class EmailTemplateError extends Error {
  override readonly name = 'EmailTemplateError';
}

export class MissingUnsubscribeUrlError extends Error {
  override readonly name = 'MissingUnsubscribeUrlError';
  constructor() {
    super('Recipient context has no unsubscribe_url but the email requires an unsubscribe link');
  }
}

function hasTopLevelFooter(blocks: readonly TiptapNode[]): boolean {
  return blocks.some((node) => node.type === EMAIL_NODES.footer);
}

function extractPreheader(blocks: readonly TiptapNode[]): string {
  const node = blocks.find((block) => block.type === EMAIL_NODES.preheader);
  const text = node?.attrs?.['text'];
  return typeof text === 'string' ? text.trim() : '';
}

export function compileEmail(
  doc: TiptapDocument,
  options: CompileEmailOptions = {},
): CompiledEmail {
  if (doc.type !== 'doc') throw new EmailTemplateError('Expected a Tiptap document');
  const requireUnsubscribe = options.requireUnsubscribe ?? true;
  const unsubscribeLabel = options.unsubscribeLabel ?? 'Unsubscribe';
  const footerAddress = options.footerAddress?.trim() || null;
  const theme: EmailTheme = { ...DEFAULT_EMAIL_THEME, ...options.theme };

  let blocks: readonly TiptapNode[] = doc.content ?? [];
  if (requireUnsubscribe && !hasTopLevelFooter(blocks)) {
    blocks = [...blocks, { type: EMAIL_NODES.footer, attrs: { unsubscribeLabel }, content: [] }];
  }
  const preheader = extractPreheader(blocks);

  return {
    subjectTemplate: (options.subject ?? '').replace(/[\r\n]+/g, ' ').trim(),
    htmlTemplate: serializeHtml({
      blocks,
      preheader,
      theme,
      lang: options.lang ?? 'en',
      unsubscribeLabel,
      footerAddress,
    }),
    textTemplate: serializeText({ blocks, unsubscribeLabel, footerAddress }),
    preheader,
    requiresUnsubscribe: requireUnsubscribe || hasTopLevelFooter(blocks),
  };
}

export interface RecipientRenderer {
  render(context: Record<string, unknown>): Promise<RenderedEmail>;
}

function parseOrThrow(
  engine: ReturnType<typeof createLiquid>,
  source: string,
  part: string,
): ParsedLiquid {
  try {
    return parseLiquid(engine, source);
  } catch (error) {
    throw new EmailTemplateError(
      `Invalid Liquid in ${part}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Parses the templates once; `render` is then called for every recipient. */
export function createRecipientRenderer(
  compiled: CompiledEmail,
  options: LiquidSandboxOptions = {},
): RecipientRenderer {
  const htmlEngine = createLiquid(true, options);
  const textEngine = createLiquid(false, options);
  const html = parseOrThrow(htmlEngine, compiled.htmlTemplate, 'HTML body');
  const text = parseOrThrow(textEngine, compiled.textTemplate, 'text body');
  const subject = parseOrThrow(textEngine, compiled.subjectTemplate, 'subject');

  return {
    async render(context) {
      if (compiled.requiresUnsubscribe) {
        const url = context['unsubscribe_url'];
        if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
          throw new MissingUnsubscribeUrlError();
      }
      const [renderedHtml, renderedText, renderedSubject] = await Promise.all([
        renderLiquid(html, context),
        renderLiquid(text, context),
        renderLiquid(subject, context),
      ]);
      return {
        subject: renderedSubject.replace(/[\r\n]+/g, ' ').trim(),
        html: sanitizeEmailHtml(renderedHtml),
        text: tidyText(renderedText),
      };
    },
  };
}

/** One-shot helper for previews and single sends. */
export async function renderEmail(
  doc: TiptapDocument,
  context: Record<string, unknown>,
  options: CompileEmailOptions & LiquidSandboxOptions = {},
): Promise<RenderedEmail> {
  return createRecipientRenderer(compileEmail(doc, options), options).render(context);
}
