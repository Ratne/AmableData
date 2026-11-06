import type {
  CreateShortlinkFolderInput,
  CreateShortlinkInput,
  Shortlink,
  ShortlinkDomain,
  ShortlinkFolder,
  ShortlinkStats,
  UpdateShortlinkFolderInput,
  UpdateShortlinkInput,
} from '@amable/api-types';
import { tenantRest } from '../../../lib/tenant-api';

/** Typed client of the short links REST v2 surface (`/api/v2/t/{slug}/shortlinks`). */
export function shortlinksClient(slug: string) {
  const { get, post, patch, del, me } = tenantRest(slug, { idempotent: false });
  const id = encodeURIComponent;
  return {
    me,
    domains: () => get<{ data: ShortlinkDomain[] }>('/shortlinks/domains'),
    links: {
      list: (query: { include_archived?: 'true' | 'false' } = {}) =>
        get<{ data: Shortlink[] }>('/shortlinks', query),
      create: (input: CreateShortlinkInput) => post<Shortlink>('/shortlinks', input),
      update: (linkId: string, input: UpdateShortlinkInput) =>
        patch<Shortlink>(`/shortlinks/${id(linkId)}`, input),
      remove: (linkId: string) => del(`/shortlinks/${id(linkId)}`),
      stats: (linkId: string, days: number) =>
        get<ShortlinkStats>(`/shortlinks/${id(linkId)}/stats`, { days }),
    },
    folders: {
      list: () => get<{ data: ShortlinkFolder[] }>('/shortlinks/folders'),
      create: (input: CreateShortlinkFolderInput) =>
        post<ShortlinkFolder>('/shortlinks/folders', input),
      update: (folderId: string, input: UpdateShortlinkFolderInput) =>
        patch<ShortlinkFolder>(`/shortlinks/folders/${id(folderId)}`, input),
      remove: (folderId: string) =>
        del<{ id: string; deleted: true; moved_links: number }>(`/shortlinks/folders/${id(folderId)}`),
    },
  };
}

export type ShortlinksClient = ReturnType<typeof shortlinksClient>;
