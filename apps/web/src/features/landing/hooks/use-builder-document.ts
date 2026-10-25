import {
  applyCanvasOp,
  builderDocumentSchema,
  cloneNodeWithNewIds,
  createNode,
  findNode,
  invertCanvasOp,
  isContainerType,
  locateNode,
  setStyleValue,
  type BuilderDocument,
  type Breakpoint,
  type CanvasOp,
  type ElementNode,
  type ElementState,
} from '@amable/builder';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LandingApiError, type LandingClient } from '../api/client';
import type { CanvasPageWithDraft } from '../api/types';

const HISTORY_LIMIT = 80;
const AUTOSAVE_MS = 1500;

interface HistEntry {
  op: CanvasOp;
  inverse: CanvasOp;
}

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

function parseDraft(page: CanvasPageWithDraft): BuilderDocument {
  const parsed = builderDocumentSchema.safeParse(page.draft);
  return parsed.success ? parsed.data : page.draft;
}

/**
 * Editing state of a canvas document. Every mutation goes through one op
 * pipeline (`applyLocal`), recorded as op + inverse for undo/redo. The draft
 * autosaves (debounced) with `base_revision`; a `409 stale_draft` or
 * `423 locked` answer is reported to the editor, which reloads or goes
 * read-only.
 */
export function useBuilderDocument(options: {
  api: LandingClient;
  page: CanvasPageWithDraft;
  editable: boolean;
  onStale: () => void;
  onLocked: () => void;
}) {
  const { api, page, editable } = options;
  const [doc, setDoc] = useState<BuilderDocument>(() => parseDraft(page));
  const docRef = useRef(doc);
  const [baseline, setBaseline] = useState(() => JSON.stringify(docRef.current));
  const baselineRef = useRef(baseline);
  const revision = useRef(page.draft_revision);
  const past = useRef<HistEntry[]>([]);
  const future = useRef<HistEntry[]>([]);
  const [histTick, setHistTick] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const inFlight = useRef<Promise<boolean> | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  const blocked = useRef(false);

  const dirty = useMemo(() => JSON.stringify(doc) !== baseline, [doc, baseline]);

  /** Replaces the whole state with a server copy (reload after a conflict, lock regained, version restored). */
  const reset = useCallback((next: CanvasPageWithDraft) => {
    const parsed = parseDraft(next);
    docRef.current = parsed;
    revision.current = next.draft_revision;
    past.current = [];
    future.current = [];
    blocked.current = false;
    setDoc(parsed);
    baselineRef.current = JSON.stringify(parsed);
    setBaseline(baselineRef.current);
    setSaveState('idle');
    setHistTick((t) => t + 1);
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current;
    const current = docRef.current;
    const json = JSON.stringify(current);
    if (blocked.current) return false;
    if (json === baselineRef.current) return true;
    setSaveState('saving');
    const run = (async () => {
      try {
        const result = await api.pages.saveDraft(page.id, current, revision.current);
        revision.current = result.draft_revision;
        baselineRef.current = json;
        setBaseline(json);
        setSaveState(JSON.stringify(docRef.current) === json ? 'saved' : 'pending');
        return true;
      } catch (error) {
        setSaveState('error');
        if (error instanceof LandingApiError && error.status === 409 && error.code === 'stale_draft') {
          blocked.current = true;
          callbacks.current.onStale();
        } else if (error instanceof LandingApiError && error.status === 423) {
          blocked.current = true;
          callbacks.current.onLocked();
        }
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [api, page.id]);

  // Debounced autosave while the user holds the lock.
  useEffect(() => {
    if (!editable || !dirty || blocked.current) return undefined;
    setSaveState((s) => (s === 'saving' ? s : 'pending'));
    const timer = window.setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [doc, dirty, editable, saveNow]);

  // Last chance on tab close: a keepalive PUT (best effort, small drafts only).
  useEffect(() => {
    if (!editable) return undefined;
    const onHide = () => {
      const json = JSON.stringify(docRef.current);
      if (json === baselineRef.current || blocked.current || json.length > 60_000) return;
      void api.pages.saveDraft(page.id, docRef.current, revision.current, true).catch(() => undefined);
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(docRef.current) !== baselineRef.current) event.preventDefault();
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('beforeunload', warn);
    };
  }, [api, page.id, editable]);

  const applyLocal = useCallback(
    (op: CanvasOp) => {
      if (!editable) return;
      const prev = docRef.current;
      const inverse = invertCanvasOp(prev, op);
      const next = applyCanvasOp(prev, op);
      if (next === prev) return;
      if (inverse) {
        past.current.push({ op, inverse });
        if (past.current.length > HISTORY_LIMIT) past.current.shift();
        future.current = [];
      }
      docRef.current = next;
      setDoc(next);
      setHistTick((t) => t + 1);
    },
    [editable],
  );

  const undo = useCallback(() => {
    if (!editable) return;
    const entry = past.current.pop();
    if (!entry) return;
    const next = applyCanvasOp(docRef.current, entry.inverse);
    future.current.push(entry);
    docRef.current = next;
    setDoc(next);
    setHistTick((t) => t + 1);
  }, [editable]);

  const redo = useCallback(() => {
    if (!editable) return;
    const entry = future.current.pop();
    if (!entry) return;
    const next = applyCanvasOp(docRef.current, entry.op);
    past.current.push(entry);
    docRef.current = next;
    setDoc(next);
    setHistTick((t) => t + 1);
  }, [editable]);

  const replaceDocument = useCallback((next: BuilderDocument) => applyLocal({ kind: 'replace_document', doc: next }), [applyLocal]);

  const patchTokens = useCallback(
    (patch: Partial<BuilderDocument['tokens']>) => applyLocal({ kind: 'patch_tokens', patch: patch as Record<string, unknown> }),
    [applyLocal],
  );

  /** Inserts an existing node under a parent (null = root body) at an index (default: last). */
  const insertNode = useCallback(
    (node: ElementNode, parentId: string | null, index?: number) => {
      const body = docRef.current.body;
      const resolved = index ?? (parentId === null ? body.length : (findNode(body, parentId)?.children.length ?? 0));
      applyLocal({ kind: 'insert_node', node, parentId, index: resolved });
    },
    [applyLocal],
  );

  const addNode = useCallback(
    (type: string, parentId: string | null, index?: number): string => {
      const node = createNode(type);
      insertNode(node, parentId, index);
      return node.id;
    },
    [insertNode],
  );

  const removeNode = useCallback((id: string) => applyLocal({ kind: 'remove_node', nodeId: id }), [applyLocal]);

  const replaceNode = useCallback(
    (id: string, next: ElementNode) => applyLocal({ kind: 'replace_node', nodeId: id, node: next }),
    [applyLocal],
  );

  const duplicateNode = useCallback(
    (id: string): string | null => {
      const src = findNode(docRef.current.body, id);
      const loc = locateNode(docRef.current.body, id);
      if (!src || !loc) return null;
      const copy = cloneNodeWithNewIds(src);
      applyLocal({ kind: 'insert_node', node: copy, parentId: loc.parentId, index: loc.index + 1 });
      return copy.id;
    },
    [applyLocal],
  );

  const updateSettings = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      const cur = findNode(docRef.current.body, id);
      if (!cur) return;
      const settings = { ...cur.settings };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete settings[key];
        else settings[key] = value;
      }
      replaceNode(id, { ...cur, settings });
    },
    [replaceNode],
  );

  const setStyle = useCallback(
    (id: string, key: string, value: unknown, breakpoint: Breakpoint, state: ElementState) => {
      const cur = findNode(docRef.current.body, id);
      if (!cur) return;
      replaceNode(id, setStyleValue(cur, key, value, breakpoint, state));
    },
    [replaceNode],
  );

  const toggleLock = useCallback(
    (id: string) => {
      const cur = findNode(docRef.current.body, id);
      if (cur) replaceNode(id, { ...cur, locked: !cur.locked });
    },
    [replaceNode],
  );

  /** Moves a node to a new parent/index (drag & drop reparent + reorder). */
  const moveNode = useCallback(
    (id: string, newParentId: string | null, index: number) => {
      if (id === newParentId) return;
      const body = docRef.current.body;
      if (newParentId && findNode(findNode(body, id)?.children ?? [], newParentId)) return;
      if (newParentId && !isContainerType(findNode(body, newParentId)?.type ?? '')) return;
      applyLocal({ kind: 'move_node', nodeId: id, parentId: newParentId, index });
    },
    [applyLocal],
  );

  return {
    doc,
    dirty,
    saveState,
    histTick,
    canUndo: editable && past.current.length > 0,
    canRedo: editable && future.current.length > 0,
    reset,
    saveNow,
    undo,
    redo,
    replaceDocument,
    replaceNode,
    patchTokens,
    addNode,
    insertNode,
    removeNode,
    duplicateNode,
    updateSettings,
    setStyle,
    toggleLock,
    moveNode,
  };
}

export type BuilderDocumentState = ReturnType<typeof useBuilderDocument>;
