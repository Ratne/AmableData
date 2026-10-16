import type { AutomationGraph } from '@amable/api-types';

/**
 * Autosave of the draft graph with the server's optimistic lock.
 *
 * - `update(graph)` marks the draft dirty and schedules a save after a pause;
 * - one save at a time; edits made while a save is in flight are saved next,
 *   with the revision returned by the previous save;
 * - a 409 (someone else saved first) stops autosave in the `conflict` state:
 *   the user either reloads the server draft (`resolveWithServer`) or keeps
 *   their own (`resolveKeepMine`, which saves on top of the latest revision);
 * - a draft that fails the local check (shape the server would reject) is not
 *   sent: state `invalid` until it is fixed.
 */

export type DraftStatus = 'saved' | 'dirty' | 'saving' | 'invalid' | 'error' | 'conflict';

export interface SavedDraft {
  readonly revision: number;
  readonly graph: AutomationGraph;
}

export interface DraftSyncOptions {
  readonly revision: number;
  readonly graph: AutomationGraph;
  readonly save: (graph: AutomationGraph, revision: number) => Promise<SavedDraft>;
  /** Current server draft (for conflict resolution). */
  readonly load: () => Promise<SavedDraft>;
  /** Problems that would make the server reject the graph (empty = savable). */
  readonly check?: (graph: AutomationGraph) => readonly unknown[];
  readonly isConflict: (error: unknown) => boolean;
  readonly debounceMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface DraftSyncSnapshot {
  readonly status: DraftStatus;
  readonly revision: number;
  readonly error: unknown;
  readonly savedAt: number | null;
}

function sameGraph(a: AutomationGraph, b: AutomationGraph): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class DraftSync {
  private revision: number;
  private saved: AutomationGraph;
  private current: AutomationGraph;
  private status: DraftStatus = 'saved';
  private error: unknown = null;
  private savedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: DraftSyncSnapshot;

  constructor(private readonly options: DraftSyncOptions) {
    this.revision = options.revision;
    this.saved = options.graph;
    this.current = options.graph;
    this.snapshot = this.makeSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DraftSyncSnapshot => this.snapshot;

  get graph(): AutomationGraph {
    return this.current;
  }

  private makeSnapshot(): DraftSyncSnapshot {
    return {
      status: this.status,
      revision: this.revision,
      error: this.error,
      savedAt: this.savedAt,
    };
  }

  private set(status: DraftStatus, error: unknown = null): void {
    this.status = status;
    this.error = error;
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  private problems(graph: AutomationGraph): readonly unknown[] {
    return this.options.check?.(graph) ?? [];
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      (this.options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(
        this.timer,
      );
      this.timer = null;
    }
  }

  private schedule(): void {
    this.cancelTimer();
    const setTimer = this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.options.debounceMs ?? 1200);
  }

  /** Records a local edit. */
  update(graph: AutomationGraph): void {
    this.current = graph;
    if (this.status === 'conflict') return;
    if (sameGraph(graph, this.saved)) {
      this.cancelTimer();
      if (this.inFlight === null) this.set('saved');
      return;
    }
    if (this.problems(graph).length > 0) {
      this.cancelTimer();
      if (this.inFlight === null) this.set('invalid');
      return;
    }
    if (this.inFlight === null) this.set('dirty');
    this.schedule();
  }

  /** Saves now (waits for a save in flight first). Resolves when nothing is left to save. */
  async flush(): Promise<void> {
    this.cancelTimer();
    while (this.inFlight !== null) await this.inFlight;
    if (this.status === 'conflict') return;
    const graph = this.current;
    if (sameGraph(graph, this.saved)) {
      this.set('saved');
      return;
    }
    if (this.problems(graph).length > 0) {
      this.set('invalid');
      return;
    }
    this.set('saving');
    this.inFlight = (async () => {
      try {
        const result = await this.options.save(graph, this.revision);
        this.revision = result.revision;
        this.saved = graph;
        this.savedAt = Date.now();
        this.set('saved');
      } catch (error) {
        this.set(this.options.isConflict(error) ? 'conflict' : 'error', error);
      }
    })();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    // Edits made while saving.
    if (this.status === 'saved' && !sameGraph(this.current, this.saved)) await this.flush();
  }

  /** Discards local edits and adopts the server draft; returns it for the canvas. */
  async resolveWithServer(): Promise<SavedDraft> {
    this.cancelTimer();
    const server = await this.options.load();
    this.reset(server);
    return server;
  }

  /** Saves the local draft over the latest server revision. */
  async resolveKeepMine(): Promise<void> {
    const server = await this.options.load();
    this.revision = server.revision;
    this.saved = server.graph;
    this.set(sameGraph(this.current, this.saved) ? 'saved' : 'dirty');
    await this.flush();
  }

  /** Adopts a draft received from elsewhere (version restore, reload). */
  reset(draft: SavedDraft): void {
    this.cancelTimer();
    this.revision = draft.revision;
    this.saved = draft.graph;
    this.current = draft.graph;
    this.set('saved');
  }

  /** Revision after the last successful save. */
  get currentRevision(): number {
    return this.revision;
  }

  dispose(): void {
    this.cancelTimer();
    this.listeners.clear();
  }
}
