import type { AutomationDetail, AutomationGraph } from '@amable/api-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { automationKeys, isConflict, useAutomationApi } from '../../api/hooks';
import { DraftSync } from '../../lib/draft-sync';
import { localIssues } from '../../lib/issues';

/** Debounced draft saves of the canvas graph, with conflict detection. */
export function useDraftAutosave(detail: AutomationDetail, graphJson: string, readOnly: boolean) {
  const { slug, api } = useAutomationApi();
  const queryClient = useQueryClient();
  const automationId = detail.id;

  const syncRef = useRef<DraftSync | null>(null);
  if (syncRef.current === null) {
    syncRef.current = new DraftSync({
      revision: detail.draft_revision,
      graph: detail.draft_graph,
      save: async (graph, revision) => {
        const saved = await api.saveDraft(automationId, graph, revision);
        return { revision: saved.draft_revision, graph: saved.draft_graph };
      },
      load: async () => {
        const fresh = await api.get(automationId);
        return { revision: fresh.draft_revision, graph: fresh.draft_graph };
      },
      check: localIssues,
      isConflict,
    });
  }
  const sync = syncRef.current;
  useEffect(() => () => sync.dispose(), [sync]);
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot);

  useEffect(() => {
    if (!readOnly) sync.update(JSON.parse(graphJson) as AutomationGraph);
  }, [graphJson, readOnly, sync]);

  // Refresh list/detail metadata (unpublished changes badge) after saves.
  useEffect(() => {
    if (snapshot.status === 'saved' && snapshot.savedAt !== null) {
      void queryClient.invalidateQueries({
        queryKey: automationKeys.detail(slug, automationId),
        exact: true,
      });
    }
  }, [snapshot.savedAt, snapshot.status, queryClient, slug, automationId]);

  return { sync, snapshot };
}

/** Warns before leaving with unsaved edits and flushes them on unmount. */
export function useFlushOnLeave(sync: DraftSync): void {
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      const status = sync.getSnapshot().status;
      if (status === 'dirty' || status === 'saving' || status === 'invalid') event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      void sync.flush();
    };
  }, [sync]);
}
