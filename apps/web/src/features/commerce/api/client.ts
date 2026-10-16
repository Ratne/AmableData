import type {
  BillingRunResult,
  CancelOrderInput,
  CancelSubscriptionInput,
  ChangePlanInput,
  CommerceSettings,
  Contact,
  CreateOrderInput,
  CreatePaymentInput,
  CreatePlanInput,
  CreateProductCategoryInput,
  CreateProductInput,
  CreatePromoCodeInput,
  CreateRefundInput,
  CreateSubscriptionInput,
  Invoice,
  Order,
  OrderStatus,
  Page,
  Payment,
  Plan,
  Product,
  ProductCategory,
  PromoCode,
  Refund,
  SearchQueryInput,
  SearchResult,
  Subscription,
  SubscriptionStatus,
  UpdateCommerceSettingsInput,
  UpdateOrderInput,
  UpdatePlanInput,
  UpdateProductCategoryInput,
  UpdateProductInput,
  UpdatePromoCodeInput,
} from '@amable/api-types';
import type { Permission, Role } from '@amable/core';
import { stepUpFetch } from '../../../lib/step-up';

/**
 * Typed client of the e-commerce REST v2 surface (`/api/v2/t/{slug}`) plus the
 * few CRM/access endpoints the commerce pages read (tenant `me`, contact lookup,
 * order search). Types come from the shared Zod schemas in `@amable/api-types`.
 */

const CSRF_HEADER = 'x-amable-csrf';

export interface ApiErrorDetail {
  readonly path: string;
  readonly message: string;
}

export class CommerceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    readonly details: readonly ApiErrorDetail[],
  ) {
    super(detail ?? `API ${String(status)} ${code}`);
  }
}

type QueryValue = string | number | boolean | null | undefined;

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly json?: unknown;
}

function buildQuery(query: Readonly<Record<string, QueryValue>> | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

let redirecting = false;

async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  }
  if (method !== 'GET') headers.set(CSRF_HEADER, '1');
  if (method === 'POST') headers.set('idempotency-key', crypto.randomUUID());
  const response = await stepUpFetch(`${url}${buildQuery(options.query)}`, {
    method,
    headers,
    body,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
      details?: ApiErrorDetail[];
    } | null;
    if (response.status === 401 && !redirecting && window.location.pathname !== '/login') {
      redirecting = true;
      window.location.assign('/login');
    }
    throw new CommerceApiError(
      response.status,
      payload?.error ?? 'http_error',
      payload?.message ?? null,
      payload?.details ?? [],
    );
  }
  return (await response.json()) as T;
}

export interface TenantMe {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

export type ListParams = {
  readonly limit?: number;
  readonly cursor?: string;
};

type Deleted = { id: string; deleted: true };

export function commerceClient(slug: string) {
  const base = `/api/v2/t/${encodeURIComponent(slug)}`;
  const get = <T>(path: string, query?: RequestOptions['query']) =>
    request<T>(`${base}${path}`, { query });
  const post = <T>(path: string, json: unknown = {}) =>
    request<T>(`${base}${path}`, { method: 'POST', json });
  const patch = <T>(path: string, json: unknown) =>
    request<T>(`${base}${path}`, { method: 'PATCH', json });
  const del = <T = Deleted>(path: string) => request<T>(`${base}${path}`, { method: 'DELETE' });
  const id = (value: string) => encodeURIComponent(value);

  return {
    me: () => request<TenantMe>(`/api/t/${encodeURIComponent(slug)}/me`),

    settings: {
      get: () => get<CommerceSettings>('/commerce/settings'),
      update: (input: UpdateCommerceSettingsInput) =>
        patch<CommerceSettings>('/commerce/settings', input),
    },
    categories: {
      list: () => get<{ data: ProductCategory[] }>('/productCategories'),
      create: (input: CreateProductCategoryInput) =>
        post<ProductCategory>('/productCategories', input),
      update: (categoryId: string, input: UpdateProductCategoryInput) =>
        patch<ProductCategory>(`/productCategories/${id(categoryId)}`, input),
      remove: (categoryId: string) => del(`/productCategories/${id(categoryId)}`),
    },
    products: {
      list: (
        params: ListParams & { q?: string; category_id?: string; active?: 'true' | 'false' } = {},
      ) => get<Page<Product>>('/products', params),
      get: (productId: string) => get<Product>(`/products/${id(productId)}`),
      create: (input: CreateProductInput) => post<Product>('/products', input),
      update: (productId: string, input: UpdateProductInput) =>
        patch<Product>(`/products/${id(productId)}`, input),
      remove: (productId: string) => del(`/products/${id(productId)}`),
    },
    plans: {
      list: (params: ListParams & { product_id?: string; active?: 'true' | 'false' } = {}) =>
        get<Page<Plan>>('/plans', params),
      get: (planId: string) => get<Plan>(`/plans/${id(planId)}`),
      create: (productId: string, input: CreatePlanInput) =>
        post<Plan>(`/products/${id(productId)}/plans`, input),
      update: (planId: string, input: UpdatePlanInput) =>
        patch<Plan>(`/plans/${id(planId)}`, input),
      remove: (planId: string) => del(`/plans/${id(planId)}`),
    },
    promoCodes: {
      list: (params: ListParams = {}) => get<Page<PromoCode>>('/promoCodes', params),
      create: (input: CreatePromoCodeInput) => post<PromoCode>('/promoCodes', input),
      update: (promoId: string, input: UpdatePromoCodeInput) =>
        patch<PromoCode>(`/promoCodes/${id(promoId)}`, input),
      remove: (promoId: string) => del(`/promoCodes/${id(promoId)}`),
    },
    orders: {
      list: (
        params: ListParams & {
          q?: string;
          status?: OrderStatus;
          contact_id?: string;
          subscription_id?: string;
        } = {},
      ) => get<Page<Order>>('/orders', params),
      get: (orderId: string) => get<Order>(`/orders/${id(orderId)}`),
      create: (input: CreateOrderInput) => post<Order>('/orders', input),
      update: (orderId: string, input: UpdateOrderInput) =>
        patch<Order>(`/orders/${id(orderId)}`, input),
      remove: (orderId: string) => del(`/orders/${id(orderId)}`),
      finalize: (orderId: string) => post<Order>(`/orders/${id(orderId)}/finalize`),
      cancel: (orderId: string, input: CancelOrderInput = {}) =>
        post<Order>(`/orders/${id(orderId)}/cancel`, input),
      payments: (orderId: string) =>
        get<Page<Payment>>(`/orders/${id(orderId)}/payments`, { limit: 200 }),
      recordPayment: (orderId: string, input: CreatePaymentInput) =>
        post<Payment>(`/orders/${id(orderId)}/payments`, input),
      refunds: (orderId: string) =>
        get<Page<Refund>>(`/orders/${id(orderId)}/refunds`, { limit: 200 }),
      refund: (orderId: string, input: CreateRefundInput) =>
        post<Refund>(`/orders/${id(orderId)}/refunds`, input),
    },
    payments: {
      list: (
        params: ListParams & { status?: 'succeeded' | 'failed'; from?: string; to?: string } = {},
      ) => get<Page<Payment>>('/payments', params),
    },
    subscriptions: {
      list: (
        params: ListParams & {
          status?: SubscriptionStatus;
          contact_id?: string;
          plan_id?: string;
          product_id?: string;
        } = {},
      ) => get<Page<Subscription>>('/subscriptions', params),
      get: (subscriptionId: string) => get<Subscription>(`/subscriptions/${id(subscriptionId)}`),
      create: (input: CreateSubscriptionInput) => post<Subscription>('/subscriptions', input),
      cancel: (subscriptionId: string, input: CancelSubscriptionInput) =>
        post<Subscription>(`/subscriptions/${id(subscriptionId)}/cancel`, input),
      pause: (subscriptionId: string) =>
        post<Subscription>(`/subscriptions/${id(subscriptionId)}/pause`),
      resume: (subscriptionId: string) =>
        post<Subscription>(`/subscriptions/${id(subscriptionId)}/resume`),
      changePlan: (subscriptionId: string, input: ChangePlanInput) =>
        post<Subscription>(`/subscriptions/${id(subscriptionId)}/changePlan`, input),
    },
    billingRun: () => post<BillingRunResult>('/billing/run'),
    invoices: {
      list: (
        params: ListParams & {
          status?: 'open' | 'paid' | 'void';
          contact_id?: string;
          year?: number;
        } = {},
      ) => get<Page<Invoice>>('/invoices', params),
      get: (invoiceId: string) => get<Invoice>(`/invoices/${id(invoiceId)}`),
    },
    contacts: {
      get: (contactId: string) => get<Contact>(`/contacts/${id(contactId)}`),
      list: (params: ListParams & { q?: string } = {}) => get<Page<Contact>>('/contacts', params),
    },
    search: (query: SearchQueryInput) => post<SearchResult>('/search', query),
  };
}

export type CommerceClient = ReturnType<typeof commerceClient>;

/** Drains a cursor-paginated endpoint (bounded: reference lists only). */
export async function fetchAllPages<T>(
  load: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages = 20,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await load(cursor);
    rows.push(...result.data);
    if (result.next_cursor === null) break;
    cursor = result.next_cursor;
  }
  return rows;
}
