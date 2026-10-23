import { elementNodeSchema, type ElementNode } from '@amable/builder';
import { useCallback, useEffect, useState } from 'react';

/**
 * Editor clipboards ("copy block", "copy style") persisted in localStorage so
 * they work across pages, tabs and reloads. Payloads are re-validated on read:
 * corrupt or outdated entries simply count as an empty clipboard.
 *
 * The block clipboard (v2) holds one or more nodes — a whole page can be
 * copied — plus a human label and the source page, surfaced in menus and
 * toasts so users always see WHAT they are about to paste.
 */

const STYLE_KEY = 'amable-canvas-style-clipboard';
const BLOCK_KEY = 'amable-canvas-block-clipboard';

export interface BlockClip {
  readonly version: 2;
  readonly nodes: readonly ElementNode[];
  /** Human label ("Container · 14 elements" / "Whole page …"). */
  readonly label: string;
  /** True when every root block of a page was copied at once. */
  readonly wholePage: boolean;
  readonly sourcePageName: string;
  readonly copiedAt: number;
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

function readRaw(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Writes a clipboard entry. Returns false when the browser refuses (quota or
 * private mode); the stale entry is dropped so a later paste can never pick up
 * an OLD payload while the user believes the new copy succeeded.
 */
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

/** Parses a raw payload: v2 (multi-node) or the legacy v1 `{type, node}`. */
export function parseBlockClip(raw: Record<string, unknown> | null): BlockClip | null {
  if (!raw) return null;
  if (raw['version'] === 2 && Array.isArray(raw['nodes'])) {
    const nodes: ElementNode[] = [];
    for (const candidate of raw['nodes']) {
      const parsed = elementNodeSchema.safeParse(candidate);
      if (!parsed.success) return null;
      nodes.push(parsed.data);
    }
    if (nodes.length === 0) return null;
    return {
      version: 2,
      nodes,
      label: typeof raw['label'] === 'string' && raw['label'] ? raw['label'] : `${String(nodes.length)} blocchi`,
      wholePage: raw['wholePage'] === true,
      sourcePageName: typeof raw['sourcePageName'] === 'string' ? raw['sourcePageName'] : '',
      copiedAt: typeof raw['copiedAt'] === 'number' ? raw['copiedAt'] : 0,
    };
  }
  if (typeof raw['type'] === 'string' && raw['node']) {
    const parsed = elementNodeSchema.safeParse(raw['node']);
    if (!parsed.success) return null;
    return { version: 2, nodes: [parsed.data], label: raw['type'], wholePage: false, sourcePageName: '', copiedAt: 0 };
  }
  return null;
}

export function readBlockClip(): BlockClip | null {
  return parseBlockClip(readRaw(BLOCK_KEY));
}

export function readStyleClip(): StyleClip | null {
  const raw = readRaw(STYLE_KEY);
  if (!raw || typeof raw['type'] !== 'string' || !Array.isArray(raw['styles'])) return null;
  return { type: raw['type'], styles: raw['styles'] as ElementNode['styles'] };
}

export function useBlockClipboard() {
  const [block, setBlock] = useState<BlockClip | null>(() => readBlockClip());
  const [style, setStyle] = useState<StyleClip | null>(() => readStyleClip());

  const refresh = useCallback(() => {
    setBlock(readBlockClip());
    setStyle(readStyleClip());
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BLOCK_KEY || event.key === STYLE_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  /** Copies one or more nodes; false = storage refused (caller shows the error). */
  const copyNodes = useCallback((nodes: readonly ElementNode[], meta: { label: string; wholePage: boolean; sourcePageName: string }): boolean => {
    const clip: BlockClip = {
      version: 2,
      nodes: JSON.parse(JSON.stringify(nodes)) as ElementNode[],
      label: meta.label,
      wholePage: meta.wholePage,
      sourcePageName: meta.sourcePageName,
      copiedAt: Date.now(),
    };
    const ok = write(BLOCK_KEY, clip);
    setBlock(ok ? clip : null);
    return ok;
  }, []);

  const copyStyle = useCallback((node: ElementNode): boolean => {
    const clip: StyleClip = { type: node.type, styles: JSON.parse(JSON.stringify(node.styles)) as ElementNode['styles'] };
    const ok = write(STYLE_KEY, clip);
    setStyle(ok ? clip : null);
    return ok;
  }, []);

  return { block, style, refresh, copyNodes, copyStyle };
}
