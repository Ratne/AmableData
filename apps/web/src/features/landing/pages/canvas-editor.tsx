import {
  findNode,
  getStyleValue,
  getWidgetDef,
  isContainerType,
  listAnchors,
  listPopups,
  locateNode,
  setStyleValue,
  type BuilderDocument,
  type ElementNode,
} from '@amable/builder';
import { cn, DashboardConfirmDialog, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ArrowLeft, Layers, LayoutGrid, Library, SquareStack } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { EditLockBanner } from '../../../lib/edit-lock/edit-lock-banner';
import { editLockPath, useEditLock, type EditLockStatus } from '../../../lib/edit-lock/use-edit-lock';
import { errorMessage, landingKeys, useLanding, usePage, usePermissions } from '../api/hooks';
import { isCanvasPage, isHtmlPage, type CanvasPageWithDraft, type LandingPage } from '../api/types';
import { PageState } from '../components/common';
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
import { CtxMenu, type ContextMenuState, type CtxMenuItem } from '../editor/context-menu';
import { DragOverlay } from '../editor/drag-overlay';
import { EditorToolbar } from '../editor/editor-toolbar';
import { useClipboardActions } from '../hooks/use-clipboard-actions';
import { useBuilderDocument } from '../hooks/use-builder-document';
import { useCanvasDnd } from '../hooks/use-canvas-dnd';
import { useBuilderLabel } from '../lib/builder-i18n';
import {
  breakpointForWidth,
  DEVICES,
  type CanvasZoom,
  type DeviceKey,
} from '../lib/devices';
import { HtmlEditor } from './html-editor';

export function CanvasEditorPage() {
  const { pageId = '' } = useParams({ strict: false }) as { pageId?: string };
  const page = usePage(pageId);
  useLandingChrome(pageId, page.data, 'editor');
  return (
    <PageState isPending={page.isPending} error={page.error}>
      {() => {
        if (!page.data) return null;
        if (isHtmlPage(page.data)) return <HtmlEditor key={page.data.id} initial={page.data} meta={page.data} />;
        return isCanvasPage(page.data) ? <Editor key={page.data.id} initial={page.data} meta={page.data} /> : null;
      }}
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

function Editor({ initial, meta }: { initial: CanvasPageWithDraft; meta: LandingPage }) {
  const { t } = useI18n();
  const label = useBuilderLabel();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
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
      if (isCanvasPage(fresh)) b.reset(fresh);
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
  const iframeRef = useRef<HTMLIFrameElement>(null);

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

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setRightMode('element');
  }, []);

  const clip = useClipboardActions({ b, editable, pageTitle: meta.title, titleOf, select, editingPopupId, setEditingPopupId });
  const { copyBlock, copyPage, pasteBlock, copyStyle, pasteStyle, clipLabelOf, describeClip, latestClip } = clip;

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
    insertNodes: (nodes, parentId, index) => {
      if (clip.insertClipNodes(nodes, parentId, index) && nodes.length > 1)
        toast.success(t('landing.clipboard.inserted', { count: nodes.length }));
    },
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
    clip.refresh();
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
  const ctxItems: CtxMenuItem[] = ctxNode
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
        ...(latestClip
          ? latestClip.nodes.length > 1
            ? [{ id: 'pasteEnd', label: t('landing.editor.pasteAtEnd', { count: latestClip.nodes.length }), sub: describeClip(latestClip), run: () => pasteBlock(null) }]
            : [
                { id: 'paste', label: t('landing.editor.pasteAfter', { name: latestClip.label }), sub: describeClip(latestClip), run: () => pasteBlock(ctxNode.id) },
                ...(isContainerType(ctxNode.type)
                  ? [{ id: 'pasteIn', label: t('landing.editor.pasteInside', { name: latestClip.label }), sub: describeClip(latestClip), run: () => pasteBlock(ctxNode.id, 'inside') }]
                  : []),
              ]
          : []),
        { id: 'copyStyle', label: t('landing.editor.copyStyle'), run: () => copyStyle(ctxNode.id) },
        ...(clip.hasStyle ? [{ id: 'pasteStyle', label: t('landing.editor.pasteStyle'), run: () => pasteStyle(ctxNode.id) }] : []),
        { id: 'save', label: t('landing.sections.save'), run: () => setSavingSection(ctxNode) },
        { id: 'lock', label: ctxNode.locked ? t('landing.editor.unlock') : t('landing.editor.lock'), run: () => b.toggleLock(ctxNode.id) },
        { id: 'delete', label: t('landing.editor.delete'), run: () => requestDelete(ctxNode.id), danger: true },
      ]
    : [];

  const canPublish = can('pages:publish');

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="canvas-editor">
      <EditorToolbar
        meta={meta}
        slug={slug}
        b={b}
        editable={editable}
        canPublish={canPublish}
        deviceKey={deviceKey}
        onDeviceChange={setDeviceKey}
        breakpoint={breakpoint}
        zoom={zoom}
        onZoomChange={setZoom}
        fullView={fullView}
        onToggleFullView={() => setFullView((v) => !v)}
        clip={clip}
        selectedId={selectedId}
        onDragClip={(entry) => dnd.startDrag({ kind: 'insert', nodes: entry.nodes, label: entry.label })}
        popupCount={popupList.length}
        editingPopup={editingPopupId !== null}
        onOpenPopups={() => setShowPopups(true)}
        onPreview={() => void b.saveNow().then(() => setShowPreview(true))}
        onPublish={() => setPublishing(true)}
      />

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
          </div>
          {/* In flow below the canvas (not an overlay): an absolute bar would
              cover the bottom of the iframe and the end of the page would stay
              hidden even at max scroll. */}
          {selected ? (
            <nav
              aria-label={t('landing.editor.breadcrumb')}
              className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-t bg-background px-2 py-1 text-xs"
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

      <DragOverlay outline={dnd.outline} indicator={dnd.indicator} chip={dnd.chip} />

      {ctxMenu && ctxNode ? (
        <CtxMenu
          menu={ctxMenu}
          onMove={setCtxMenu}
          onClose={() => setCtxMenu(null)}
          header={
            <>
              {t('landing.editor.ctxTarget')} <span className="font-semibold text-foreground">{clipLabelOf(ctxNode)}</span>
            </>
          }
          items={ctxItems}
          disabled={!editable}
        />
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
