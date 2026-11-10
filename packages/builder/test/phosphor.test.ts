import { describe, expect, it } from 'vitest';
import {
  hasPhosphor,
  icon,
  loadPhosphor,
  missingPhosphorWeights,
  parsePhosphor,
  phosphorName,
  phosphorWeightsIn,
} from '../src/index';
import { PHOSPHOR_CATALOG } from '../src/phosphor/catalog';

describe('phosphor icons', () => {
  it('parses and builds weighted names', () => {
    expect(parsePhosphor('ph:rocket-launch')).toEqual({
      weight: 'regular',
      glyph: 'rocket-launch',
    });
    expect(parsePhosphor(' PH-Bold:House ')).toEqual({ weight: 'bold', glyph: 'house' });
    expect(parsePhosphor('ph-heavy:house')).toBeNull();
    expect(parsePhosphor('star')).toBeNull();
    expect(phosphorName('house', 'regular')).toBe('ph:house');
    expect(phosphorName('house', 'duotone')).toBe('ph-duotone:house');
  });

  it('renders nothing until a weight is loaded, then inline svg', async () => {
    expect(hasPhosphor('fill')).toBe(false);
    expect(icon('ph-fill:heart')).toBe('');
    await loadPhosphor('fill');
    expect(icon('ph-fill:heart')).toMatch(
      /^<svg class="b-svg" viewBox="0 0 256 256" fill="currentColor"[^>]*><path d="/,
    );
    expect(icon('ph-fill:not-a-glyph')).toBe('');
    expect(icon('star')).toContain('viewBox="0 0 24 24"');
  });

  it('finds the weights a document references', () => {
    const doc = {
      root: [
        { settings: { icon: 'ph-bold:house' } },
        { settings: { icon: 'ph:star', items: [{ icon: 'ph-duotone:x' }] } },
      ],
    };
    expect(phosphorWeightsIn(doc)).toEqual(['regular', 'bold', 'duotone']);
    expect(phosphorWeightsIn({ text: 'graph:ph:house inside text' })).toEqual([]);
    expect(missingPhosphorWeights({ a: 'ph-fill:heart' })).toEqual([]);
  });

  it('ships a searchable catalog that matches the glyph packs', async () => {
    const regular = (await import('../src/phosphor/regular')).default;
    expect(PHOSPHOR_CATALOG.length).toBeGreaterThan(1000);
    for (const [name] of PHOSPHOR_CATALOG) expect(regular[name], name).toBeTypeOf('string');
  });
});
