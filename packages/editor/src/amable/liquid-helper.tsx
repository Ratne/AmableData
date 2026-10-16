import { compileEmail, LIQUID_NODES, parseVariableExpression, type TiptapDocument } from '@amable/email-render';
import type { Editor } from '@tiptap/core';
import { createContext, useContext, type ReactNode } from 'react';
import type { LiquidFieldGroup } from './fields';

/**
 * Slot for the app's Liquid helper drawer. The app provides it once (with its
 * API client, translations and UI kit); every email-mode `AmableEditor` below
 * the provider then shows a toolbar button that opens it.
 */

export interface LiquidHelperHost {
  /** Inserts Liquid at the cursor: a simple output tag becomes a field chip, anything else a raw Liquid block. */
  insert(code: string): void;
  /** The document's Liquid as the plain-text part renders it (for the whole-email preview). */
  source(): string;
}

export interface LiquidHelperRenderProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly host: LiquidHelperHost;
  readonly fields: readonly LiquidFieldGroup[];
}

export interface LiquidHelperSlot {
  readonly label: string;
  readonly render: (props: LiquidHelperRenderProps) => ReactNode;
}

const LiquidHelperContext = createContext<LiquidHelperSlot | null>(null);

export function LiquidHelperProvider({
  slot,
  children,
}: {
  slot: LiquidHelperSlot;
  children: ReactNode;
}) {
  return <LiquidHelperContext.Provider value={slot}>{children}</LiquidHelperContext.Provider>;
}

export function useLiquidHelperSlot(): LiquidHelperSlot | null {
  return useContext(LiquidHelperContext);
}

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
