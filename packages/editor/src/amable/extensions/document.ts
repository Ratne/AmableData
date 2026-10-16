import { EMAIL_NODES } from '@amable/email-render';
import { Extension } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';

/** Email documents allow header, footer and preheader only at the top level. */
export const EmailDocument = Document.extend({
  // `block` first: ProseMirror fills documents with the first allowed type, which must be a paragraph.
  content: '(block | emailFrame)+',
});

export interface EmailGuardOptions {
  readonly unsubscribeLabel: string;
}

function hasTopLevelFooter(doc: PmNode): boolean {
  let found = false;
  doc.forEach((child) => {
    if (child.type.name === EMAIL_NODES.footer) found = true;
  });
  return found;
}

function withFooter(state: EditorState, label: string): Transaction | null {
  if (hasTopLevelFooter(state.doc)) return null;
  const footer = state.schema.nodes[EMAIL_NODES.footer];
  const paragraph = state.schema.nodes['paragraph'];
  if (!footer || !paragraph) return null;
  return state.tr
    .insert(state.doc.content.size, footer.create({ unsubscribeLabel: label }, paragraph.create()))
    .setMeta('addToHistory', false);
}

/**
 * Keeps an email footer (and so the unsubscribe link) in the document: it is
 * added on load and re-added if deleted. The renderer enforces the same rule
 * at send time; this only makes the editor honest about it.
 */
export const EmailFooterGuard = Extension.create<EmailGuardOptions>({
  name: 'emailFooterGuard',
  addOptions: () => ({ unsubscribeLabel: 'Unsubscribe' }),
  onCreate() {
    const tr = withFooter(this.editor.state, this.options.unsubscribeLabel);
    if (tr) this.editor.view.dispatch(tr);
  },
  addProseMirrorPlugins() {
    const label = this.options.unsubscribeLabel;
    return [
      new Plugin({
        key: new PluginKey('emailFooterGuard'),
        appendTransaction: (transactions, _old, state) =>
          transactions.some((tr) => tr.docChanged) ? withFooter(state, label) : null,
      }),
    ];
  },
});

/** Strips Word and Google Docs noise before ProseMirror parses pasted HTML. */
export function cleanPastedHtml(html: string): string {
  return html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?o:p[^>]*>/gi, '')
    .replace(/<\/?(w|m|v):[^>]*>/gi, '')
    .replace(/\sclass="?Mso[^"\s>]*"?/gi, '')
    .replace(/\sstyle="[^"]*mso-[^"]*"/gi, '')
    .replace(/<b[^>]*id="docs-internal-guid[^"]*"[^>]*>([\s\S]*?)<\/b>/gi, '$1')
    .replace(/<span[^>]*font-weight:\s*normal[^>]*>([\s\S]*?)<\/span>/gi, '$1');
}

export const CleanPaste = Extension.create({
  name: 'cleanPaste',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cleanPaste'),
        props: { transformPastedHTML: cleanPastedHtml },
      }),
    ];
  },
});
