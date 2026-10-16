import { createRoute, lazyRouteComponent } from '@tanstack/react-router';
import { tenantRoute } from '../../routes/tenant';

/*
 * E-commerce pages under /t/$tenant, each in a lazily loaded chunk. Paths
 * matching a module of navigation.ts replace its placeholder.
 */

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export const ordersRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'orders',
  validateSearch: (search: Record<string, unknown>): { contact?: string; status?: string } => {
    const contact = str(search['contact']);
    const status = str(search['status']);
    return { ...(contact ? { contact } : {}), ...(status ? { status } : {}) };
  },
  component: lazyRouteComponent(() => import('./pages/orders'), 'OrdersPage'),
});

export const newOrderRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'orders/new',
  validateSearch: (search: Record<string, unknown>): { contact?: string } => {
    const contact = str(search['contact']);
    return contact ? { contact } : {};
  },
  component: lazyRouteComponent(() => import('./pages/order-wizard'), 'OrderWizardPage'),
});

export const orderDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'orders/$orderId',
  component: lazyRouteComponent(() => import('./pages/order-detail'), 'OrderDetailPage'),
});

export const productsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'products',
  component: lazyRouteComponent(() => import('./pages/products'), 'ProductsPage'),
});

export const productDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'products/$productId',
  component: lazyRouteComponent(() => import('./pages/product-editor'), 'ProductEditorPage'),
});

export const promotionsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'promotions',
  component: lazyRouteComponent(() => import('./pages/promotions'), 'PromotionsPage'),
});

export const subscriptionsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'subscriptions',
  component: lazyRouteComponent(() => import('./pages/subscriptions'), 'SubscriptionsPage'),
});

export const subscriptionDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'subscriptions/$subscriptionId',
  component: lazyRouteComponent(
    () => import('./pages/subscription-detail'),
    'SubscriptionDetailPage',
  ),
});

export const invoicesRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'invoices',
  component: lazyRouteComponent(() => import('./pages/invoices'), 'InvoicesPage'),
});

export const invoiceDetailRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'invoices/$invoiceId',
  component: lazyRouteComponent(() => import('./pages/invoice-view'), 'InvoiceViewPage'),
});

export const paymentsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'payments',
  component: lazyRouteComponent(() => import('./pages/payments'), 'PaymentsPage'),
});

export const commerceSettingsRoute = createRoute({
  getParentRoute: () => tenantRoute,
  path: 'settings/commerce',
  component: lazyRouteComponent(() => import('./pages/settings'), 'CommerceSettingsPage'),
});

/** Every e-commerce route, for `featureRoutes` in the app router. */
export const commerceRoutes = [
  ordersRoute,
  newOrderRoute,
  orderDetailRoute,
  productsRoute,
  productDetailRoute,
  promotionsRoute,
  subscriptionsRoute,
  subscriptionDetailRoute,
  invoicesRoute,
  invoiceDetailRoute,
  paymentsRoute,
  commerceSettingsRoute,
] as const;
