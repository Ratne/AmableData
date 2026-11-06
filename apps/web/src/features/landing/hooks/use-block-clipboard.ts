import { cloneNodeWithNewIds, elementNodeSchema, type ElementNode } from '@amable/builder';
import { useCallback, useEffect, useState } from 'react';

/**
 * Builder clipboard helpers. Copied BLOCKS live on the server (personal,
 * 24h, see `use-canvas-clipboard.ts` and the clipboard tray); only the small
 * "copy style" payload stays in localStorage, re-validated on read.
 */

const STYLE_KEY = 'amable-canvas-style-clipboard';

/** One entry of the personal clipboard, as the editor uses it. */
export interface ClipEntry {
  readonly id: string;
  readonly nodes: readonly ElementNode[];
  /** Human label ("Container · 14 elements" / "Whole page …"). */
  readonly label: string;
  /** True when every root block of a page was copied at once. */
  readonly wholePage: boolean;
  readonly sourcePageName: string;
  readonly createdAt: number;
}

export interface StyleClip {
  readonly type: string;
  readonly styles: ElementNode['styles'];
}

/** Total node count, descendants included. */
export function countNodes(nodes: readonly ElementNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

/** "3 min", "2 h", "5 g" — compact relative age for menu entries ("" when unknown). */
export function clipAge(copiedAt: number, now = Date.now()): string {
  if (!copiedAt) return '';
  const minutes = Math.round(Math.max(0, now - copiedAt) / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h`;
  return `${String(Math.round(hours / 24))} g`;
}

/** Parses one entry of `GET /builderClipboard`; null when malformed. */
export function parseClipEntry(raw: unknown): ClipEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || !Array.isArray(r['nodes'])) return null;
  const nodes: ElementNode[] = [];
  for (const candidate of r['nodes']) {
    const parsed = elementNodeSchema.safeParse(candidate);
    if (!parsed.success) return null;
    nodes.push(parsed.data);
  }
  if (nodes.length === 0) return null;
  const created = typeof r['created_at'] === 'string' ? Date.parse(r['created_at']) : NaN;
  return {
    id: r['id'],
    nodes,
    label: typeof r['label'] === 'string' && r['label'] ? r['label'] : `${String(nodes.length)} blocchi`,
    wholePage: r['whole_page'] === true,
    sourcePageName: typeof r['source_page_name'] === 'string' ? r['source_page_name'] : '',
    createdAt: Number.isFinite(created) ? created : 0,
  };
}

export function parseClipEntries(raw: unknown): ClipEntry[] {
  return Array.isArray(raw) ? raw.map(parseClipEntry).filter((e): e is ClipEntry => e !== null) : [];
}

/**
 * Inserts fresh copies (new ids) of `nodes` at `parentId`/`index`, returning
 * the new body and the inserted ids. Popups always go to the end of the root
 * (they only live there); an unknown parent falls back to the root end.
 */
export function insertClonesAt(
  body: readonly ElementNode[],
  nodes: readonly ElementNode[],
  parentId: string | null,
  index: number,
): { body: ElementNode[]; ids: string[] } {
  const copies = nodes.map(cloneNodeWithNewIds);
  const popups = copies.filter((n) => n.type === 'popup');
  const regular = copies.filter((n) => n.type !== 'popup');
  const spliceInto = (list: readonly ElementNode[]): ElementNode[] => {
    const at = Math.max(0, Math.min(index, list.length));
    return [...list.slice(0, at), ...regular, ...list.slice(at)];
  };

  let next: ElementNode[] = [...body];
  if (regular.length > 0) {
    if (parentId === null) next = spliceInto(body);
    else {
      let placed = false;
      const walk = (list: readonly ElementNode[]): ElementNode[] =>
        list.map((n) => {
          if (n.id === parentId) {
            placed = true;
            return { ...n, children: spliceInto(n.children) };
          }
          return n.children.length > 0 ? { ...n, children: walk(n.children) } : n;
        });
      next = walk(body);
      if (!placed) next = [...next, ...regular];
    }
  }
  if (popups.length > 0) next = [...next, ...popups];
  return { body: next, ids: copies.map((n) => n.id) };
}

function readRaw(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Writes a clipboard entry; false when the browser refuses (quota or private mode). */
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable altogether */
    }
    return false;
  }
}

export function readStyleClip(): StyleClip | null {
  const raw = readRaw(STYLE_KEY);
  if (!raw || typeof raw['type'] !== 'string' || !Array.isArray(raw['styles'])) return null;
  return { type: raw['type'], styles: raw['styles'] as ElementNode['styles'] };
}

/** "Copy style" clipboard (localStorage, cross-page and cross-tab). */
export function useStyleClipboard() {
  const [style, setStyle] = useState<StyleClip | null>(() => readStyleClip());

  const refresh = useCallback(() => setStyle(readStyleClip()), []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STYLE_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  const copyStyle = useCallback((node: ElementNode): boolean => {
    const clip: StyleClip = { type: node.type, styles: JSON.parse(JSON.stringify(node.styles)) as ElementNode['styles'] };
    const ok = write(STYLE_KEY, clip);
    setStyle(ok ? clip : null);
    return ok;
  }, []);

  return { style, refresh, copyStyle };
}
