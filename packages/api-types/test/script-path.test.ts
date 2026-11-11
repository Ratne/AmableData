import { describe, expect, it } from 'vitest';
import { defaultScriptPath, randomScriptPath, SCRIPT_PATH_RE } from '../src/analytics/ad-params';

describe('script path', () => {
  it('always puts a digit in the directory', () => {
    for (let i = 0; i < 500; i++) {
      expect(defaultScriptPath(`st_site${i}`)).toMatch(SCRIPT_PATH_RE);
      expect(randomScriptPath()).toMatch(SCRIPT_PATH_RE);
    }
    expect(defaultScriptPath('st_abc')).toBe(defaultScriptPath('st_abc'));
  });

  it('refuses word directories a site could already use', () => {
    expect(SCRIPT_PATH_RE.test('static/main')).toBe(false);
    expect(SCRIPT_PATH_RE.test('assets/app')).toBe(false);
    expect(SCRIPT_PATH_RE.test('k3x9ab2q/app')).toBe(true);
  });
});
