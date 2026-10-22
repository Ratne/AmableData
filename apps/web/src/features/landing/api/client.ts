import { elementNodeSchema, type BuilderDocument, type ElementNode } from '@amable/builder';
import { TenantApiError, tenantRest } from '../../../lib/tenant-api';

export { TenantApiError as LandingApiError } from '../../../lib/tenant-api';
import type {
  AnalyticsSiteOption,
  CreatePageInput,
  CursorPage,
  EventTypeOption,
  FormOption,
  LandingPage,
  LandingPageWithDraft,
  MediaFile,
  PageStatus,
  PageVersion,
  SavedSection,
  UpdatePageInput,
} from './types';

/**
 * Typed client of the pages REST v2 surface (`/api/v2/t/{slug}`) plus the
 * lookups the editor needs (forms, booking event types, analytics sites).
 */

export interface ListPagesParams {
  readonly q?: string;
  readonly status?: PageStatus;
  readonly folder_id?: string;
  readonly include_subfolders?: 'true';
  readonly cursor?: string;
  readonly limit?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Accepts `{data: [...]}` or a bare array (the booking API is still being built). */
function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = asRecord(payload)?.['data'];
  return Array.isArray(data) ? data : [];
}

function eventTypeOptions(payload: unknown): EventTypeOption[] {
  const out: EventTypeOption[] = [];
  for (const item of listOf(payload)) {
    const row = asRecord(item);
    const slug = row?.['slug'];
    if (typeof slug !== 'string' || slug === '') continue;
    const name = row?.['name'] ?? row?.['title'];
    out.push({ slug, name: typeof name === 'string' && name !== '' ? name : slug });
  }
  return out;
}

export function landingClient(slug: string) {
  const { base, call, get, post, patch, del, me } = tenantRest(slug, { idempotent: false });
  const id = encodeURIComponent;
  const page = (pageId: string) => `/pages/${id(pageId)}`;

  return {
    base,
    me,
    pages: {
      list: (params: ListPagesParams = {}) =>
        get<CursorPage<LandingPage>>('/pages', { limit: 100, ...params }),
      get: (pageId: string) => get<LandingPageWithDraft>(page(pageId)),
      create: (input: CreatePageInput) => post<LandingPage>('/pages', input),
      update: (pageId: string, input: UpdatePageInput) => patch<LandingPage>(page(pageId), input),
      remove: (pageId: string) => del<unknown>(page(pageId)),
      restore: (pageId: string) => post<LandingPage>(`${page(pageId)}/restore`),
      duplicate: (pageId: string) => post<LandingPage>(`${page(pageId)}/duplicate`),
      saveDraft: (
        pageId: string,
        document: BuilderDocument,
        baseRevision: number,
        keepalive = false,
      ) =>
        call<{ draft_revision: number }>(`${page(pageId)}/draft`, {
          method: 'PUT',
          json: { document, base_revision: baseRevision },
          keepalive,
        }),
      publish: (pageId: string, note?: string) =>
        post<{ page: LandingPage; version: PageVersion }>(
          `${page(pageId)}/publish`,
          note ? { note } : {},
        ),
      unpublish: (pageId: string) => post<LandingPage>(`${page(pageId)}/unpublish`),
      versions: (pageId: string) => get<{ data: PageVersion[] }>(`${page(pageId)}/versions`),
      restoreVersion: (pageId: string, versionId: string) =>
        post<unknown>(`${page(pageId)}/versions/${id(versionId)}/restore`),
      preview: (pageId: string) => get<{ html: string }>(`${page(pageId)}/preview`),
    },
    savedSections: {
      list: async (): Promise<SavedSection[]> => {
        const out: SavedSection[] = [];
        for (const item of listOf(await get<unknown>('/savedSections'))) {
          const row = item as Omit<SavedSection, 'node'> & { node: unknown };
          const node = elementNodeSchema.safeParse(row.node);
          if (node.success) out.push({ ...row, node: node.data });
        }
        return out;
      },
      create: (input: { name: string; category: string | null; node: ElementNode }) =>
        post<SavedSection>('/savedSections', input),
      update: (sectionId: string, input: { name?: string; category?: string | null }) =>
        patch<SavedSection>(`/savedSections/${id(sectionId)}`, input),
      remove: (sectionId: string) => del<unknown>(`/savedSections/${id(sectionId)}`),
    },
    media: {
      list: (cursor?: string) => get<CursorPage<MediaFile>>('/media', { limit: 60, cursor }),
      upload: (file: File) =>
        call<MediaFile>('/media', {
          method: 'PUT',
          query: { filename: file.name },
          raw: file,
          contentType: file.type || 'application/octet-stream',
        }),
      remove: (mediaId: string) => del<unknown>(`/media/${id(mediaId)}`),
    },
    lookups: {
      forms: async (): Promise<FormOption[]> => {
        const payload = await get<unknown>('/forms', { limit: 200 });
        const out: FormOption[] = [];
        for (const item of listOf(payload)) {
          const row = asRecord(item);
          const formId = row?.['id'];
          const name = row?.['name'];
          if (typeof formId === 'string')
            out.push({ id: formId, name: typeof name === 'string' ? name : formId });
        }
        return out;
      },
      /** `null` when the booking module is not deployed (404). */
      eventTypes: async (): Promise<EventTypeOption[] | null> => {
        try {
          return eventTypeOptions(await get<unknown>('/bookingEventTypes'));
        } catch (error) {
          if (error instanceof TenantApiError && (error.status === 404 || error.status === 501))
            return null;
          throw error;
        }
      },
      analyticsSites: async (): Promise<AnalyticsSiteOption[]> => {
        const payload = await get<{ data: AnalyticsSiteOption[] }>('/analytics/sites');
        return payload.data;
      },
    },
  };
}

export type LandingClient = ReturnType<typeof landingClient>;
