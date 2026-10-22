import type {
  BillingRunResult,
  CancelOrderInput,
  CancelSubscriptionInput,
  ChangePlanInput,
  Checkout,
  CheckoutEmbed,
  CheckoutSummary,
  CommerceSettings,
  Contact,
  CreateCheckoutInput,
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
  StripeCheckResult,
  StripeSettings,
  Subscription,
  SubscriptionStatus,
  UpdateCheckoutInput,
  UpdateCommerceSettingsInput,
  UpdateOrderInput,
  UpdatePlanInput,
  UpdateProductCategoryInput,
  UpdateProductInput,
  UpdatePromoCodeInput,
  UpdateStripeSettingsInput,
} from '@amable/api-types';
import { tenantRest } from '../../../lib/tenant-api';

export { TenantApiError as CommerceApiError } from '../../../lib/tenant-api';

/**
 * Typed client of the e-commerce REST v2 surface (`/api/v2/t/{slug}`) plus the
 * few CRM/access endpoints the commerce pages read (tenant `me`, contact lookup,
 * order search). Types come from the shared Zod schemas in `@amable/api-types`.
 */

export type ListParams = {
  readonly limit?: number;
  readonly cursor?: string;
};

export function commerceClient(slug: string) {
  const { get, post, patch, put, del, me } = tenantRest(slug);
  const id = (value: string) => encodeURIComponent(value);

  return {
    me,

    settings: {
      get: () => get<CommerceSettings>('/commerce/settings'),
      update: (input: UpdateCommerceSettingsInput) =>
        patch<CommerceSettings>('/commerce/settings', input),
    },
    stripe: {
      get: () => get<StripeSettings>('/commerce/stripe'),
      update: (input: UpdateStripeSettingsInput) => put<StripeSettings>('/commerce/stripe', input),
      check: () => post<StripeCheckResult>('/commerce/stripe/check'),
      disconnect: () => del<StripeSettings>('/commerce/stripe'),
    },
    checkouts: {
      list: (params: ListParams & { status?: 'draft' | 'active' | 'archived'; q?: string } = {}) =>
        get<Page<CheckoutSummary>>('/checkouts', params),
      get: (checkoutId: string) => get<Checkout>(`/checkouts/${id(checkoutId)}`),
      create: (input: CreateCheckoutInput) => post<Checkout>('/checkouts', input),
      update: (checkoutId: string, input: UpdateCheckoutInput) =>
        patch<Checkout>(`/checkouts/${id(checkoutId)}`, input),
      remove: (checkoutId: string) => del(`/checkouts/${id(checkoutId)}`),
      duplicate: (checkoutId: string) => post<Checkout>(`/checkouts/${id(checkoutId)}/duplicate`),
      embed: (checkoutId: string) => get<CheckoutEmbed>(`/checkouts/${id(checkoutId)}/embed`),
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
