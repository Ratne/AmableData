import type { AutomationGraph } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { DraftSync, type SavedDraft } from '../../src/features/automations/lib/draft-sync';
import { localIssues } from '../../src/features/automations/lib/issues';

class Conflict extends Error {}

function graphWith(label: string): AutomationGraph {
  return {
    schema_version: 1,
    nodes: [{ id: 's1', type: 'sequence', position: { x: 0, y: 0 }, label, steps: [] }],
    edges: [],
  };
}

/** Fake server with the optimistic lock of `PUT /automations/{id}/draft`. */
function server(initial: SavedDraft) {
  const state = { ...initial, saves: 0 };
  let gate: Promise<void> = Promise.resolve();
  return {
    state,
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => (release = resolve));
      return () => release();
    },
    save: async (graph: AutomationGraph, revision: number): Promise<SavedDraft> => {
      await gate;
      if (revision !== state.revision) throw new Conflict('conflict');
      state.saves += 1;
      state.revision += 1;
      state.graph = graph;
      return { revision: state.revision, graph };
    },
    load: () => Promise.resolve({ revision: state.revision, graph: state.graph }),
    /** Someone else saves from another tab. */
    otherTab(graph: AutomationGraph) {
      state.revision += 1;
      state.graph = graph;
    },
  };
}

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    get count() {
      return pending.size;
    },
  };
}

function setup() {
  const api = server({ revision: 1, graph: graphWith('v1') });
  const timers = manualTimers();
  const sync = new DraftSync({
    revision: 1,
    graph: graphWith('v1'),
    save: api.save,
    load: api.load,
    check: localIssues,
    isConflict: (error) => error instanceof Conflict,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { api, timers, sync };
}

describe('draft autosave with revision conflicts', () => {
  it('debounces edits and saves with the current revision', async () => {
    const { api, timers, sync } = setup();
    sync.update(graphWith('a'));
    sync.update(graphWith('b'));
    expect(sync.getSnapshot().status).toBe('dirty');
    expect(timers.count).toBe(1);
    timers.fire();
    await sync.flush();
    expect(api.state.saves).toBe(1);
    expect(api.state.graph).toEqual(graphWith('b'));
    expect(sync.getSnapshot()).toMatchObject({ status: 'saved', revision: 2 });
  });

  it('goes back to saved without a request when the edit is undone', async () => {
    const { api, timers, sync } = setup();
    sync.update(graphWith('a'));
    sync.update(graphWith('v1'));
    expect(sync.getSnapshot().status).toBe('saved');
    expect(timers.count).toBe(0);
    await sync.flush();
    expect(api.state.saves).toBe(0);
  });

  it('saves edits made during a save with the revision returned by it', async () => {
    const { api, sync } = setup();
    const release = api.hold();
    sync.update(graphWith('a'));
    const first = sync.flush();
    sync.update(graphWith('b'));
    expect(sync.getSnapshot().status).toBe('saving');
    release();
    await first;
    expect(api.state.saves).toBe(2);
    expect(api.state.graph).toEqual(graphWith('b'));
    expect(sync.getSnapshot()).toMatchObject({ status: 'saved', revision: 3 });
  });

  it('stops on a revision conflict and can reload the server draft', async () => {
    const { api, timers, sync } = setup();
    api.otherTab(graphWith('theirs'));
    sync.update(graphWith('mine'));
    await sync.flush();
    expect(sync.getSnapshot().status).toBe('conflict');
    // No more autosave while in conflict.
    sync.update(graphWith('mine 2'));
    expect(timers.count).toBe(0);
    await sync.flush();
    expect(api.state.graph).toEqual(graphWith('theirs'));

    const server = await sync.resolveWithServer();
    expect(server).toEqual({ revision: 2, graph: graphWith('theirs') });
    expect(sync.graph).toEqual(graphWith('theirs'));
    expect(sync.getSnapshot()).toMatchObject({ status: 'saved', revision: 2 });
  });

  it('can keep the local draft by saving over the latest revision', async () => {
    const { api, sync } = setup();
    api.otherTab(graphWith('theirs'));
    sync.update(graphWith('mine'));
    await sync.flush();
    expect(sync.getSnapshot().status).toBe('conflict');
    await sync.resolveKeepMine();
    expect(api.state.graph).toEqual(graphWith('mine'));
    expect(sync.getSnapshot()).toMatchObject({ status: 'saved', revision: 3 });
  });

  it('does not send drafts the server would reject', async () => {
    const { api, timers, sync } = setup();
    const invalid: AutomationGraph = {
      schema_version: 1,
      nodes: [
        {
          id: 'g1',
          type: 'goal',
          position: { x: 0, y: 0 },
          triggers: [{ type: 'tag_applied', tag_ids: [] }],
        },
      ],
      edges: [],
    };
    expect(localIssues(invalid)).toEqual([
      expect.objectContaining({ nodeId: 'g1', path: 'nodes[0].triggers[0].tag_ids' }),
    ]);
    sync.update(invalid);
    expect(sync.getSnapshot().status).toBe('invalid');
    expect(timers.count).toBe(0);
    await sync.flush();
    expect(api.state.saves).toBe(0);
    sync.update(graphWith('fixed'));
    expect(sync.getSnapshot().status).toBe('dirty');
  });

  it('reports transport errors and retries on the next edit', async () => {
    const { api, timers, sync } = setup();
    const failing = new DraftSync({
      revision: 1,
      graph: graphWith('v1'),
      save: () => Promise.reject(new Error('offline')),
      load: api.load,
      isConflict: (error) => error instanceof Conflict,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    failing.update(graphWith('a'));
    await failing.flush();
    expect(failing.getSnapshot().status).toBe('error');
    failing.update(graphWith('b'));
    expect(failing.getSnapshot().status).toBe('dirty');
    expect(timers.count).toBe(1);
    sync.dispose();
  });
});
