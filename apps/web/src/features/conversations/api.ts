import type {
  Conversation,
  ConversationChannel,
  ConversationMessage,
  ConversationStatus,
  Page,
} from '@amable/api-types';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { apiFetch } from '../../lib/api';

/** Shared inbox: REST v2 `/conversations` of the active workspace. */

export type { Conversation, ConversationChannel, ConversationMessage, ConversationStatus };

export type InboxView = 'open' | 'mine' | 'unassigned' | 'pending' | 'closed';

export interface InboxCounts {
  readonly open: number;
  readonly unassigned: number;
  readonly mine: number;
  readonly unread: number;
}

/** The inbox has no push channel yet: lists and threads refresh on this interval. */
export const INBOX_POLL_MS = 15_000;

function viewQuery(view: InboxView): Record<string, string> {
  switch (view) {
    case 'mine':
      return { assigned_to: 'me' };
    case 'unassigned':
      return { status: 'open', assigned_to: 'none' };
    default:
      return { status: view };
  }
}

export function conversationsApi(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}/conversations`;
  const send = <T>(method: string, path: string, body: unknown) => apiFetch<T>(`${base}${path}`, { method, body: JSON.stringify(body) });
  return {
    list: (view: InboxView, cursor?: string) =>
      apiFetch<Page<Conversation>>(`${base}?${new URLSearchParams({ ...viewQuery(view), limit: '50', ...(cursor === undefined ? {} : { cursor }) }).toString()}`),
    ofContact: (contactId: string) => apiFetch<Page<Conversation>>(`${base}?${new URLSearchParams({ contact_id: contactId, limit: '20' }).toString()}`),
    counts: () => apiFetch<InboxCounts>(`${base}/counts`),
    channels: () => apiFetch<{ data: ConversationChannel[] }>(`${base}/channels`),
    get: (id: string) => apiFetch<{ data: Conversation }>(`${base}/${encodeURIComponent(id)}`),
    messages: (id: string, cursor?: string) =>
      apiFetch<Page<ConversationMessage>>(
        `${base}/${encodeURIComponent(id)}/messages?${new URLSearchParams({ limit: '50', ...(cursor === undefined ? {} : { cursor }) }).toString()}`,
      ),
    update: (id: string, data: { status?: ConversationStatus; assigned_to?: string | null }) =>
      send<{ data: Conversation }>('PATCH', `/${encodeURIComponent(id)}`, data),
    read: (id: string) => send<{ data: Conversation }>('POST', `/${encodeURIComponent(id)}/read`, {}),
    reply: (id: string, input: { text: string; note?: boolean }) =>
      send<{ data: ConversationMessage }>('POST', `/${encodeURIComponent(id)}/messages`, input),
    start: (input: { channel: string; contact_id: string; text: string }) =>
      send<{ data: Conversation; message: ConversationMessage }>('POST', '', input),
  };
}

export const conversationKeys = {
  all: (slug: string) => ['conversations', slug] as const,
  list: (slug: string, view: InboxView) => ['conversations', slug, 'list', view] as const,
  ofContact: (slug: string, contactId: string) => ['conversations', slug, 'contact', contactId] as const,
  counts: (slug: string) => ['conversations', slug, 'counts'] as const,
  channels: (slug: string) => ['conversations', slug, 'channels'] as const,
  one: (slug: string, id: string) => ['conversations', slug, 'one', id] as const,
  messages: (slug: string, id: string) => ['conversations', slug, 'messages', id] as const,
};

export function useConversationsApi() {
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  return { slug, api: conversationsApi(slug) };
}

export function useInbox(view: InboxView) {
  const { slug, api } = useConversationsApi();
  return useInfiniteQuery({
    queryKey: conversationKeys.list(slug, view),
    queryFn: ({ pageParam }) => api.list(view, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: INBOX_POLL_MS,
  });
}

export function useInboxCounts(enabled = true) {
  const { slug, api } = useConversationsApi();
  return useQuery({ queryKey: conversationKeys.counts(slug), queryFn: api.counts, refetchInterval: INBOX_POLL_MS, enabled });
}

export function useChannels(enabled = true) {
  const { slug, api } = useConversationsApi();
  return useQuery({ queryKey: conversationKeys.channels(slug), queryFn: async () => (await api.channels()).data, staleTime: 60_000, enabled });
}

export function useConversation(id: string | undefined) {
  const { slug, api } = useConversationsApi();
  return useQuery({
    queryKey: conversationKeys.one(slug, id ?? ''),
    queryFn: async () => (await api.get(id!)).data,
    enabled: id !== undefined,
    refetchInterval: INBOX_POLL_MS,
  });
}

export function useThread(id: string | undefined) {
  const { slug, api } = useConversationsApi();
  return useInfiniteQuery({
    queryKey: conversationKeys.messages(slug, id ?? ''),
    queryFn: ({ pageParam }) => api.messages(id!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: id !== undefined,
    refetchInterval: INBOX_POLL_MS,
  });
}

export function useContactConversations(contactId: string, enabled = true) {
  const { slug, api } = useConversationsApi();
  return useQuery({ queryKey: conversationKeys.ofContact(slug, contactId), queryFn: async () => (await api.ofContact(contactId)).data, enabled });
}

/** Mutations refresh the whole inbox: lists, counters and the open thread. */
export function useInboxMutation<I, O>(fn: (api: ReturnType<typeof conversationsApi>, input: I) => Promise<O>) {
  const { slug, api } = useConversationsApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: I) => fn(api, input),
    onSettled: () => client.invalidateQueries({ queryKey: conversationKeys.all(slug) }),
  });
}

export function channelName(channels: readonly ConversationChannel[] | undefined, id: string, locale: string): string {
  const channel = channels?.find((c) => c.id === id);
  if (channel === undefined) return id;
  return (locale === 'it' ? channel.name.it : undefined) ?? channel.name.en;
}
