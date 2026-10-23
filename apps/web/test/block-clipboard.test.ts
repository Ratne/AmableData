import type { ElementNode } from '@amable/builder';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipAge, countNodes, parseBlockClip, readBlockClip } from '../src/features/landing/hooks/use-block-clipboard';

const leaf = (id: string): ElementNode => ({ id, type: 'heading', settings: {}, styles: [], children: [], locked: false });
const container: ElementNode = {
  id: 'c1',
  type: 'container',
  settings: {},
  styles: [],
  locked: false,
  children: [leaf('a'), { ...leaf('b'), type: 'container', children: [leaf('x')] }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('block clipboard parsing', () => {
  it('counts nodes including descendants', () => {
    expect(countNodes([container])).toBe(4);
    expect(countNodes([])).toBe(0);
  });

  it('reads the legacy v1 payload as a single-node v2 clip', () => {
    const clip = parseBlockClip({ type: 'container', node: container });
    expect(clip).not.toBeNull();
    expect(clip?.nodes).toHaveLength(1);
    expect(clip?.nodes[0]?.children).toHaveLength(2);
    expect(clip?.wholePage).toBe(false);
  });

  it('reads a v2 multi-node payload with its metadata', () => {
    const clip = parseBlockClip({
      version: 2,
      nodes: [container, leaf('p')],
      label: 'Whole page',
      wholePage: true,
      sourcePageName: 'Landing X',
      copiedAt: 123,
    });
    expect(clip?.nodes).toHaveLength(2);
    expect(clip?.wholePage).toBe(true);
    expect(clip?.sourcePageName).toBe('Landing X');
    expect(clip?.copiedAt).toBe(123);
  });

  it('rejects corrupt payloads instead of falling back to stale content', () => {
    expect(parseBlockClip({ version: 2, nodes: [{ bad: true }] })).toBeNull();
    expect(parseBlockClip({ version: 2, nodes: [] })).toBeNull();
    expect(parseBlockClip({ type: 'container' })).toBeNull();
    expect(parseBlockClip(null)).toBeNull();
  });

  it('reads from localStorage and treats broken JSON as empty', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    store.set('amable-canvas-block-clipboard', JSON.stringify({ version: 2, nodes: [leaf('a')], label: 'Heading' }));
    expect(readBlockClip()?.label).toBe('Heading');
    store.set('amable-canvas-block-clipboard', '{broken');
    expect(readBlockClip()).toBeNull();
  });

  it('formats the clip age compactly', () => {
    const now = 10 * 60_000;
    expect(clipAge(0, now)).toBe('');
    expect(clipAge(now - 20_000, now)).toBe('<1 min');
    expect(clipAge(now - 3 * 60_000, now)).toBe('3 min');
    expect(clipAge(now - 2 * 3_600_000, now)).toBe('2 h');
    expect(clipAge(now - 3 * 86_400_000, now)).toBe('3 g');
  });
});
