import { compileEmail, LIQUID_NODES, parseVariableExpression, type TiptapDocument } from '@amable/email-render';
import type { Editor } from '@tiptap/core';
import type { LiquidFieldGroup } from './fields';

function fieldLabel(fields: readonly LiquidFieldGroup[], path: string): string {
  for (const group of fields) {
    const field = group.fields.find((candidate) => candidate.path === path);
    if (field !== undefined) return field.label;
  }
  return path;
}

/** Inserts generated Liquid into the editor at the cursor (see `LiquidHelperHost.insert`). */
export function insertLiquid(editor: Editor, code: string, fields: readonly LiquidFieldGroup[] = []): void {
  const variable = parseVariableExpression(code);
  if (variable !== null) {
    editor
      .chain()
      .focus()
      .insertContent([
        {
          type: LIQUID_NODES.variable,
          attrs: { ...variable, label: fieldLabel(fields, variable.path) },
        },
        { type: 'text', text: ' ' },
      ])
      .run();
    return;
  }
  editor.chain().focus().insertContent({ type: LIQUID_NODES.raw, attrs: { code } }).run();
}

/** Liquid source of the document (plain-text part, no unsubscribe footer). */
export function documentLiquidSource(editor: Editor): string {
  try {
    return compileEmail(editor.getJSON() as unknown as TiptapDocument, { requireUnsubscribe: false }).textTemplate;
  } catch {
    return '';
  }
}
