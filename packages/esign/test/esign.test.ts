import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consentText, resolveEsignLocale, SIGNING_STRINGS } from '../src/index';
import { buildBundle, renderModule } from '../scripts/build.mjs';

describe('signing page strings', () => {
  it('has the same keys in every language', () => {
    expect(Object.keys(SIGNING_STRINGS.it).sort()).toEqual(Object.keys(SIGNING_STRINGS.en).sort());
    expect(consentText('it')).toContain('firma elettronica');
  });

  it('follows the signer’s languages when the template says auto', () => {
    expect(resolveEsignLocale('auto', ['it-IT', 'en'])).toBe('it');
    expect(resolveEsignLocale('auto', ['de-DE', 'en-GB'])).toBe('en');
    expect(resolveEsignLocale('auto', ['fr'])).toBe('en');
    expect(resolveEsignLocale('it', ['en'])).toBe('it');
  });
});

describe('signing app bundle', () => {
  it('is committed up to date and small', async () => {
    const bundle = await buildBundle();
    const generated = readFileSync(join(import.meta.dirname, '../generated/bundle.ts'), 'utf8');
    expect(generated).toBe(renderModule(bundle));
    expect(bundle.length).toBeLessThan(80_000);
    expect(bundle).toContain('amable-sign-view');
  });
});
