import type {
  Automation,
  ContactEnrollment,
  ContactSubmission,
  ContactSubmissionDetail,
  EmailMessage,
  Enrollment,
} from '@amable/api-types';
import type { ContactCounts, ContactTag, Page } from '@amable/api-types/crm';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { request } from './client';
import { crmKeys, useCrm } from './hooks';

/**
 * Reads behind the contact page tabs that are not part of the CRM client:
 * the contact's tags, tab counts, form submissions, emails (MailDb) and
 * automation enrollments (Engine DO). Every hook is `enabled` only while its
 * tab is open.
 */

export const CONTACT_TAGS_PAGE = 50;
const LIST_PAGE = 25;
export const AUTOMATION_SEARCH_PAGE = 20;

export function contactTabsClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const id = (value: string) => encodeURIComponent(value);
  return {
    tags: (contactId: string, query: { q?: string; cursor?: string; limit?: number }) =>
      request<Page<ContactTag>>(`${base}/contacts/${id(contactId)}/tags`, { query }),
    counts: (contactId: string) =>
      request<ContactCounts>(`${base}/contacts/${id(contactId)}/counts`),
    emails: (contactId: string, query: { cursor?: string; limit?: number }) =>
      request<Page<EmailMessage>>(`${base}/contacts/${id(contactId)}/emails`, { query }),
    enrollments: (
      contactId: string,
      query: { scope: 'current' | 'history'; cursor?: string; limit?: number },
    ) =>
      request<Page<ContactEnrollment>>(`${base}/contacts/${id(contactId)}/automations`, { query }),
    submissions: (contactId: string, query: { cursor?: string; limit?: number }) =>
      request<Page<ContactSubmission>>(`${base}/contacts/${id(contactId)}/submissions`, { query }),
    submission: (contactId: string, submissionId: string) =>
      request<ContactSubmissionDetail>(
        `${base}/contacts/${id(contactId)}/submissions/${id(submissionId)}`,
      ),
    publishedAutomations: (query: { q?: string; cursor?: string }) =>
      request<Page<Automation>>(`${base}/automations`, {
        query: { status: 'active', limit: AUTOMATION_SEARCH_PAGE, ...query },
      }),
    enroll: (automationId: string, contactId: string) =>
      request<Enrollment>(`${base}/automations/${id(automationId)}/enrollments`, {
        method: 'POST',
        json: { contact_id: contactId },
      }),
    unenroll: (automationId: string, contactId: string) =>
      request<{ contact_id: string; removed: boolean }>(
        `${base}/automations/${id(automationId)}/contacts/${id(contactId)}`,
        { method: 'DELETE' },
      ),
  };
}

export const contactTabKeys = {
  counts: (slug: string, contactId: string) =>
    [...crmKeys.contact(slug, contactId), 'counts'] as const,
  tags: (slug: string, contactId: string, q: string) =>
    [...crmKeys.contact(slug, contactId), 'tags', q] as const,
  emails: (slug: string, contactId: string) =>
    [...crmKeys.contact(slug, contactId), 'emails'] as const,
  submissions: (slug: string, contactId: string) =>
    [...crmKeys.contact(slug, contactId), 'submissions'] as const,
  submission: (slug: string, contactId: string, submissionId: string) =>
    [...crmKeys.contact(slug, contactId), 'submissions', submissionId] as const,
  /** Under `['automations', slug]`, so publishing or deleting refreshes the search. */
  automationSearch: (slug: string, q: string) => ['automations', slug, 'search', q] as const,
  /** Not under `['crm', …]`: automation mutations invalidate `['automations', slug]`. */
  enrollments: (slug: string, contactId: string, scope: 'current' | 'history') =>
    ['automations', slug, 'contact', contactId, scope] as const,
};

export function useContactTabsApi() {
  const { slug } = useCrm();
  return { slug, tabsApi: contactTabsClient(slug) };
}

export function useContactCounts(contactId: string) {
  const { slug, tabsApi } = useContactTabsApi();
  return useQuery({
    queryKey: contactTabKeys.counts(slug, contactId),
    queryFn: () => tabsApi.counts(contactId),
    staleTime: 30_000,
  });
}

export function useContactTags(contactId: string, q: string, enabled: boolean) {
  const { slug, tabsApi } = useContactTabsApi();
  const query = q.trim();
  return useInfiniteQuery({
    queryKey: contactTabKeys.tags(slug, contactId, query),
    queryFn: ({ pageParam }) =>
      tabsApi.tags(contactId, {
        limit: CONTACT_TAGS_PAGE,
        ...(query === '' ? {} : { q: query }),
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useContactEmails(contactId: string) {
  const { slug, tabsApi } = useContactTabsApi();
  return useInfiniteQuery({
    queryKey: contactTabKeys.emails(slug, contactId),
    queryFn: ({ pageParam }) => tabsApi.emails(contactId, { limit: LIST_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

export function useContactEnrollments(contactId: string, scope: 'current' | 'history') {
  const { slug, tabsApi } = useContactTabsApi();
  return useInfiniteQuery({
    queryKey: contactTabKeys.enrollments(slug, contactId, scope),
    queryFn: ({ pageParam }) =>
      tabsApi.enrollments(contactId, { scope, limit: LIST_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

export function useContactSubmissions(contactId: string) {
  const { slug, tabsApi } = useContactTabsApi();
  return useInfiniteQuery({
    queryKey: contactTabKeys.submissions(slug, contactId),
    queryFn: ({ pageParam }) =>
      tabsApi.submissions(contactId, { limit: LIST_PAGE, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
}

export function useContactSubmission(contactId: string, submissionId: string | null) {
  const { slug, tabsApi } = useContactTabsApi();
  return useQuery({
    queryKey: contactTabKeys.submission(slug, contactId, submissionId ?? ''),
    queryFn: () => tabsApi.submission(contactId, submissionId ?? ''),
    enabled: submissionId !== null,
  });
}

/** Published automations whose name contains `q`, server-side, page by page. */
export function useAutomationSearch(q: string, enabled: boolean) {
  const { slug, tabsApi } = useContactTabsApi();
  const query = q.trim();
  return useInfiniteQuery({
    queryKey: contactTabKeys.automationSearch(slug, query),
    queryFn: ({ pageParam }) =>
      tabsApi.publishedAutomations({
        ...(query === '' ? {} : { q: query }),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    enabled,
  });
}
