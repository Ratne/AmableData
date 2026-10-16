import type { Permission, Role } from '@amable/core';
import { useParams } from '@tanstack/react-router';
import { ApiError, apiFetch } from '../../lib/api';

export interface Member {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: Role;
  readonly createdAt: number;
}

export interface PendingInvite {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface TenantMe {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: Role;
  readonly permissions: Permission[];
}

export function membersApi(slug: string) {
  const base = `/api/t/${encodeURIComponent(slug)}`;
  const send = <T>(method: string, path: string, body?: unknown) =>
    apiFetch<T>(`${base}${path}`, { method, body: JSON.stringify(body ?? {}) });
  return {
    me: () => apiFetch<TenantMe>(`${base}/me`),
    members: () => apiFetch<{ members: Member[] }>(`${base}/members`),
    changeRole: (userId: string, role: Role) =>
      send<{ ok: true }>('PATCH', `/members/${encodeURIComponent(userId)}`, { role }),
    remove: (userId: string) =>
      apiFetch<{ ok: true }>(`${base}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    leave: () => send<{ ok: true }>('POST', '/leave'),
    invites: () => apiFetch<{ invites: PendingInvite[] }>(`${base}/invites`),
    invite: (input: { email: string; role: Role }) =>
      send<{ id: string }>('POST', '/invites', input),
    revokeInvite: (id: string) =>
      apiFetch<{ ok: true }>(`${base}/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

export const memberKeys = {
  me: (slug: string) => ['members', slug, 'me'] as const,
  members: (slug: string) => ['members', slug, 'list'] as const,
  invites: (slug: string) => ['members', slug, 'invites'] as const,
};

export function useMembersApi() {
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  return { slug, api: membersApi(slug) };
}

/** Error code of a failed tenant-admin call (`null` for network or unexpected errors). */
export function memberErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}
