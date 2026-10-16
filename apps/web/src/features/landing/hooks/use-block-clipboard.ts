import { elementNodeSchema, type ElementNode } from '@amable/builder';
import { useCallback, useEffect, useState } from 'react';

/**
 * Editor clipboards ("copy block", "copy style") persisted in localStorage so
 * they work across pages, tabs and reloads. Payloads are re-validated on read:
 * corrupt or outdated entries simply count as an empty clipboard.
 */

const STYLE_KEY = 'amable-canvas-style-clipboard';
const BLOCK_KEY = 'amable-canvas-block-clipboard';

export interface BlockClip {
  readonly type: string;
  readonly node: ElementNode;
}

export interface StyleClip {
  readonly type: string;
  readonly styles: ElementNode['styles'];
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

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode: the clipboard stays in memory only */
  }
}

export function readBlockClip(): BlockClip | null {
  const raw = readRaw(BLOCK_KEY);
  if (!raw || typeof raw['type'] !== 'string' || !raw['node']) return null;
  const parsed = elementNodeSchema.safeParse(raw['node']);
  return parsed.success ? { type: raw['type'], node: parsed.data } : null;
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

  const copyBlock = useCallback((node: ElementNode) => {
    const clip: BlockClip = { type: node.type, node: JSON.parse(JSON.stringify(node)) as ElementNode };
    write(BLOCK_KEY, clip);
    setBlock(clip);
  }, []);

  const copyStyle = useCallback((node: ElementNode) => {
    const clip: StyleClip = { type: node.type, styles: JSON.parse(JSON.stringify(node.styles)) as ElementNode['styles'] };
    write(STYLE_KEY, clip);
    setStyle(clip);
  }, []);

  return { block, style, refresh, copyBlock, copyStyle };
}
