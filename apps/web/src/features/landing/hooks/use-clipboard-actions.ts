import {
  cloneNodeWithNewIds,
  findNode,
  isContainerType,
  locateNode,
  sectionsForType,
  type ElementNode,
} from '@amable/builder';
import { toast } from '@amable/ui';
import { useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import type { BuilderDocumentState } from './use-builder-document';
import {
  clipAge,
  countNodes,
  insertClonesAt,
  readStyleClip,
  useStyleClipboard,
  type ClipEntry,
} from './use-block-clipboard';
import { useCanvasClipboard } from './use-canvas-clipboard';

/**
 * Block and style copy/paste of the canvas editor: the server-backed personal
 * clipboard (with its tray) for blocks, localStorage for styles.
 */
export function useClipboardActions(options: {
  b: BuilderDocumentState;
  editable: boolean;
  pageTitle: string;
  titleOf: (type: string) => string;
  select: (id: string | null) => void;
  editingPopupId: string | null;
  setEditingPopupId: (id: string | null) => void;
}) {
  const { b, editable, pageTitle, titleOf, select, editingPopupId, setEditingPopupId } = options;
  const { t } = useI18n();
  const doc = b.doc;
  const styleClipboard = useStyleClipboard();
  const clipboard = useCanvasClipboard();
  const latestClip = clipboard.latest;
  const [trayOpen, setTrayOpen] = useState(false);
  const [trayHighlight, setTrayHighlight] = useState<string | null>(null);
  const trayTimer = useRef<number | null>(null);

  /** Opening or closing by hand cancels the auto-close of `flashTray`. */
  const setTray = (open: boolean) => {
    if (trayTimer.current) window.clearTimeout(trayTimer.current);
    setTrayOpen(open);
    if (!open) setTrayHighlight(null);
  };

  /** "Container (14 elementi)" — the toast/menu label for one node. */
  const clipLabelOf = (node: ElementNode): string => {
    const inner = countNodes(node.children);
    return inner > 0
      ? t('landing.editor.blockLabel', { name: titleOf(node.type), count: inner })
      : titleOf(node.type);
  };

  /** Menu entry description: label + source page + age. */
  const describeClip = (clip: ClipEntry): string => {
    const from = clip.sourcePageName
      ? ` — ${t('landing.editor.fromPage', { name: clip.sourcePageName })}`
      : '';
    const age = clipAge(clip.createdAt);
    return `${clip.label}${from}${age ? `, ${age}` : ''}`;
  };

  /** Shows the tray for a few seconds with the entry just copied on top. */
  const flashTray = (entryId: string) => {
    setTrayHighlight(entryId);
    setTrayOpen(true);
    if (trayTimer.current) window.clearTimeout(trayTimer.current);
    trayTimer.current = window.setTimeout(() => {
      setTrayOpen(false);
      setTrayHighlight(null);
    }, 3500);
  };

  /** Saves on the server; the "copied" toast only appears once it is stored. */
  const storeClip = async (nodes: readonly ElementNode[], label: string, wholePage: boolean) => {
    const toastId = toast.loading(t('landing.clipboard.copying', { name: label }));
    try {
      const entry = await clipboard.add({ label, nodes, wholePage, sourcePageName: pageTitle });
      toast.success(t('landing.editor.copied', { name: label }), { id: toastId });
      flashTray(entry.id);
    } catch {
      toast.error(t('landing.editor.copyFailed'), { id: toastId });
    }
  };

  const copyBlock = (id: string) => {
    const node = findNode(doc.body, id);
    if (!node) return;
    void storeClip([node], clipLabelOf(node), false);
  };

  /** Copies every root block of the page (popups included), in order. */
  const copyPage = () => {
    if (doc.body.length === 0) {
      toast.error(t('landing.editor.pageEmpty'));
      return;
    }
    const label = t('landing.editor.pageLabel', {
      name: pageTitle || t('landing.untitled'),
      count: doc.body.length,
    });
    void storeClip(doc.body, label, true);
  };

  /** Inserts fresh copies at parentId/index in ONE operation (a single undo reverts it). */
  const insertClipNodes = (
    nodes: readonly ElementNode[],
    parentId: string | null,
    index: number,
  ): boolean => {
    if (!editable) return false;
    const current = doc;
    if (nodes.length === 1) {
      const first = nodes[0];
      if (!first) return false;
      const copy = cloneNodeWithNewIds(first);
      if (copy.type === 'popup') b.insertNode(copy, null, current.body.length);
      else b.insertNode(copy, parentId, index);
      select(copy.id);
      return true;
    }
    const res = insertClonesAt(current.body, nodes, parentId, index);
    b.replaceDocument({ ...current, body: res.body });
    select(res.ids[0] ?? null);
    return true;
  };

  /**
   * Pastes a clipboard entry (default: the newest). After the target (inside
   * when it is an empty container or `inside`), else at the end of the scope.
   * A whole page always goes to the end of the page.
   */
  const pasteBlock = async (
    targetId: string | null,
    mode: 'after' | 'inside' = 'after',
    entry?: ClipEntry,
  ) => {
    if (!editable) return;
    let clip = entry ?? null;
    if (!clip) {
      const fresh = await clipboard.refresh();
      clip = fresh ? (fresh[0] ?? null) : latestClip;
    }
    if (!clip) {
      toast.error(t('landing.editor.clipboardEmpty'));
      return;
    }
    const current = doc;
    if (clip.nodes.length > 1) {
      if (editingPopupId) setEditingPopupId(null);
      if (insertClipNodes(clip.nodes, null, current.body.length))
        toast.success(t('landing.editor.pastedMany', { count: clip.nodes.length }), {
          description: describeClip(clip),
        });
      return;
    }
    const target = targetId ? findNode(current.body, targetId) : null;
    const inside =
      target && isContainerType(target.type) && (mode === 'inside' || target.children.length === 0);
    let ok: boolean;
    if (target && inside) ok = insertClipNodes(clip.nodes, target.id, target.children.length);
    else if (target) {
      const loc = locateNode(current.body, target.id);
      if (!loc) return;
      ok = insertClipNodes(clip.nodes, loc.parentId, loc.index + 1);
    } else {
      const popup = editingPopupId ? findNode(current.body, editingPopupId) : null;
      ok = insertClipNodes(
        clip.nodes,
        editingPopupId,
        popup ? popup.children.length : current.body.length,
      );
    }
    if (ok)
      toast.success(t('landing.editor.pasted', { name: clip.label }), {
        description: describeClip(clip),
      });
  };

  const copyStyle = (id: string) => {
    const node = findNode(doc.body, id);
    if (!node) return;
    if (!styleClipboard.copyStyle(node)) {
      toast.error(t('landing.editor.copyFailed'));
      return;
    }
    toast.success(t('landing.editor.styleCopied'));
  };

  const pasteStyle = (id: string) => {
    const clip = readStyleClip();
    const target = findNode(doc.body, id);
    if (!clip || !target) {
      toast.error(t('landing.editor.clipboardEmpty'));
      return;
    }
    // Same type: everything. Different type: only style keys the target knows.
    const validKeys = new Set(
      sectionsForType(target.type)
        .flatMap((s) => s.controls)
        .filter((c) => c.group === 'style')
        .map((c) => c.key),
    );
    const styles = clip.styles
      .map((v) => ({
        ...v,
        props:
          clip.type === target.type
            ? { ...v.props }
            : Object.fromEntries(Object.entries(v.props).filter(([k]) => validKeys.has(k))),
      }))
      .filter((v) => Object.keys(v.props).length > 0);
    b.replaceNode(id, { ...target, styles });
    toast.success(
      clip.type === target.type
        ? t('landing.editor.stylePasted')
        : t('landing.editor.stylePastedPartial'),
    );
  };

  /** Before a context menu opens: fresh entries for its paste items. */
  const refresh = () => {
    void clipboard.refresh();
    styleClipboard.refresh();
  };

  return {
    clipboard,
    latestClip,
    hasStyle: styleClipboard.style !== null,
    tray: { open: trayOpen, highlightId: trayHighlight, setOpen: setTray },
    refresh,
    clipLabelOf,
    describeClip,
    copyBlock,
    copyPage,
    insertClipNodes,
    pasteBlock,
    copyStyle,
    pasteStyle,
  };
}

export type ClipboardActions = ReturnType<typeof useClipboardActions>;
