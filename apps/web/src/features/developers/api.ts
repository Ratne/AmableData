import type {
  DomainKind,
  TenantDomain,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryStatus as DeliveryStatus,
  WebhookEndpoint,
} from '@amable/api-types';
import type { Permission } from '@amable/core';
import { toast } from '@amable/ui';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ApiError, apiFetch } from '../../lib/api';
import { useTenantMeQuery } from '../../lib/feature-hooks';

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: Permission[];
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
}

export type {
  DeliveryStatus,
  DomainKind,
  TenantDomain,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookEndpoint,
};

export interface DomainList {
  readonly automation: 'cloudflare' | 'fake' | 'manual';
  readonly edge_hostname: string;
  readonly data: TenantDomain[];
}

export interface SendingStatus {
  readonly state: 'verified' | 'unverified' | 'dev_override';
  readonly can_send: boolean;
  readonly verified_domains: string[];
  /** Absent on servers older than the field. */
  readonly dns_update_needed?: string[];
}

export function developersApi(slug: string) {
  const admin = `/api/t/${encodeURIComponent(slug)}`;
  const v2 = `/api/v2/t/${encodeURIComponent(slug)}`;
  const post = <T>(path: string, body: unknown = {}) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
  return {
    apiKeys: {
      list: () => apiFetch<{ apiKeys: ApiKey[] }>(`${admin}/api-keys`),
      create: (input: { name: string; scopes: Permission[] }) =>
        post<{ id: string; key: string; prefix: string; scopes: Permission[] }>(`${admin}/api-keys`, input),
      revoke: (id: string) => apiFetch<{ ok: true }>(`${admin}/api-keys/${id}`, { method: 'DELETE' }),
    },
    webhooks: {
      eventTypes: () => apiFetch<{ data: string[] }>(`${v2}/webhooks/event-types`),
      list: () => apiFetch<{ data: WebhookEndpoint[] }>(`${v2}/webhooks`),
      create: (input: { url: string; description?: string; event_types: string[] }) =>
        post<{ endpoint: WebhookEndpoint; secret: string }>(`${v2}/webhooks`, input),
      update: (id: string, input: Partial<Pick<WebhookEndpoint, 'url' | 'description' | 'event_types' | 'status'>>) =>
        apiFetch<WebhookEndpoint>(`${v2}/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
      remove: (id: string) => apiFetch<{ ok: true }>(`${v2}/webhooks/${id}`, { method: 'DELETE' }),
      rotate: (id: string) => post<{ secret: string }>(`${v2}/webhooks/${id}/rotate-secret`),
      test: (id: string) => post<WebhookDelivery>(`${v2}/webhooks/${id}/test`),
      deliveries: (id: string, status?: DeliveryStatus) =>
        apiFetch<{ data: WebhookDelivery[] }>(
          `${v2}/webhooks/${id}/deliveries?limit=100${status ? `&status=${status}` : ''}`,
        ),
      delivery: (id: string) => apiFetch<WebhookDeliveryDetail>(`${v2}/webhooks/deliveries/${id}`),
      replay: (id: string) => post<WebhookDelivery>(`${v2}/webhooks/deliveries/${id}/replay`),
    },
    domains: {
      list: () => apiFetch<DomainList>(`${v2}/domains`),
      add: (input: { kind: DomainKind; hostname: string; paths?: string[] }) =>
        post<TenantDomain>(`${v2}/domains`, input),
      applyDns: (id: string) => post<TenantDomain>(`${v2}/domains/${id}/apply-dns`),
      verify: (id: string) => post<TenantDomain>(`${v2}/domains/${id}/verify`),
      remove: (id: string) => apiFetch<{ ok: true }>(`${v2}/domains/${id}`, { method: 'DELETE' }),
      sendingStatus: () => apiFetch<SendingStatus>(`${v2}/domains/sending-status`),
    },
  };
}

export type DevelopersApi = ReturnType<typeof developersApi>;

export const devKeys = {
  root: (slug: string) => ['developers', slug] as const,
  apiKeys: (slug: string) => ['developers', slug, 'api-keys'] as const,
  webhooks: (slug: string) => ['developers', slug, 'webhooks'] as const,
  eventTypes: (slug: string) => ['developers', slug, 'event-types'] as const,
  deliveries: (slug: string, id: string, status: string) => ['developers', slug, 'deliveries', id, status] as const,
  domains: (slug: string) => ['developers', slug, 'domains'] as const,
  sending: (slug: string) => ['developers', slug, 'sending-status'] as const,
};

export function useDevelopersApi(): { slug: string; api: DevelopersApi } {
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  return { slug, api: developersApi(slug) };
}

export function useTenantAccess() {
  const { slug } = useDevelopersApi();
  const me = useTenantMeQuery(slug);
  const set = new Set(me.data?.permissions ?? []);
  return {
    role: me.data?.role ?? null,
    permissions: me.data?.permissions ?? [],
    can: (p: Permission) => set.has(p),
    ready: me.isSuccess,
  };
}

/** Sending status for banners in the email surfaces (marketing email blocked until a domain is verified). */
export function useSendingStatus(slug: string) {
  return useQuery({
    queryKey: devKeys.sending(slug),
    queryFn: () => developersApi(slug).domains.sendingStatus(),
    staleTime: 60_000,
    retry: false,
  });
}

export function apiErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? `HTTP ${String(error.status)}`;
  return error instanceof Error ? error.message : String(error);
}

export function useDevMutation<TInput, TOutput>(options: {
  mutationFn: (input: TInput) => Promise<TOutput>;
  invalidate?: readonly QueryKey[];
  success?: string;
  onSuccess?: (output: TOutput) => void;
  /** Return true when the error was handled (e.g. a step-up was started). */
  onError?: (error: unknown, input: TInput) => boolean;
}) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (output) => {
      for (const key of options.invalidate ?? []) await client.invalidateQueries({ queryKey: key });
      if (options.success !== undefined) toast.success(options.success);
      options.onSuccess?.(output);
    },
    onError: (error, input) => {
      if (options.onError?.(error, input) === true) return;
      toast.error(apiErrorCode(error));
    },
  });
}
