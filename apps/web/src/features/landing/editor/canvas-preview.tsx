import { cn } from '@amable/ui';
import { renderBuilderDocumentHtml, type BuilderDocument } from '@amable/builder';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '../../../i18n';
import type { CanvasZoom } from '../lib/devices';
import { editorCanvasDocument, serializeDocument } from '../lib/preview-html';

export interface ColumnResize {
  leftId: string;
  rightId: string;
  leftPct: number;
  rightPct: number;
}

interface PreviewMessage {
  source?: string;
  type?: string;
  id?: string;
  x?: number;
  y?: number;
  leftId?: string;
  rightId?: string;
  leftPct?: number;
  rightPct?: number;
}

/**
 * Renders the draft with the builder renderer in editor mode inside a
 * same-origin srcdoc iframe; clicks inside come back as postMessage events.
 * The iframe is laid out at the real device width and scaled to the column,
 * so media queries match the simulated device. Later renders are patched in
 * place (no reload, no flash, scroll kept) unless the font links changed.
 */
export function CanvasPreview({
  doc,
  pageId,
  tenantSlug,
  deviceWidth,
  zoom,
  selectedId,
  iframeRef,
  onSelectNode,
  onContextMenu,
  onStartMove,
  onDelete,
  onResize,
}: {
  doc: BuilderDocument;
  pageId: string;
  tenantSlug: string;
  deviceWidth: number;
  zoom: CanvasZoom;
  selectedId: string | null;
  iframeRef: RefObject<HTMLIFrameElement>;
  onSelectNode: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
  onStartMove: (id: string) => void;
  onDelete: (id: string) => void;
  onResize: (resize: ColumnResize) => void;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [html, setHtml] = useState('');
  const htmlRef = useRef('');
  const fontSig = useRef('');
  const savedScroll = useRef(0);
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const handlers = useRef({ onSelectNode, onContextMenu, onStartMove, onDelete, onResize });
  handlers.current = { onSelectNode, onContextMenu, onStartMove, onDelete, onResize };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    // Hysteresis: a scrollbar appearing (~15px) must not re-trigger the fit scale.
    const ro = new ResizeObserver(() => {
      setSize((prev) => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (Math.abs(w - prev.w) < 17 && Math.abs(h - prev.h) < 17) return prev;
        return { w, h };
      });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const docKey = JSON.stringify(doc);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const parsed = editorCanvasDocument(renderBuilderDocumentHtml(doc, { mode: 'editor', tenantSlug, pageId }));
      const win = iframeRef.current?.contentWindow;
      try {
        savedScroll.current = win?.scrollY ?? savedScroll.current;
      } catch {
        /* frame not ready */
      }
      const sig = Array.from(parsed.head.querySelectorAll('link[rel="stylesheet"],link[rel="preconnect"]'))
        .map((l) => l.getAttribute('href') ?? '')
        .join('|');
      const canPatch = htmlRef.current !== '' && Boolean(win?.document?.body) && sig === fontSig.current;
      fontSig.current = sig;
      if (canPatch && win) {
        // The runtime and the editor overlay already run with delegated listeners.
        parsed.body.querySelectorAll('script').forEach((s) => s.remove());
        const styles = Array.from(parsed.head.querySelectorAll('style')).map((s) => s.textContent ?? '');
        win.postMessage({ source: 'b-editor', type: 'replace', body: parsed.body.innerHTML, styles }, '*');
        win.postMessage({ source: 'b-editor', type: 'select', id: selectedRef.current, scroll: false }, '*');
      } else {
        const text = serializeDocument(parsed);
        htmlRef.current = text;
        setHtml(text);
      }
    }, 120);
    return () => window.clearTimeout(timer);
    // docKey captures every change of the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, tenantSlug, pageId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const d = event.data as PreviewMessage | null;
      if (d?.source !== 'b-preview') return;
      const h = handlers.current;
      if (d.type === 'resize') {
        if (d.leftId && d.rightId && typeof d.leftPct === 'number' && typeof d.rightPct === 'number') {
          h.onResize({ leftId: d.leftId, rightId: d.rightId, leftPct: d.leftPct, rightPct: d.rightPct });
        }
        return;
      }
      if (!d.id) return;
      if (d.type === 'select') h.onSelectNode(d.id);
      else if (d.type === 'startmove') h.onStartMove(d.id);
      else if (d.type === 'delete') h.onDelete(d.id);
      else if (d.type === 'contextmenu') {
        // The iframe is scaled: map its coordinates back to screen pixels.
        const el = iframeRef.current;
        const rect = el?.getBoundingClientRect();
        const scale = el && rect && el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
        h.onContextMenu(d.id, (rect?.left ?? 0) + (d.x ?? 0) * scale, (rect?.top ?? 0) + (d.y ?? 0) * scale);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [iframeRef]);

  const lastSelected = useRef<string | null>(selectedId);
  useEffect(() => {
    if (lastSelected.current === selectedId) return;
    lastSelected.current = selectedId;
    iframeRef.current?.contentWindow?.postMessage({ source: 'b-editor', type: 'select', id: selectedId, scroll: true }, '*');
  }, [selectedId, iframeRef]);

  const onFrameLoad = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.scrollTo({ top: savedScroll.current, left: 0, behavior: 'instant' });
    } catch {
      /* ignore */
    }
    win.postMessage({ source: 'b-editor', type: 'select', id: selectedRef.current, scroll: false }, '*');
  };

  const pad = 24;
  const fitScale = size.w > 0 ? Math.min(1, (size.w - pad) / deviceWidth) : 1;
  const scale = zoom === 'fit' ? fitScale : zoom;
  const frameH = scale > 0 ? Math.max(0, (size.h - pad) / scale) : 0;

  return (
    <div ref={containerRef} className="flex h-full flex-col items-center overflow-auto bg-muted/40 p-3" style={{ scrollbarGutter: 'stable' }}>
      <div
        style={{ width: deviceWidth * scale, height: frameH * scale, flex: 'none' }}
        className={cn(deviceWidth < 1100 && 'overflow-hidden rounded-xl border shadow-xl')}
      >
        <iframe
          ref={iframeRef}
          title={t('landing.editor.canvas')}
          className="bg-white"
          style={{ width: deviceWidth, height: frameH, transform: `scale(${String(scale)})`, transformOrigin: 'top left', border: 0 }}
          srcDoc={html}
          onLoad={onFrameLoad}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  );
}
