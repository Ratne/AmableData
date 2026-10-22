import type { Permission } from '@amable/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../../../i18n';
import {
  apiErrorMessage,
  type ApiMutationOptions,
  REFERENCE_STALE_MS,
  useApiMutation,
  useGrantedPermissions,
} from '../../../lib/feature-hooks';
import { tenantRoute } from '../../../routes/tenant';
import { formatMoney } from '../lib/money';
import { fetchAllPages } from '../../../lib/api';
import { commerceClient, type CommerceClient } from './client';

/** Every commerce query of a tenant lives under ['commerce', slug, …]. */
export const commerceKeys = {
  root: (slug: string) => ['commerce', slug] as const,
  me: (slug: string) => ['commerce', slug, 'me'] as const,
  settings: (slug: string) => ['commerce', slug, 'settings'] as const,
  categories: (slug: string) => ['commerce', slug, 'categories'] as const,
  products: (slug: string) => ['commerce', slug, 'products'] as const,
  product: (slug: string, id: string) => ['commerce', slug, 'products', id] as const,
  plans: (slug: string) => ['commerce', slug, 'plans'] as const,
  promoCodes: (slug: string) => ['commerce', slug, 'promoCodes'] as const,
  orders: (slug: string) => ['commerce', slug, 'orders'] as const,
  order: (slug: string, id: string) => ['commerce', slug, 'orders', id] as const,
  payments: (slug: string) => ['commerce', slug, 'payments'] as const,
  subscriptions: (slug: string) => ['commerce', slug, 'subscriptions'] as const,
  subscription: (slug: string, id: string) => ['commerce', slug, 'subscriptions', id] as const,
  invoices: (slug: string) => ['commerce', slug, 'invoices'] as const,
  invoice: (slug: string, id: string) => ['commerce', slug, 'invoices', id] as const,
  contacts: (slug: string) => ['commerce', slug, 'contacts'] as const,
  stripe: (slug: string) => ['commerce', slug, 'stripe'] as const,
  checkouts: (slug: string) => ['commerce', slug, 'checkouts'] as const,
  checkout: (slug: string, id: string) => ['commerce', slug, 'checkouts', id] as const,
  checkoutEmbed: (slug: string, id: string) => ['commerce', slug, 'checkouts', id, 'embed'] as const,
};

export function useTenantSlug(): string {
  return useParams({ from: tenantRoute.id }).tenant;
}

export function useCommerce(): { slug: string; api: CommerceClient } {
  const slug = useTenantSlug();
  const api = useMemo(() => commerceClient(slug), [slug]);
  return { slug, api };
}

/** Active membership: tenant, role and permissions (`GET /api/t/:slug/me`). */
export function useTenantMe() {
  const { slug, api } = useCommerce();
  return useQuery({
    queryKey: commerceKeys.me(slug),
    queryFn: () => api.me(),
    staleTime: REFERENCE_STALE_MS,
    retry: false,
  });
}

/**
 * Permissions of the active membership (`GET /api/t/:slug/me`). Until they are
 * known every action is hidden; the server enforces access regardless.
 */
export function usePermissions(): { can: (permission: Permission) => boolean; ready: boolean } {
  const me = useTenantMe();
  return useGrantedPermissions(me.data);
}

/** `formatMoney` bound to the UI locale. */
export function useMoney(): (minor: number, currency: string) => string {
  const { locale } = useI18n();
  return useCallback((minor, currency) => formatMoney(minor, currency, locale), [locale]);
}

/** Date / date-time formatting bound to the UI locale. */
export function useDates(): {
  date: (iso: string | null | undefined) => string;
  dateTime: (iso: string | null | undefined) => string;
} {
  const { locale } = useI18n();
  return useMemo(() => {
    const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
    const dateTimeFormat = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const safe = (format: Intl.DateTimeFormat) => (iso: string | null | undefined) => {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? '—' : format.format(ms);
    };
    return { date: safe(dateFormat), dateTime: safe(dateTimeFormat) };
  }, [locale]);
}

export function useCommerceSettings() {
  const { slug, api } = useCommerce();
  return useQuery({
    queryKey: commerceKeys.settings(slug),
    queryFn: () => api.settings.get(),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useCategories() {
  const { slug, api } = useCommerce();
  const query = useQuery({
    queryKey: commerceKeys.categories(slug),
    queryFn: async () => (await api.categories.list()).data,
    staleTime: REFERENCE_STALE_MS,
  });
  const categories = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  return { ...query, categories, byId };
}

/** Whole catalog (bounded): products carry their plans. */
export function useCatalog() {
  const { slug, api } = useCommerce();
  const query = useQuery({
    queryKey: commerceKeys.products(slug),
    queryFn: () => fetchAllPages((cursor) => api.products.list({ cursor, limit: 200 })),
    staleTime: REFERENCE_STALE_MS,
  });
  const products = useMemo(() => query.data ?? [], [query.data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const plans = useMemo(
    () => products.flatMap((product) => product.plans.map((plan) => ({ plan, product }))),
    [products],
  );
  const planById = useMemo(() => new Map(plans.map((entry) => [entry.plan.id, entry])), [plans]);
  return { ...query, products, byId, plans, planById };
}

export interface ContactRef {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Display names of a set of contacts in one query-builder call. */
export function useContactNames(ids: readonly string[]) {
  const { slug, api } = useCommerce();
  const unique = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const query = useQuery({
    queryKey: [...commerceKeys.contacts(slug), unique],
    enabled: unique.length > 0,
    staleTime: REFERENCE_STALE_MS,
    queryFn: async () => {
      const result = await api.search({
        entity: 'contact',
        filter: {
          type: 'group',
          op: 'and',
          conditions: [{ type: 'field', field: 'id', operator: 'in', value: unique }],
        },
        columns: ['given_name', 'family_name', 'email'],
        limit: Math.min(500, unique.length),
      });
      return result.data.map((row): ContactRef => ({
        id: text(row['id']),
        name: [text(row['given_name']), text(row['family_name'])].filter(Boolean).join(' '),
        email: text(row['email']),
      }));
    },
  });
  const byId = useMemo(
    () => new Map((query.data ?? []).map((contact) => [contact.id, contact])),
    [query.data],
  );
  const nameOf = useCallback(
    (id: string) => {
      const contact = byId.get(id);
      return contact ? contact.name || contact.email || id : '…';
    },
    [byId],
  );
  return { nameOf, byId, isPending: query.isPending && unique.length > 0 };
}

type Translate = ReturnType<typeof useI18n>['t'];

/** User-facing text for an API failure. */
export function errorMessage(t: Translate, error: unknown): string {
  return apiErrorMessage(t, error, {
    forbidden: 'commerce.error.forbidden',
    notFound: 'commerce.error.notFound',
    conflict: 'commerce.error.conflict',
    validation: 'commerce.error.validation',
  });
}

export type CommerceMutationOptions<TInput, TResult> = ApiMutationOptions<TInput, TResult>;

/** `useMutation` with tenant cache invalidation and toasts. */
export function useCommerceMutation<TInput, TResult>(
  options: CommerceMutationOptions<TInput, TResult>,
) {
  const { slug } = useCommerce();
  return useApiMutation(options, commerceKeys.root(slug), errorMessage);
}
