import type { ElementNode } from '@amable/builder';
import { describe, expect, it } from 'vitest';
import {
  clipAge,
  countNodes,
  insertClonesAt,
  parseClipEntries,
  parseClipEntry,
} from '../src/features/landing/hooks/use-block-clipboard';

const leaf = (id: string, type = 'heading'): ElementNode => ({ id, type, settings: {}, styles: [], children: [], locked: false });
const container: ElementNode = {
  id: 'c1',
  type: 'container',
  settings: {},
  styles: [],
  locked: false,
  children: [leaf('a'), { ...leaf('b'), type: 'container', children: [leaf('x')] }],
};

describe('builder clipboard helpers', () => {
  it('counts nodes including descendants', () => {
    expect(countNodes([container])).toBe(4);
    expect(countNodes([])).toBe(0);
  });

  it('parses server entries and drops malformed ones', () => {
    const raw = {
      id: '01HX',
      label: 'Intera pagina "Home" (2 blocchi)',
      whole_page: true,
      source_page_name: 'Home',
      nodes: [container, leaf('z')],
      created_at: '2026-10-23T10:00:00.000Z',
    };
    const entry = parseClipEntry(raw);
    expect(entry).toMatchObject({ id: '01HX', wholePage: true, sourcePageName: 'Home' });
    expect(entry?.nodes).toHaveLength(2);
    expect(entry?.createdAt).toBe(Date.parse('2026-10-23T10:00:00.000Z'));
    expect(parseClipEntries([raw, { id: 'x', nodes: [] }, { nodes: [container] }, { id: 'y', nodes: [{ id: 1 }] }])).toHaveLength(1);
    expect(parseClipEntry(null)).toBeNull();
  });

  it('inserts fresh copies at the drop position in one tree', () => {
    const body = [container];
    const res = insertClonesAt(body, [leaf('n1', 'text'), leaf('n2', 'text')], 'c1', 1);
    const kids = res.body[0]?.children ?? [];
    expect(kids.map((k) => k.type)).toEqual(['heading', 'text', 'text', 'container']);
    expect(res.ids).toHaveLength(2);
    expect(res.ids).not.toContain('n1');
    expect(body[0]?.children).toHaveLength(2);
  });

  it('sends popups to the root end and falls back to the root for unknown parents', () => {
    const res = insertClonesAt([container], [leaf('p', 'popup'), leaf('t', 'text')], 'missing', 0);
    expect(res.body.map((n) => n.type)).toEqual(['container', 'text', 'popup']);
    const root = insertClonesAt([container], [leaf('t', 'text')], null, 0);
    expect(root.body[0]?.type).toBe('text');
  });

  it('formats a compact age', () => {
    const now = 1_000_000_000;
    expect(clipAge(0, now)).toBe('');
    expect(clipAge(now - 10_000, now)).toBe('<1 min');
    expect(clipAge(now - 5 * 60_000, now)).toBe('5 min');
    expect(clipAge(now - 3 * 3_600_000, now)).toBe('3 h');
  });
});
