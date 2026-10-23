import {
  cloneNodeWithNewIds,
  findNode,
  getStyleValue,
  getWidgetDef,
  isContainerType,
  listAnchors,
  listPopups,
  locateNode,
  sectionsForType,
  setStyleValue,
  type BuilderDocument,
  type ElementNode,
} from '@amable/builder';
import { cn, DashboardConfirmDialog, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Spinner } from '@amable/ui/ui/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  Check,
  ClipboardCopy,
  ClipboardPaste,
  CloudOff,
  ExternalLink,
  Eye,
  Layers,
  LayoutGrid,
  Library,
  Maximize2,
  Minimize2,
  Redo2,
  Rocket,
  Save,
  Settings,
  SquareStack,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { EditLockBanner } from '../../../lib/edit-lock/edit-lock-banner';
import { editLockPath, useEditLock, type EditLockStatus } from '../../../lib/edit-lock/use-edit-lock';
import { errorMessage, landingKeys, useLanding, usePage, usePermissions } from '../api/hooks';
import type { LandingPage, LandingPageWithDraft } from '../api/types';
import { Choice, PageState, Pill } from '../components/common';
import { useLandingChrome } from '../components/page-chrome';
import { PublishDialog } from '../components/publish';
import { CanvasPreview, type ColumnResize } from '../editor/canvas-preview';
import { ControlsPanel } from '../editor/controls-panel';
import { Navigator } from '../editor/navigator';
import { Palette } from '../editor/palette';
import { PopupsDialog } from '../editor/popups-dialog';
import { PreviewDialog } from '../editor/preview-dialog';
import { SavedSectionsPicker, SaveSectionDialog } from '../editor/saved-sections';
import { TokensPanel } from '../editor/tokens-panel';
import { clipAge, countNodes, readBlockClip, readStyleClip, useBlockClipboard, type BlockClip } from '../hooks/use-block-clipboard';
import { useBuilderDocument, type SaveState } from '../hooks/use-builder-document';
import { useCanvasDnd } from '../hooks/use-canvas-dnd';
import { useBuilderLabel } from '../lib/builder-i18n';
import { breakpointForWidth, DEVICES, ZOOMS, type CanvasZoom, type DeviceKey } from '../lib/devices';

export function CanvasEditorPage() {
  const { pageId = '' } = useParams({ strict: false }) as { pageId?: string };
  const page = usePage(pageId);
  useLandingChrome(pageId, page.data, 'editor');
  return (
    <PageState isPending={page.isPending} error={page.error}>
      {() => (page.data ? <Editor key={page.data.id} initial={page.data} meta={page.data} /> : null)}
    </PageState>
  );
}

/** Root → node chain (inclusive), for the parents breadcrumb. */
function nodeChain(body: ElementNode[], id: string): ElementNode[] {
  const walk = (nodes: ElementNode[], trail: ElementNode[]): ElementNode[] | null => {
    for (const n of nodes) {
      const next = [...trail, n];
      if (n.id === id) return next;
      const deep = walk(n.children, next);
      if (deep) return deep;
    }
    return null;
  };
  return walk(body, []) ?? [];
}

function typingInField(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable;
}

function SaveIndicator({ state, dirty, editable }: { state: SaveState; dirty: boolean; editable: boolean }) {
  const { t } = useI18n();
  if (!editable) return null;
  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
        <Spinner className="size-3" /> {t('landing.editor.saving')}
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive" role="status">
        <CloudOff aria-hidden className="size-3.5" /> {t('landing.editor.saveFailed')}
      </span>
    );
  }
  if (dirty) return <span className="text-xs text-muted-foreground" role="status">{t('landing.editor.unsaved')}</span>;
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
      <Check aria-hidden className="size-3.5" /> {t('landing.editor.allSaved')}
    </span>
  );
}

interface ContextMenuState {
  id: string;
  x: number;
  y: number;
  /** Selection before the right click (the canvas re-targets the node under the cursor). */
  prevSelectedId?: string | null;
}

function Editor({ initial, meta }: { initial: LandingPageWithDraft; meta: LandingPage }) {
  const { t } = useI18n();
  const label = useBuilderLabel();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lock = useEditLock(can('pages:write') ? editLockPath(slug, 'pages', initial.id) : null, {
    onLost: (holder) =>
      toast.warning(holder ? t('common.lock.takenOver', { name: holder.user_name }) : t('common.lock.takenOverSomeone')),
  });
  const editable = lock.canEdit && can('pages:write');

  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const b = useBuilderDocument({
    api,
    page: initial,
    editable,
    onStale: () => {
      toast.warning(t('landing.editor.staleReloaded'));
      void reloadRef.current();
    },
    onLocked: () => toast.warning(t('common.lock.lost')),
  });
  const reload = useCallback(async () => {
    try {
      const fresh = await api.pages.get(initial.id);
      queryClient.setQueryData(landingKeys.page(slug, initial.id), fresh);
      b.reset(fresh);
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  }, [api, initial.id, queryClient, slug, b, t]);
  reloadRef.current = reload;

  // Gaining the lock: start from the latest server draft (someone else may have edited it).
  const prevLock = useRef<EditLockStatus>(lock.status);
  useEffect(() => {
    const prev = prevLock.current;
    prevLock.current = lock.status;
    if (lock.status === 'holder' && prev !== 'holder' && !b.dirty) void reloadRef.current();
  }, [lock.status, b.dirty]);

  // While waiting behind another editor, keep the read-only canvas fresh.
  useEffect(() => {
    if (lock.status !== 'waiting') return undefined;
    const timer = window.setInterval(() => void reloadRef.current(), 15_000);
    return () => window.clearInterval(timer);
  }, [lock.status]);

  const [deviceKey, setDeviceKey] = useState<DeviceKey>('desktop');
  const [zoom, setZoom] = useState<CanvasZoom>('fit');
  const device = DEVICES.find((d) => d.key === deviceKey) ?? DEVICES[0];
  const breakpoint = breakpointForWidth(device.width);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leftTab, setLeftTab] = useState<'widgets' | 'tree'>('widgets');
  const [rightMode, setRightMode] = useState<'element' | 'design'>('element');
  const [fullView, setFullView] = useState(false);
  const [editingPopupId, setEditingPopupId] = useState<string | null>(null);
  const [showPopups, setShowPopups] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [savingSection, setSavingSection] = useState<ElementNode | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ElementNode | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const clipboard = useBlockClipboard();

  const doc = b.doc;
  const selected = selectedId ? findNode(doc.body, selectedId) : null;
  const titleOf = useCallback((type: string) => label(getWidgetDef(type)?.title) || type, [label]);

  // Popup scope: editing a popup shows only that popup; otherwise popups are hidden.
  const editingPopup = editingPopupId ? findNode(doc.body, editingPopupId) : null;
  const scopeBody = useMemo(
    () => (editingPopup ? [editingPopup] : doc.body.filter((n) => n.type !== 'popup')),
    [doc.body, editingPopup],
  );
  const previewDoc = useMemo<BuilderDocument>(() => ({ ...doc, body: scopeBody }), [doc, scopeBody]);
  const popupList = listPopups(doc.body);
  const scopeRef = useRef(scopeBody);
  scopeRef.current = scopeBody;

  useEffect(() => {
    if (editingPopupId && !findNode(doc.body, editingPopupId)) {
      setEditingPopupId(null);
      setSelectedId(null);
    }
  }, [editingPopupId, doc.body]);

  useEffect(() => {
    if (selectedId && !findNode(doc.body, selectedId)) setSelectedId(null);
  }, [selectedId, doc.body]);

  useLayoutEffect(() => {
    const el = ctxMenuRef.current;
    if (!el || !ctxMenu) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(8, Math.min(ctxMenu.x, window.innerWidth - r.width - 8));
    const ny = Math.max(8, Math.min(ctxMenu.y, window.innerHeight - r.height - 8));
    if (nx !== ctxMenu.x || ny !== ctxMenu.y) setCtxMenu({ ...ctxMenu, x: nx, y: ny });
  }, [ctxMenu]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setRightMode('element');
  }, []);

  const parentForInsert = useCallback((): string | null => {
    if (selected && findNode(scopeBody, selected.id)) {
      if (isContainerType(selected.type)) return selected.id;
      return locateNode(scopeBody, selected.id)?.parentId ?? editingPopupId;
    }
    return scopeBody.find((n) => isContainerType(n.type))?.id ?? editingPopupId;
  }, [selected, scopeBody, editingPopupId]);

  const onAdd = (type: string) => {
    if (!editable || type === 'popup') return;
    select(b.addNode(type, parentForInsert()));
  };

  const dnd = useCanvasDnd({
    iframeRef,
    getBody: () => scopeRef.current,
    labelOf: titleOf,
    addNode: b.addNode,
    moveNode: b.moveNode,
    onAdded: select,
    disabled: !editable,
  });

  const moveWithinParent = (id: string, dir: -1 | 1) => {
    const loc = locateNode(doc.body, id);
    if (!loc || loc.index + dir < 0) return;
    b.moveNode(id, loc.parentId, loc.index + dir);
  };

  const requestDelete = (id: string) => {
    if (!editable) return;
    const node = findNode(doc.body, id);
    if (node) setPendingDelete(node);
  };

  const confirmDelete = () => {
    const node = pendingDelete;
    setPendingDelete(null);
    if (!node) return;
    b.removeNode(node.id);
    if (selectedId === node.id) setSelectedId(null);
    toast.message(t('landing.editor.deleted'), {
      description: t('landing.editor.undoHint'),
      action: { label: t('landing.editor.undo'), onClick: () => b.undo() },
    });
  };

  const duplicate = (id: string) => {
    const nid = b.duplicateNode(id);
    if (nid) select(nid);
  };

  /** "Container (14 elementi)" — the toast/menu label for one node. */
  const clipLabelOf = (node: ElementNode): string => {
    const inner = countNodes(node.children);
    return inner > 0 ? t('landing.editor.blockLabel', { name: titleOf(node.type), count: inner }) : titleOf(node.type);
  };

  /** Menu entry description: label + source page + age. */
  const describeClip = (clip: BlockClip): string => {
    const from = clip.sourcePageName ? ` — ${t('landing.editor.fromPage', { name: clip.sourcePageName })}` : '';
    const age = clipAge(clip.copiedAt);
    return `${clip.label}${from}${age ? `, ${age}` : ''}`;
  };

  const copyBlock = (id: string) => {
    const node = findNode(doc.body, id);
    if (!node) return;
    const label = clipLabelOf(node);
    if (!clipboard.copyNodes([node], { label, wholePage: false, sourcePageName: meta.title })) {
      toast.error(t('landing.editor.copyFailed'));
      return;
    }
    toast.success(t('landing.editor.copied', { name: label }));
  };

  /** Copies every root block of the page (popups included), in order. */
  const copyPage = () => {
    if (doc.body.length === 0) {
      toast.error(t('landing.editor.pageEmpty'));
      return;
    }
    const label = t('landing.editor.pageLabel', { name: meta.title || t('landing.untitled'), count: doc.body.length });
    if (!clipboard.copyNodes(doc.body, { label, wholePage: true, sourcePageName: meta.title })) {
      toast.error(t('landing.editor.copyFailed'));
      return;
    }
    toast.success(t('landing.editor.copied', { name: label }));
  };

  /** Pastes after the target (inside when it is an empty container or `inside`), else at the end of the scope. */
  const pasteBlock = (targetId: string | null, mode: 'after' | 'inside' = 'after') => {
    if (!editable) return;
    const clip = readBlockClip();
    clipboard.refresh();
    if (!clip) {
      toast.error(t('landing.editor.clipboardEmpty'));
      return;
    }
    if (clip.nodes.length > 1) {
      // Whole page: append every block at the end in ONE operation, so a
      // single undo reverts the whole paste.
      const copies = clip.nodes.map(cloneNodeWithNewIds);
      if (editingPopupId) {
        setEditingPopupId(null);
      }
      b.replaceDocument({ ...doc, body: [...doc.body, ...copies] });
      select(copies[0]?.id ?? null);
      toast.success(t('landing.editor.pastedMany', { count: copies.length }), { description: describeClip(clip) });
      return;
    }
    const first = clip.nodes[0];
    if (!first) return;
    const copy = cloneNodeWithNewIds(first);
    const target = targetId ? findNode(doc.body, targetId) : null;
    const inside = target && isContainerType(target.type) && (mode === 'inside' || target.children.length === 0);
    if (copy.type === 'popup') b.insertNode(copy, null, doc.body.length);
    else if (target && inside) b.insertNode(copy, target.id, target.children.length);
    else if (target) {
      const loc = locateNode(doc.body, target.id);
      if (!loc) return;
      b.insertNode(copy, loc.parentId, loc.index + 1);
    } else b.insertNode(copy, editingPopupId, editingPopupId ? undefined : doc.body.length);
    select(copy.id);
    toast.success(t('landing.editor.pasted', { name: clip.label }), { description: describeClip(clip) });
  };

  const copyStyle = (id: string) => {
    const node = findNode(doc.body, id);
    if (!node) return;
    if (!clipboard.copyStyle(node)) {
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
        props: clip.type === target.type ? { ...v.props } : Object.fromEntries(Object.entries(v.props).filter(([k]) => validKeys.has(k))),
      }))
      .filter((v) => Object.keys(v.props).length > 0);
    b.replaceNode(id, { ...target, styles });
    toast.success(clip.type === target.type ? t('landing.editor.stylePasted') : t('landing.editor.stylePastedPartial'));
  };

  const insertSection = (node: ElementNode) => {
    if (!editable) return;
    const container = selected && isContainerType(selected.type) ? selected.id : (scopeBody.find((n) => isContainerType(n.type))?.id ?? editingPopupId);
    b.insertNode(node, container);
    select(node.id);
  };

  /** Column resize: writes `_width` % on both columns for the current breakpoint and clears `_flexGrow`. */
  const commitColumnResize = (r: ColumnResize) => {
    if (!editable) return;
    for (const [id, pct] of [
      [r.leftId, r.leftPct],
      [r.rightId, r.rightPct],
    ] as const) {
      const node = findNode(doc.body, id);
      if (!node) continue;
      let next = setStyleValue(node, '_width', { size: pct, unit: '%' }, breakpoint, 'normal');
      const grow = getStyleValue(next, '_flexGrow', breakpoint, 'normal') as { size?: number } | undefined;
      if (grow && typeof grow.size === 'number' && grow.size > 0) next = setStyleValue(next, '_flexGrow', { size: 0, unit: '' }, breakpoint, 'normal');
      b.replaceNode(id, next);
    }
  };

  const createPopup = () => {
    if (!editable) return;
    const nid = b.addNode('popup', null);
    setEditingPopupId(nid);
    select(nid);
    setShowPopups(false);
  };

  const openCtxMenu = (id: string, x: number, y: number, prevSelectedId?: string | null) => {
    clipboard.refresh();
    setCtxMenu({ id, x, y, prevSelectedId });
  };

  const actions = useRef({ requestDelete, moveWithinParent, copyBlock, pasteBlock, duplicate });
  actions.current = { requestDelete, moveWithinParent, copyBlock, pasteBlock, duplicate };

  /** Shortcuts pressed while focus is INSIDE the canvas iframe (forwarded by the overlay). */
  const onShortcut = useCallback((action: 'copy' | 'paste' | 'duplicate' | 'undo' | 'redo') => {
    const a = actions.current;
    const sel = selectedRef.current;
    if (action === 'undo') bRef.current.undo();
    else if (action === 'redo') bRef.current.redo();
    else if (action === 'paste') a.pasteBlock(sel);
    else if (sel && action === 'copy') a.copyBlock(sel);
    else if (sel && action === 'duplicate') a.duplicate(sel);
  }, []);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const bRef = useRef(b);
  bRef.current = b;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = actions.current;
      const b = bRef.current;
      const sel = selectedRef.current;
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          if (typingInField()) return;
          e.preventDefault();
          b.undo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          if (typingInField()) return;
          e.preventDefault();
          b.redo();
        } else if (key === 's') {
          e.preventDefault();
          void b.saveNow();
        } else if (key === 'd' && sel && !typingInField()) {
          e.preventDefault();
          a.duplicate(sel);
        } else if (key === 'c' && sel && !typingInField() && !window.getSelection()?.toString()) {
          a.copyBlock(sel);
        } else if (key === 'v' && !typingInField()) {
          a.pasteBlock(sel);
        }
        return;
      }
      if (typingInField() || !sel) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        a.requestDelete(sel);
      } else if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        a.moveWithinParent(sel, -1);
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        a.moveWithinParent(sel, 1);
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ctxNode = ctxMenu ? findNode(doc.body, ctxMenu.id) : null;
  const ctxItems: { id: string; label: string; sub?: string; run: () => void; danger?: boolean }[] = ctxNode
    ? [
        { id: 'up', label: t('landing.editor.moveUp'), run: () => moveWithinParent(ctxNode.id, -1) },
        { id: 'down', label: t('landing.editor.moveDown'), run: () => moveWithinParent(ctxNode.id, 1) },
        { id: 'dup', label: t('landing.editor.duplicate'), run: () => duplicate(ctxNode.id) },
        { id: 'copy', label: t('landing.editor.copy'), run: () => copyBlock(ctxNode.id) },
        // The canvas right click targets the node UNDER THE CURSOR: when a
        // different element was selected (e.g. a container picked from the
        // tree) it stays copiable without re-selecting it.
        ...(() => {
          const prevId = ctxMenu?.prevSelectedId;
          const prev = prevId && prevId !== ctxNode.id ? findNode(doc.body, prevId) : null;
          return prev ? [{ id: 'copySel', label: t('landing.editor.copySelected', { name: clipLabelOf(prev) }), run: () => copyBlock(prev.id) }] : [];
        })(),
        { id: 'copyPage', label: t('landing.editor.copyPage'), run: copyPage },
        ...(clipboard.block
          ? clipboard.block.nodes.length > 1
            ? [{ id: 'pasteEnd', label: t('landing.editor.pasteAtEnd', { count: clipboard.block.nodes.length }), sub: describeClip(clipboard.block), run: () => pasteBlock(null) }]
            : [
                { id: 'paste', label: t('landing.editor.pasteAfter', { name: clipboard.block.label }), sub: describeClip(clipboard.block), run: () => pasteBlock(ctxNode.id) },
                ...(isContainerType(ctxNode.type)
                  ? [{ id: 'pasteIn', label: t('landing.editor.pasteInside', { name: clipboard.block.label }), sub: describeClip(clipboard.block), run: () => pasteBlock(ctxNode.id, 'inside') }]
                  : []),
              ]
          : []),
        { id: 'copyStyle', label: t('landing.editor.copyStyle'), run: () => copyStyle(ctxNode.id) },
        ...(clipboard.style ? [{ id: 'pasteStyle', label: t('landing.editor.pasteStyle'), run: () => pasteStyle(ctxNode.id) }] : []),
        { id: 'save', label: t('landing.sections.save'), run: () => setSavingSection(ctxNode) },
        { id: 'lock', label: ctxNode.locked ? t('landing.editor.unlock') : t('landing.editor.lock'), run: () => b.toggleLock(ctxNode.id) },
        { id: 'delete', label: t('landing.editor.delete'), run: () => requestDelete(ctxNode.id), danger: true },
      ]
    : [];

  const canPublish = can('pages:publish');
  const publicUrl = meta.status === 'published' ? meta.public_url : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="canvas-editor">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={t('landing.editor.backToList')}
          aria-label={t('landing.editor.backToList')}
          onClick={() => void navigate({ to: '/t/$tenant/landing-pages', params: { tenant: slug } })}
          data-testid="editor-back"
        >
          <ArrowLeft aria-hidden /> <span className="hidden lg:inline">{t('nav.landingPages')}</span>
        </Button>
        <div className="flex min-w-0 max-w-64 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{meta.title || t('landing.untitled')}</span>
          <code className="truncate text-[11px] text-muted-foreground">{meta.path}</code>
        </div>
        <Pill tone={meta.status === 'published' ? 'success' : 'neutral'}>{t(`landing.status.${meta.status}`)}</Pill>
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon" aria-label={t('landing.editor.undo')} title={t('landing.editor.undo')} disabled={!b.canUndo} onClick={b.undo}>
            <Undo2 aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={t('landing.editor.redo')} title={t('landing.editor.redo')} disabled={!b.canRedo} onClick={b.redo}>
            <Redo2 aria-hidden />
          </Button>
        </div>
        <Choice
          className="h-8 w-44 text-xs"
          value={deviceKey}
          options={DEVICES.map((d) => ({ value: d.key, label: `${t(`landing.device.${d.key}`)} · ${String(d.width)}` }))}
          onChange={(value) => setDeviceKey((DEVICES.find((d) => d.key === value)?.key ?? 'desktop'))}
        />
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-medium',
            breakpoint === 'desktop' ? 'bg-muted text-muted-foreground' : 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
          )}
          title={t('landing.editor.breakpointHint')}
        >
          {t(`landing.device.${breakpoint}`)}
        </span>
        <Choice
          className="h-8 w-24 text-xs"
          value={zoom === 'fit' ? 'fit' : String(zoom * 100)}
          options={ZOOMS.map((z) => ({ value: z.key, label: z.value === 'fit' ? t('landing.editor.zoomFit') : `${z.key}%` }))}
          onChange={(value) => setZoom(ZOOMS.find((z) => z.key === value)?.value ?? 'fit')}
        />
        <Button
          type="button"
          variant={fullView ? 'secondary' : 'ghost'}
          size="icon"
          aria-label={fullView ? t('landing.editor.showPanels') : t('landing.editor.fullView')}
          title={fullView ? t('landing.editor.showPanels') : t('landing.editor.fullView')}
          onClick={() => setFullView((v) => !v)}
        >
          {fullView ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t('landing.editor.copyPage')} title={t('landing.editor.copyPage')} onClick={copyPage}>
          <ClipboardCopy aria-hidden />
        </Button>
        {clipboard.block ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('landing.editor.pasteAtEnd', { count: clipboard.block.nodes.length })}
            title={`${t('landing.editor.pasteAtEnd', { count: clipboard.block.nodes.length })} — ${describeClip(clipboard.block)}`}
            disabled={!editable}
            onClick={() => pasteBlock(null)}
          >
            <ClipboardPaste aria-hidden />
          </Button>
        ) : null}
        <Button type="button" variant={editingPopupId ? 'secondary' : 'outline'} size="sm" onClick={() => setShowPopups(true)}>
          <SquareStack aria-hidden /> {t('landing.popups.button', { count: popupList.length })}
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SaveIndicator state={b.saveState} dirty={b.dirty} editable={editable} />
          {editable ? (
            <Button type="button" variant="ghost" size="icon" aria-label={t('landing.editor.saveNow')} title={t('landing.editor.saveNow')} disabled={!b.dirty || b.saveState === 'saving'} onClick={() => void b.saveNow()}>
              <Save aria-hidden />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('landing.action.settings')}
            title={t('landing.action.settings')}
            onClick={() => void navigate({ to: '/t/$tenant/landing-pages/$pageId/settings', params: { tenant: slug, pageId: meta.id } })}
          >
            <Settings aria-hidden />
          </Button>
          {publicUrl ? (
            <Button asChild variant="ghost" size="icon" aria-label={t('landing.action.viewLive')} title={t('landing.action.viewLive')}>
              <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void b.saveNow().then(() => setShowPreview(true));
            }}
          >
            <Eye aria-hidden /> {t('landing.preview.button')}
          </Button>
          {canPublish ? (
            <Button type="button" size="sm" disabled={!editable} onClick={() => setPublishing(true)}>
              <Rocket aria-hidden /> {t('landing.publish.action')}
            </Button>
          ) : null}
        </div>
      </div>

      <EditLockBanner lock={lock} canTakeover={canPublish} />

      <div className={cn('grid min-h-0 flex-1 gap-0', fullView ? 'grid-cols-1' : 'grid-cols-[260px_minmax(0,1fr)_320px]')}>
        <aside className={cn('flex min-h-0 flex-col overflow-hidden border-r', fullView && 'hidden')}>
          <div className="flex border-b text-sm" role="tablist">
            {(
              [
                ['widgets', LayoutGrid, 'landing.editor.widgets'],
                ['tree', Layers, 'landing.editor.structure'],
              ] as const
            ).map(([value, Icon, key]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={leftTab === value}
                className={cn('flex flex-1 items-center justify-center gap-1.5 py-2', leftTab === value ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}
                onClick={() => setLeftTab(value)}
              >
                <Icon aria-hidden className="size-4" /> {t(key)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {leftTab === 'widgets' ? (
              <>
                <Button type="button" variant="outline" size="sm" className="mb-2 w-full" disabled={!editable} onClick={() => setShowLibrary(true)}>
                  <Library aria-hidden /> {t('landing.sections.title')}
                </Button>
                <Palette disabled={!editable} onAdd={onAdd} onStartDrag={(type) => dnd.startDrag({ kind: 'new', type })} />
              </>
            ) : (
              <Navigator
                body={scopeBody}
                selectedId={selectedId}
                disabled={!editable}
                onSelect={select}
                onMove={b.moveNode}
                onDuplicate={duplicate}
                onCopy={copyBlock}
                onToggleLock={b.toggleLock}
                onDelete={requestDelete}
                onContextMenu={openCtxMenu}
              />
            )}
          </div>
        </aside>

        <section className="relative flex min-h-0 flex-col overflow-hidden" aria-label={t('landing.editor.canvas')}>
          {editingPopupId ? (
            <div className="flex items-center justify-between gap-2 border-b bg-primary/5 px-3 py-2 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <SquareStack aria-hidden className="size-4 text-primary" />
                {t('landing.popups.editing', { name: popupList.find((p) => p.id === editingPopupId)?.name ?? '' })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditingPopupId(null);
                  setSelectedId(null);
                }}
              >
                <ArrowLeft aria-hidden /> {t('landing.popups.back')}
              </Button>
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <CanvasPreview
              doc={previewDoc}
              pageId={meta.id}
              tenantSlug={slug}
              deviceWidth={device.width}
              zoom={zoom}
              selectedId={selectedId}
              iframeRef={iframeRef}
              onSelectNode={select}
              onStartMove={(id) => dnd.startDrag({ kind: 'move', nodeId: id })}
              onDelete={requestDelete}
              onResize={commitColumnResize}
              onShortcut={onShortcut}
              onContextMenu={(id, x, y) => {
                const prev = selectedRef.current;
                select(id);
                openCtxMenu(id, x, y, prev);
              }}
            />
            {selected ? (
              <nav
                aria-label={t('landing.editor.breadcrumb')}
                className="absolute right-0 bottom-0 left-0 z-10 flex items-center gap-0.5 overflow-x-auto border-t bg-background/95 px-2 py-1 text-xs backdrop-blur"
              >
                <button type="button" className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted" onClick={() => setSelectedId(null)}>
                  {t('landing.editor.page')}
                </button>
                {nodeChain(scopeBody, selected.id).map((n) => (
                  <span key={n.id} className="flex items-center gap-0.5 whitespace-nowrap">
                    <span className="text-muted-foreground">›</span>
                    <button
                      type="button"
                      className={cn('rounded px-1.5 py-0.5 hover:bg-muted', n.id === selected.id ? 'bg-primary/10 font-semibold text-primary' : 'text-muted-foreground')}
                      onClick={() => setSelectedId(n.id)}
                    >
                      {titleOf(n.type)}
                    </button>
                  </span>
                ))}
              </nav>
            ) : null}
          </div>
        </section>

        <aside className={cn('flex min-h-0 flex-col overflow-hidden border-l', fullView && 'hidden')}>
          <div className="flex border-b text-sm" role="tablist">
            {(['element', 'design'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={rightMode === mode}
                className={cn('flex-1 py-2', rightMode === mode ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}
                onClick={() => setRightMode(mode)}
              >
                {t(`landing.editor.right.${mode}`)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {rightMode === 'design' ? (
              <TokensPanel tokens={doc.tokens} disabled={!editable} onChange={b.patchTokens} />
            ) : selected ? (
              <ControlsPanel
                key={selected.id}
                node={selected}
                breakpoint={breakpoint}
                popups={popupList}
                anchors={listAnchors(doc.body)}
                disabled={!editable}
                onUpdateSettings={(patch) => b.updateSettings(selected.id, patch)}
                onSetStyle={(key, value, bp, st) => b.setStyle(selected.id, key, value, bp, st)}
                onToggleLock={() => b.toggleLock(selected.id)}
                onDuplicate={() => duplicate(selected.id)}
                onCopy={() => copyBlock(selected.id)}
                onRemove={() => requestDelete(selected.id)}
                onSaveSection={() => setSavingSection(selected)}
              />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">{t('landing.editor.selectHint')}</p>
            )}
          </div>
          {lock.status === 'holder' ? (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
              <span>{t('landing.lock.holding')}</span>
            </div>
          ) : null}
        </aside>
      </div>

      {dnd.outline ? (
        <div
          className="pointer-events-none fixed z-[59] rounded-md"
          style={{
            left: dnd.outline.left,
            top: dnd.outline.top,
            width: dnd.outline.width,
            height: dnd.outline.height,
            outline: '1.5px dashed rgba(37,99,235,0.6)',
            outlineOffset: -1.5,
            background: 'rgba(37,99,235,0.04)',
          }}
        />
      ) : null}
      {dnd.indicator ? (
        <div
          className="pointer-events-none fixed z-[60] rounded"
          style={
            dnd.indicator.type === 'box'
              ? {
                  left: dnd.indicator.left,
                  top: dnd.indicator.top,
                  width: dnd.indicator.width,
                  height: dnd.indicator.height,
                  outline: '2px solid #2563eb',
                  background: 'rgba(37,99,235,0.10)',
                }
              : dnd.indicator.type === 'h'
                ? { left: dnd.indicator.left, top: dnd.indicator.top, width: dnd.indicator.width, height: 4, background: '#2563eb', boxShadow: '0 0 0 1px rgba(255,255,255,0.9)' }
                : { left: dnd.indicator.left, top: dnd.indicator.top, width: 4, height: dnd.indicator.height, background: '#2563eb', boxShadow: '0 0 0 1px rgba(255,255,255,0.9)' }
          }
        />
      ) : null}
      {dnd.chip ? (
        <div
          className="pointer-events-none fixed z-[61] flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-white shadow-lg"
          style={{ left: dnd.chip.x + 14, top: dnd.chip.y + 14, background: dnd.chip.valid ? '#2563eb' : '#94a3b8' }}
        >
          {dnd.chip.label}
          {!dnd.chip.valid ? <span className="font-normal opacity-80">— {t('landing.editor.dropNotAllowed')}</span> : null}
        </div>
      ) : null}

      {ctxMenu && ctxNode ? (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            ref={ctxMenuRef}
            role="menu"
            className="fixed z-50 w-72 overflow-hidden rounded-md border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
          >
            <div className="border-b px-3 pt-1 pb-1.5 text-xs text-muted-foreground">
              {t('landing.editor.ctxTarget')} <span className="font-semibold text-foreground">{clipLabelOf(ctxNode)}</span>
            </div>
            {ctxItems.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={!editable}
                className={cn('block w-full truncate px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50', item.danger && 'text-destructive')}
                onClick={() => {
                  item.run();
                  setCtxMenu(null);
                }}
              >
                <span className="block truncate">{item.label}</span>
                {item.sub ? <span className="block truncate text-xs text-muted-foreground">{item.sub}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <DashboardConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? undefined : setPendingDelete(null))}
        title={t('landing.editor.deleteTitle', { name: pendingDelete ? titleOf(pendingDelete.type) : '' })}
        description={
          pendingDelete && pendingDelete.children.length > 0
            ? t('landing.editor.deleteBodyChildren', { count: pendingDelete.children.length })
            : t('landing.editor.deleteBody')
        }
        confirmLabel={t('landing.editor.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={confirmDelete}
      />
      {showPopups ? (
        <PopupsDialog
          popups={popupList}
          disabled={!editable}
          onCreate={createPopup}
          onEdit={(id) => {
            setEditingPopupId(id);
            select(id);
            setShowPopups(false);
            setFullView(false);
          }}
          onRename={(id, name) => b.updateSettings(id, { name })}
          onDelete={(id) => {
            if (editingPopupId === id) setEditingPopupId(null);
            b.removeNode(id);
          }}
          onClose={() => setShowPopups(false)}
        />
      ) : null}
      {showLibrary ? <SavedSectionsPicker disabled={!editable} onClose={() => setShowLibrary(false)} onInsert={insertSection} /> : null}
      {savingSection ? <SaveSectionDialog node={savingSection} onClose={() => setSavingSection(null)} /> : null}
      {showPreview ? <PreviewDialog pageId={meta.id} onClose={() => setShowPreview(false)} /> : null}
      {publishing ? (
        <PublishDialog
          page={meta}
          beforePublish={() => b.saveNow()}
          onClose={() => setPublishing(false)}
        />
      ) : null}
    </div>
  );
}
