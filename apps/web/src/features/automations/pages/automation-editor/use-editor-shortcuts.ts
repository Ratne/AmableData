import { useEffect } from 'react';
import type { PaletteItem } from '../../lib/defaults';
import type { DraftSync } from '../../lib/draft-sync';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.closest('[role="dialog"]') !== null
  );
}

export interface EditorShortcutActions {
  readonly sync: DraftSync;
  readonly readOnly: boolean;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly duplicateSelected: () => void;
  /** Escape: drop the selection and close the drill-down. */
  readonly clearSelection: () => void;
  readonly toggleReporting: () => void;
  readonly fitView: () => void;
  readonly tidy: () => void;
  readonly showShortcuts: () => void;
  readonly addNode: (item: PaletteItem) => void;
}

/** Window keyboard shortcuts of the canvas (ignored while typing in a field or a dialog). */
export function useEditorShortcuts(actions: EditorShortcutActions): void {
  const {
    sync,
    readOnly,
    undo,
    redo,
    duplicateSelected,
    clearSelection,
    toggleReporting,
    fitView,
    tidy,
    showShortcuts,
    addNode,
  } = actions;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 's') {
        event.preventDefault();
        void sync.flush();
        return;
      }
      if (isTyping(event.target)) return;
      if (mod && key === 'z') {
        event.preventDefault();
        if (readOnly) return;
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        if (!readOnly) redo();
        return;
      }
      if (mod && key === 'd') {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod || event.altKey) return;
      if (key === 'escape') clearSelection();
      else if (key === 'r') toggleReporting();
      else if (key === 'f') fitView();
      else if (key === 'l') tidy();
      else if (key === '?') showShortcuts();
      else if (key === '1') addNode({ kind: 'sequence' });
      else if (key === '2') addNode({ kind: 'decision' });
      else if (key === '3') addNode({ kind: 'note' });
      else if (key === '4') addNode({ kind: 'goal', trigger: 'tag_applied' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    addNode,
    clearSelection,
    duplicateSelected,
    fitView,
    readOnly,
    redo,
    showShortcuts,
    sync,
    tidy,
    toggleReporting,
    undo,
  ]);
}
