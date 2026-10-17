import { describe, expect, it } from 'vitest';
import { envelope, isSafePath, parseAppMessage, parseHostMessage, tokenExpiry } from '../src/index';

describe('app-bridge protocol', () => {
  it('parses app messages strictly', () => {
    expect(parseAppMessage(envelope({ type: 'ready' }))).toEqual({ type: 'ready' });
    expect(parseAppMessage(envelope({ type: 'resize', height: 99999 }))).toEqual({ type: 'resize', height: 4000 });
    expect(parseAppMessage(envelope({ type: 'toast', message: 'Saved', tone: 'weird' }))).toEqual({ type: 'toast', message: 'Saved', tone: 'info' });
    expect(parseAppMessage(envelope({ type: 'navigate', path: 'contacts' }))).toEqual({ type: 'navigate', path: 'contacts' });
    expect(parseAppMessage(envelope({ type: 'navigate', path: 'https://evil.example' }))).toBeNull();
    expect(parseAppMessage(envelope({ type: 'navigate', path: 'a/../../x' }))).toBeNull();
    expect(parseAppMessage({ type: 'ready' })).toBeNull();
    expect(parseAppMessage({ ns: 'amable-bridge', v: 2, type: 'ready' })).toBeNull();
    expect(parseAppMessage(envelope({ type: 'eval', code: '1' }))).toBeNull();
  });

  it('parses host messages', () => {
    expect(parseHostMessage(envelope({ type: 'session_token', request_id: 't1', token: 'a.b.c', expires_at: 'x' }))).toMatchObject({ token: 'a.b.c' });
    expect(parseHostMessage(envelope({ type: 'session_token', request_id: 't1' }))).toBeNull();
  });

  it('reads token expiry and checks paths', () => {
    const payload = btoa(JSON.stringify({ exp: 1234 })).replace(/=+$/, '');
    expect(tokenExpiry(`h.${payload}.s`)).toBe(1234);
    expect(tokenExpiry('nope')).toBeNull();
    expect(isSafePath('settings/apps/installed')).toBe(true);
    expect(isSafePath('/abs')).toBe(false);
  });
});
