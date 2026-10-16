import type { IdeaStatus, TicketCategory, TicketStatus } from '@amable/core/platform';
import { formatDateTime, type MessageKey } from '@amable/i18n';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useI18n } from '../../i18n';
import { ApiError, apiFetch } from '../../lib/api';
import { stepUpFetch } from '../../lib/step-up';

export const TICKET_CATEGORIES: readonly TicketCategory[] = ['question', 'bug', 'billing', 'feature', 'other'];
export const IDEA_STATUSES: readonly IdeaStatus[] = ['under_review', 'planned', 'released'];
export const COMMUNITY_URL = 'https://community.amabledata.com';

export interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly category: TicketCategory;
  readonly status: TicketStatus;
  readonly requester: { readonly id: string; readonly name: string | null; readonly kind: string };
  readonly createdAt: string;
  readonly lastMessageAt: string;
}

export interface TicketMessage {
  readonly id: string;
  readonly authorKind: 'customer' | 'crm_user' | 'staff';
  readonly authorName: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface TicketAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly createdAt: string;
}

export interface TicketDetail {
  readonly ticket: Ticket;
  readonly messages: readonly TicketMessage[];
  readonly attachments: readonly TicketAttachment[];
}

export interface Idea {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: IdeaStatus;
  readonly releasedIn: string | null;
  readonly votes: number;
  readonly votedByMe: boolean;
}

export interface ChangelogEntry {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly version: string | null;
  readonly publishedAt: string;
}

export interface AssistSession {
  readonly id: string;
  readonly grantId: string;
  readonly staffName: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly endedAt: number | null;
  readonly active?: boolean;
}

export interface AssistGrant {
  readonly id: string;
  readonly reason: string;
  readonly ticketId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly mirrored: boolean;
  readonly state: 'active' | 'revoked' | 'expired';
}

export interface AssistStatus {
  readonly available: boolean;
  readonly canManage: boolean;
  readonly supportSession: boolean;
  readonly grants: readonly { readonly id: string; readonly expiresAt: number }[];
  readonly sessions: readonly AssistSession[];
}

export const supportKeys = {
  root: (slug: string) => ['support', slug] as const,
  tickets: (slug: string) => ['support', slug, 'tickets'] as const,
  ticket: (slug: string, id: string) => ['support', slug, 'ticket', id] as const,
  ideas: (slug: string) => ['support', slug, 'ideas'] as const,
  status: (slug: string) => ['support', slug, 'assist-status'] as const,
  grants: (slug: string) => ['support', slug, 'assist-grants'] as const,
};

export function base(slug: string): string {
  return `/api/t/${encodeURIComponent(slug)}/platform`;
}

export function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  return apiFetch<T>(path, { method, body: JSON.stringify(body) });
}

/** Multipart upload (apiFetch would force a JSON content type). */
export async function uploadAttachment(slug: string, ticketId: string, file: File): Promise<void> {
  const form = new FormData();
  form.set('file', file);
  const response = await stepUpFetch(`${base(slug)}/support/tickets/${ticketId}/attachments`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
    headers: { 'x-amable-csrf': '1' },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(response.status, body?.error ?? null);
  }
}

export function isUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'platform_unavailable';
}

export function errorKey(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'sup.error.generic';
  if (error.status === 413) return 'sup.error.tooLarge';
  if (error.status === 415) return 'sup.error.type';
  if (error.status === 503) return 'sup.error.unreachable';
  if (error.status === 402) return 'sup.error.suspended';
  return 'sup.error.generic';
}

export function useDate() {
  const { locale } = useI18n();
  return useCallback(
    (value: string | number) => formatDateTime(locale, typeof value === 'number' ? value : Date.parse(value)),
    [locale],
  );
}

/** Banner + panel state; polled so a revoke or a new support session shows up quickly. */
export function useAssistStatus(slug: string) {
  return useQuery({
    queryKey: supportKeys.status(slug),
    queryFn: () => apiFetch<AssistStatus>(`${base(slug)}/assist/status`),
    refetchInterval: 60_000,
    retry: false,
    staleTime: 30_000,
  });
}
