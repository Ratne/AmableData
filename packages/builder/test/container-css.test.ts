import { describe, expect, it } from 'vitest';
import { buildNodeCss, type ElementNode } from '../src/index';

const container = (styles: ElementNode['styles']): ElementNode =>
  ({
    id: 'p',
    type: 'container',
    settings: { _containerType: 'flex' },
    styles,
    children: [],
    locked: false,
  }) as ElementNode;

describe('container boxed children', () => {
  it('a row drops the auto margins of boxed children so justify-content applies', () => {
    const css = buildNodeCss(
      container([
        { breakpoint: 'desktop', state: 'normal', props: { _direction: 'row', _wrap: 'wrap' } },
      ]),
    );
    expect(css).toContain('.b-p>:where(.b-container--boxed){margin-inline:0}');
    expect(css).toMatch(
      /@media\(max-width:\d+px\)\{\.b-p>:where\(\.b-container--boxed\)\{margin-inline:auto\}\}/,
    );
  });

  it('a column keeps boxed children centred', () => {
    const css = buildNodeCss(
      container([{ breakpoint: 'desktop', state: 'normal', props: { _direction: 'column' } }]),
    );
    expect(css).toContain('margin-inline:auto');
    expect(css).not.toContain('margin-inline:0');
  });
});
