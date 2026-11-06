import type { ElementNode } from '@amable/builder';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { landingKeys, useLanding } from '../api/hooks';
import type { ClipEntry } from './use-block-clipboard';

const CHANNEL = 'amable-canvas-clipboard';
const MAX_ITEMS = 20;

export interface NewClip {
  readonly label: string;
  readonly nodes: readonly ElementNode[];
  readonly wholePage: boolean;
  readonly sourcePageName: string;
}

/**
 * Personal builder clipboard on the server. Refetched on window focus and
 * when another tab announces a change (BroadcastChannel).
 */
export function useCanvasClipboard() {
  const { slug, api } = useLanding();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: landingKeys.clipboard(slug),
    queryFn: () => api.clipboard.list(),
    refetchOnWindowFocus: true,
  });
  const items = query.data ?? [];

  const setItems = useCallback(
    (update: (prev: ClipEntry[]) => ClipEntry[]) =>
      queryClient.setQueryData<ClipEntry[]>(landingKeys.clipboard(slug), (prev) => update(prev ?? [])),
    [queryClient, slug],
  );

  const notify = useCallback(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(slug);
    channel.close();
  }, [slug]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === slug) void queryClient.invalidateQueries({ queryKey: landingKeys.clipboard(slug) });
    };
    return () => channel.close();
  }, [queryClient, slug]);

  /** Fresh list from the server; null on network failure (cache untouched). */
  const refresh = useCallback(async (): Promise<ClipEntry[] | null> => {
    try {
      return await queryClient.fetchQuery({ queryKey: landingKeys.clipboard(slug), queryFn: () => api.clipboard.list(), staleTime: 0 });
    } catch {
      return null;
    }
  }, [queryClient, slug, api]);

  /** Stores a copy; throws on failure so the caller can show the error. */
  const add = useCallback(
    async (clip: NewClip): Promise<ClipEntry> => {
      const entry = await api.clipboard.create({
        label: clip.label,
        nodes: JSON.parse(JSON.stringify(clip.nodes)) as ElementNode[],
        whole_page: clip.wholePage,
        source_page_name: clip.sourcePageName,
      });
      setItems((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)].slice(0, MAX_ITEMS));
      notify();
      return entry;
    },
    [api, setItems, notify],
  );

  const remove = useCallback(
    async (id: string) => {
      setItems((prev) => prev.filter((e) => e.id !== id));
      await api.clipboard.remove(id).catch(() => refresh());
      notify();
    },
    [api, setItems, notify, refresh],
  );

  const clear = useCallback(async () => {
    setItems(() => []);
    await api.clipboard.clear().catch(() => refresh());
    notify();
  }, [api, setItems, notify, refresh]);

  return { items, latest: items[0] ?? null, refresh, add, remove, clear };
}
