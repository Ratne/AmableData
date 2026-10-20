import type {
  CreateFolderInput,
  DeleteFolderResult,
  Folder,
  FolderKind,
  FolderTree,
  MoveFolderItemsResult,
  UpdateFolderInput,
} from '@amable/api-types';
import { toast } from '@amable/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import { request } from '../../lib/tenant-api';
import { errorMessage, useTenantSlug } from '../crm/api/hooks';

const PATHS: Record<FolderKind, string> = {
  automation: 'automationFolders',
  page: 'pageFolders',
};

export const folderKeys = {
  tree: (slug: string, kind: FolderKind) => ['folders', slug, kind] as const,
};

/** REST v2 client of one folder tree (`/automationFolders` or `/pageFolders`). */
export function folderClient(slug: string, kind: FolderKind) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}/${PATHS[kind]}`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    tree: () => request<FolderTree>(base),
    create: (input: CreateFolderInput) => request<Folder>(base, { method: 'POST', json: input }),
    update: (id: string, input: UpdateFolderInput) =>
      request<Folder>(one(id), { method: 'PATCH', json: input }),
    remove: (id: string, mode: 'empty' | 'move_to_parent') =>
      request<DeleteFolderResult>(one(id), { method: 'DELETE', query: { mode } }),
    moveItems: (ids: readonly string[], folderId: string | null) =>
      request<MoveFolderItemsResult>(`${base}/moveItems`, {
        method: 'POST',
        json: { ids, folder_id: folderId },
      }),
  };
}

export type FolderClient = ReturnType<typeof folderClient>;

export function useFolderTree(kind: FolderKind) {
  const slug = useTenantSlug();
  const api = useMemo(() => folderClient(slug, kind), [slug, kind]);
  const tree = useQuery({ queryKey: folderKeys.tree(slug, kind), queryFn: () => api.tree() });
  return { slug, api, tree };
}

/**
 * Folder mutations: every success refreshes the tree (counts) and the
 * `itemsKey` list of the page, then toasts.
 */
export function useFolderMutation<TInput, TResult>(
  kind: FolderKind,
  itemsKey: QueryKey,
  mutationFn: (api: FolderClient, input: TInput) => Promise<TResult>,
  success?: (result: TResult, input: TInput) => string | null,
) {
  const slug = useTenantSlug();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const api = useMemo(() => folderClient(slug, kind), [slug, kind]);
  return useMutation({
    mutationFn: (input: TInput) => mutationFn(api, input),
    onSuccess: async (result, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: folderKeys.tree(slug, kind) }),
        queryClient.invalidateQueries({ queryKey: itemsKey }),
      ]);
      const message = success?.(result, input) ?? null;
      if (message !== null) toast.success(message);
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });
}
