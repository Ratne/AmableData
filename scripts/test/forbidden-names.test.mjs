import { describe, expect, it } from 'vitest';
import { createMatcher, hashTerm, normalize, tokenize } from '../check-forbidden-names.mjs';

// A made-up term: the real ones are never written in clear in the repository.
const match = createMatcher(new Set([hashTerm('Zorb Lax')]));

describe('forbidden names check', () => {
  it('normalizes terms and splits identifiers into word tokens', () => {
    expect(normalize('Zorb-Lax.io')).toBe('zorblaxio');
    expect(tokenize('revokeApiKey HTTPServer v2beta').map((t) => t.token)).toEqual([
      'revoke',
      'api',
      'key',
      'http',
      'server',
      'v',
      '2',
      'beta',
    ]);
  });

  it('catches spaced, dotted, hyphenated and camelCase spellings', () => {
    expect(match('see zorblax for details')).toEqual([5]);
    expect(match('Zorb Lax')).toEqual([1]);
    expect(match('zorb-lax, zorb.lax, zorb_lax')).toHaveLength(3);
    expect(match('const zorbLaxClient = 1')).toEqual([7]);
    expect(match('ZORBLAX_API_KEY')).toEqual([1]);
  });

  it('does not flag words that merely contain the term', () => {
    expect(match('zorblaxian zorblaxes')).toEqual([]);
    expect(match('azorb lax')).toEqual([]);
  });
});
