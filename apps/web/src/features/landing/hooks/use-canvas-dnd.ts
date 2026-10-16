import { findNode, isContainerType, locateNode, type ElementNode } from '@amable/builder';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface CanvasDrag {
  readonly kind: 'new' | 'move';
  readonly type?: string;
  readonly nodeId?: string;
}

export type DropIndicator =
  | { type: 'h'; left: number; top: number; width: number }
  | { type: 'v'; left: number; top: number; height: number }
  | { type: 'box'; left: number; top: number; width: number; height: number };

/** Outline of the container that will receive the dragged element. */
export interface DropOutline {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Badge following the cursor while dragging. */
export interface DragChip {
  x: number;
  y: number;
  label: string;
  valid: boolean;
}

interface DropTarget {
  parentId: string | null;
  index: number;
}

const EDGE = 16;

function isDescendant(body: ElementNode[], ancestorId: string, maybeChildId: string): boolean {
  const anc = findNode(body, ancestorId);
  return !!anc && !!findNode(anc.children, maybeChildId);
}

/** Drop when the pointer is over empty canvas: end of the first container, else of the body. */
function defaultDrop(body: ElementNode[]): DropTarget {
  const first = body.find((n) => isContainerType(n.type));
  if (first) return { parentId: first.id, index: first.children.length };
  return { parentId: null, index: body.length };
}

/**
 * Drag & drop onto the canvas iframe. The iframe is same-origin (srcdoc), so
 * the parent hit-tests its DOM with elementFromPoint and computes a
 * before/after/inside position, drawing an insertion line, the target
 * container outline and a cursor chip.
 */
export function useCanvasDnd(opts: {
  iframeRef: RefObject<HTMLIFrameElement>;
  getBody: () => ElementNode[];
  labelOf: (type: string) => string;
  addNode: (type: string, parentId: string | null, index?: number) => string;
  moveNode: (id: string, parentId: string | null, index: number) => void;
  onAdded?: (id: string) => void;
  disabled?: boolean;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [drag, setDrag] = useState<CanvasDrag | null>(null);
  const dragRef = useRef<CanvasDrag | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [outline, setOutline] = useState<DropOutline | null>(null);
  const [chip, setChip] = useState<DragChip | null>(null);

  const startDrag = useCallback((d: CanvasDrag) => {
    if (optsRef.current.disabled) return;
    dragRef.current = d;
    dropRef.current = null;
    setDrag(d);
  }, []);

  useEffect(() => {
    if (!drag) return undefined;
    const { iframeRef, getBody, labelOf } = optsRef.current;
    const iframe = iframeRef.current;
    if (iframe) iframe.style.pointerEvents = 'none';

    let sourceEl: HTMLElement | null = null;
    if (drag.kind === 'move' && drag.nodeId) {
      sourceEl = iframe?.contentDocument?.querySelector<HTMLElement>(`[data-b-id="${drag.nodeId}"]`) ?? null;
      if (sourceEl) {
        sourceEl.style.opacity = '0.35';
        sourceEl.style.outline = '2px dashed #94a3b8';
        sourceEl.style.outlineOffset = '-2px';
      }
    }

    const chipLabel =
      drag.kind === 'move' && drag.nodeId ? labelOf(findNode(getBody(), drag.nodeId)?.type ?? '') : labelOf(drag.type ?? '');

    let rafPending = false;
    let lastMove: PointerEvent | null = null;
    // Drags started inside the iframe (move handle) may reach the parent with
    // buttons=0: only treat buttons=0 as "released" after seeing them pressed.
    let sawButtons = false;

    function autoScroll(e: PointerEvent, el: HTMLIFrameElement) {
      const win = el.contentWindow;
      if (!win) return;
      const rect = el.getBoundingClientRect();
      const zone = 56;
      const speed = 18;
      if (e.clientY > rect.top && e.clientY < rect.top + zone) win.scrollBy(0, -speed);
      else if (e.clientY < rect.bottom && e.clientY > rect.bottom - zone) win.scrollBy(0, speed);
    }

    function clearTarget() {
      dropRef.current = null;
      setIndicator(null);
      setOutline(null);
    }

    function onMove(e: PointerEvent) {
      if (e.buttons > 0) sawButtons = true;
      else if (sawButtons) {
        finish();
        return;
      }
      lastMove = e;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (dragRef.current && lastMove) hitTest(lastMove);
      });
    }

    function hitTest(e: PointerEvent) {
      const iframeEl = iframeRef.current;
      const idoc = iframeEl?.contentDocument;
      if (!iframeEl || !idoc) return;
      const rect = iframeEl.getBoundingClientRect();
      autoScroll(e, iframeEl);
      // The iframe is scaled to fit the column: convert screen ↔ document coordinates.
      const scale = iframeEl.offsetWidth > 0 ? rect.width / iframeEl.offsetWidth : 1;
      const px = (e.clientX - rect.left) / scale;
      const py = (e.clientY - rect.top) / scale;
      const body = getBody();
      const d = dragRef.current;
      if (!d) return;

      if (px < 0 || py < 0 || px > iframeEl.offsetWidth || py > iframeEl.offsetHeight) {
        clearTarget();
        setChip({ x: e.clientX, y: e.clientY, label: chipLabel, valid: false });
        return;
      }

      const pageRect = (el: Element): DropOutline => {
        const r = el.getBoundingClientRect();
        return { left: rect.left + r.left * scale, top: rect.top + r.top * scale, width: r.width * scale, height: r.height * scale };
      };

      const setOutlineFor = (parentId: string | null) => {
        if (!parentId) {
          setOutline(null);
          return;
        }
        const pel = idoc.querySelector(`[data-b-id="${parentId}"]`);
        setOutline(pel ? pageRect(pel) : null);
      };

      const indicateInside = (containerEl: HTMLElement, containerId: string) => {
        const dir = getComputedStyle(containerEl).flexDirection || 'column';
        const row = dir.startsWith('row');
        const kids = Array.from(containerEl.querySelectorAll<HTMLElement>(':scope > [data-b-id]'));
        if (kids.length === 0) {
          const node = findNode(body, containerId);
          dropRef.current = { parentId: containerId, index: node ? node.children.length : 0 };
          setIndicator({ type: 'box', ...pageRect(containerEl) });
          setOutlineFor(containerId);
          return;
        }
        const pointer = row ? px : py;
        let index = kids.length;
        for (const [i, kid] of kids.entries()) {
          const kr = kid.getBoundingClientRect();
          const mid = row ? kr.left + kr.width / 2 : kr.top + kr.height / 2;
          if (pointer < mid) {
            index = i;
            break;
          }
        }
        const anchor = kids[Math.min(index, kids.length - 1)];
        if (!anchor) return;
        const ar = anchor.getBoundingClientRect();
        const atEnd = index >= kids.length;
        dropRef.current = { parentId: containerId, index };
        if (row) {
          const x = rect.left + (atEnd ? ar.right : ar.left) * scale;
          setIndicator({ type: 'v', left: x - 2, top: rect.top + ar.top * scale, height: ar.height * scale });
        } else {
          const y = rect.top + (atEnd ? ar.bottom : ar.top) * scale;
          setIndicator({ type: 'h', left: rect.left + ar.left * scale, top: y - 2, width: ar.width * scale });
        }
        setOutlineFor(containerId);
      };

      const raw = idoc.elementFromPoint(px, py);
      const el = raw?.closest<HTMLElement>('[data-b-id]') ?? null;

      if (!el) {
        const drop = defaultDrop(body);
        dropRef.current = drop;
        const cel = drop.parentId ? idoc.querySelector<HTMLElement>(`[data-b-id="${drop.parentId}"]`) : null;
        if (cel && drop.parentId) indicateInside(cel, drop.parentId);
        else {
          setIndicator(null);
          setOutline(null);
        }
        setChip({ x: e.clientX, y: e.clientY, label: chipLabel, valid: true });
        return;
      }

      const targetId = el.getAttribute('data-b-id') ?? '';
      if (d.kind === 'move' && d.nodeId && (targetId === d.nodeId || isDescendant(body, d.nodeId, targetId))) {
        clearTarget();
        setChip({ x: e.clientX, y: e.clientY, label: chipLabel, valid: false });
        return;
      }
      setChip({ x: e.clientX, y: e.clientY, label: chipLabel, valid: true });

      const trect = el.getBoundingClientRect();
      const isContainer = isContainerType(el.getAttribute('data-b-type') ?? '');
      if (isContainer && px > trect.left + EDGE && px < trect.right - EDGE && py > trect.top + EDGE && py < trect.bottom - EDGE) {
        indicateInside(el, targetId);
        return;
      }

      const domParent = el.parentElement;
      const dir = domParent ? getComputedStyle(domParent).flexDirection : 'column';
      const row = dir.startsWith('row');
      const after = row ? px > trect.left + trect.width / 2 : py > trect.top + trect.height / 2;
      const loc = locateNode(body, targetId);
      if (!loc) {
        clearTarget();
        return;
      }
      dropRef.current = { parentId: loc.parentId, index: loc.index + (after ? 1 : 0) };
      setOutlineFor(loc.parentId);
      if (row) {
        const x = rect.left + (after ? trect.right : trect.left) * scale;
        setIndicator({ type: 'v', left: x - 2, top: rect.top + trect.top * scale, height: trect.height * scale });
      } else {
        const y = rect.top + (after ? trect.bottom : trect.top) * scale;
        setIndicator({ type: 'h', left: rect.left + trect.left * scale, top: y - 2, width: trect.width * scale });
      }
    }

    function finish() {
      const d = dragRef.current;
      const drop = dropRef.current;
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      setIndicator(null);
      setOutline(null);
      setChip(null);
      const el = iframeRef.current;
      if (el) el.style.pointerEvents = '';
      if (sourceEl) {
        sourceEl.style.opacity = '';
        sourceEl.style.outline = '';
        sourceEl.style.outlineOffset = '';
        sourceEl = null;
      }
      if (!d || !drop) return;
      const { addNode, moveNode, onAdded } = optsRef.current;
      if (d.kind === 'new' && d.type) {
        onAdded?.(addNode(d.type, drop.parentId, drop.index));
      } else if (d.kind === 'move' && d.nodeId) {
        // Indices were computed on the tree that still contains the dragged
        // node: compensate for its removal when moving within the same parent.
        const orig = locateNode(getBody(), d.nodeId);
        let index = drop.index;
        if (orig && orig.parentId === drop.parentId) {
          if (orig.index === index || orig.index === index - 1) return;
          if (orig.index < index) index -= 1;
        }
        moveNode(d.nodeId, drop.parentId, index);
      }
    }

    const cancel = () => {
      dropRef.current = null;
      finish();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    // A drag started from the in-frame handle blurs the parent while
    // document.hasFocus() stays true: only cancel when focus left the page.
    const onBlur = () => {
      window.setTimeout(() => {
        if (dragRef.current && !document.hasFocus()) cancel();
      }, 0);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey);
      const el = iframeRef.current;
      if (el) el.style.pointerEvents = '';
      if (sourceEl) {
        sourceEl.style.opacity = '';
        sourceEl.style.outline = '';
        sourceEl.style.outlineOffset = '';
      }
    };
  }, [drag]);

  return { drag, indicator, outline, chip, startDrag };
}
