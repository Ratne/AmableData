// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { editLockPath, useEditLock, type EditLock } from '../src/lib/edit-lock/use-edit-lock';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  state(role: 'holder' | 'waiting', holder: string) {
    const data = JSON.stringify({ type: 'state', role, waiting: 0, holder: { user_id: holder, user_name: holder, since: 1 } });
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  drop() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

let root: Root | null = null;
let current: EditLock | null = null;

function mount(path: string | null, options: Parameters<typeof useEditLock>[1]) {
  function Probe() {
    current = useEditLock(path, options);
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root?.render(createElement(Probe)));
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  current = null;
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('edit lock hook', () => {
  it('builds the resource path of each lockable collection', () => {
    expect(editLockPath('acme', 'emailTemplates', 'tpl 1')).toBe('/api/v2/t/acme/emailTemplates/tpl%201');
  });

  it('opens no socket without a path and lets the caller edit', () => {
    mount(null, {});
    expect(FakeSocket.all).toHaveLength(0);
    expect(current).toMatchObject({ status: 'disabled', canEdit: true });
  });

  it('follows the server state: read-only while waiting, onLost on takeover, onStale when the lock comes back', () => {
    const onLost = vi.fn();
    const onStale = vi.fn();
    mount('/api/v2/t/acme/automations/a1', { onLost, onStale });
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe(`ws://${window.location.host}/api/v2/t/acme/automations/a1/lock`);
    expect(current).toMatchObject({ status: 'connecting', canEdit: false });

    act(() => {
      ws.open();
      ws.state('holder', 'me');
    });
    expect(current).toMatchObject({ status: 'holder', canEdit: true });

    act(() => ws.state('waiting', 'bob'));
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ user_name: 'bob' }));
    expect(current).toMatchObject({ status: 'waiting', canEdit: false });

    act(() => ws.state('holder', 'me'));
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('does not reload after a reconnect as holder, so unsaved edits survive a network blip', () => {
    vi.useFakeTimers();
    const onStale = vi.fn();
    mount('/api/v2/t/acme/forms/f1', { onStale });
    const first = FakeSocket.all[0]!;
    act(() => {
      first.open();
      first.state('holder', 'me');
      first.drop();
    });
    expect(current?.status).toBe('offline');
    act(() => vi.advanceTimersByTime(2_000));
    const second = FakeSocket.all[1]!;
    act(() => {
      second.open();
      second.state('holder', 'me');
    });
    expect(current?.status).toBe('holder');
    expect(onStale).not.toHaveBeenCalled();
  });

  it('refreshes every 15 s while waiting and sends heartbeats', () => {
    vi.useFakeTimers();
    const onStale = vi.fn();
    mount('/api/v2/t/acme/broadcasts/b1', { onStale });
    const ws = FakeSocket.all[0]!;
    act(() => {
      ws.open();
      ws.state('waiting', 'bob');
    });
    act(() => vi.advanceTimersByTime(15_000));
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(ws.sent).toContain(JSON.stringify({ type: 'heartbeat' }));
  });
});
