import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  billingRunResultSchema,
  cancelOrderSchema,
  cancelSubscriptionSchema,
  changePlanSchema,
  commerceSettingsSchema,
  createOrderSchema,
  createPaymentSchema,
  createPlanSchema,
  createProductCategorySchema,
  createProductSchema,
  createPromoCodeSchema,
  createRefundSchema,
  createSubscriptionSchema,
  deletedResponseSchema,
  idParamSchema,
  invoiceSchema,
  listInvoicesQuerySchema,
  listOrdersQuerySchema,
  listPaymentsQuerySchema,
  listPlansQuerySchema,
  listProductsQuerySchema,
  listRefundsQuerySchema,
  listSubscriptionsQuerySchema,
  orderItemInputSchema,
  orderItemParamSchema,
  orderItemSchema,
  orderSchema,
  pageOf,
  pageQuerySchema,
  paymentSchema,
  planSchema,
  productCategorySchema,
  productSchema,
  promoCodeSchema,
  refundSchema,
  subscriptionSchema,
  updateCommerceSettingsSchema,
  updateOrderSchema,
  updatePlanSchema,
  updateProductCategorySchema,
  updateProductSchema,
  updatePromoCodeSchema,
} from '@amable/api-types';
import type { AppEnv } from '../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../crm/api/core';

const activeQuery = z.object({ active: z.enum(['true', 'false']).optional() });

/** E-commerce REST v2 routes, relative to `/api/v2/t/{slug}` (registered on the CRM router). */
export function registerCommerceRoutes(app: OpenAPIHono<AppEnv>): void {
  // -------------------------------------------------------------- settings
  const settings = ['Commerce settings'];
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/commerce/settings',
      tags: settings,
      summary: 'E-commerce settings (default currency, number prefixes, payment terms)',
      responses: { 200: json(commerceSettingsSchema, 'Settings') },
    }),
    async (c) => c.json(await callCrm(c, 'commerce.settings.get', {}), 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/commerce/settings',
      tags: settings,
      summary: 'Update e-commerce settings',
      request: { body: jsonBody(updateCommerceSettingsSchema) },
      responses: { 200: json(commerceSettingsSchema, 'Settings') },
    }),
    async (c) => c.json(await callCrm(c, 'commerce.settings.update', c.req.valid('json')), 200),
  );

  // ------------------------------------------------------------ categories
  const categories = ['Product categories'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/productCategories',
      tags: categories,
      summary: 'List product categories',
      responses: { 200: json(z.object({ data: z.array(productCategorySchema) }), 'Categories') },
    }),
    async (c) => c.json({ data: await callCrm(c, 'productCategories.list', {}) }, 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/productCategories',
      tags: categories,
      summary: 'Create a product category',
      request: { body: jsonBody(createProductCategorySchema) },
      responses: { 201: json(productCategorySchema, 'The category') },
    }),
    async (c) => c.json(await callCrm(c, 'productCategories.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/productCategories/{id}',
      tags: categories,
      summary: 'Get a product category',
      request: { params: idParamSchema },
      responses: { 200: json(productCategorySchema, 'The category') },
    }),
    async (c) => c.json(await callCrm(c, 'productCategories.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/productCategories/{id}',
      tags: categories,
      summary: 'Update a product category',
      request: { params: idParamSchema, body: jsonBody(updateProductCategorySchema) },
      responses: { 200: json(productCategorySchema, 'The category') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'productCategories.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/productCategories/{id}',
      tags: categories,
      summary: 'Delete a product category (its products become uncategorized)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'productCategories.delete', c.req.valid('param')), 200),
  );

  // -------------------------------------------------------------- products
  const products = ['Products'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/products',
      tags: products,
      summary: 'List products (by name) with their plans',
      request: { query: listProductsQuerySchema },
      responses: { 200: json(pageOf(productSchema), 'A page of products') },
    }),
    async (c) => c.json(await callCrm(c, 'products.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/products',
      tags: products,
      summary: 'Create a product (optionally with subscription plans)',
      request: { body: jsonBody(createProductSchema) },
      responses: { 201: json(productSchema, 'The product') },
    }),
    async (c) => c.json(await callCrm(c, 'products.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/products/{id}',
      tags: products,
      summary: 'Get a product',
      request: { params: idParamSchema },
      responses: { 200: json(productSchema, 'The product') },
    }),
    async (c) => c.json(await callCrm(c, 'products.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/products/{id}',
      tags: products,
      summary: 'Update a product',
      request: { params: idParamSchema, body: jsonBody(updateProductSchema) },
      responses: { 200: json(productSchema, 'The product') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'products.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/products/{id}',
      tags: products,
      summary: 'Delete a product without live subscriptions',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'products.delete', c.req.valid('param')), 200),
  );

  // ----------------------------------------------------------------- plans
  const plans = ['Subscription plans'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/plans',
      tags: plans,
      summary: 'List subscription plans',
      request: { query: listPlansQuerySchema },
      responses: { 200: json(pageOf(planSchema), 'A page of plans') },
    }),
    async (c) => c.json(await callCrm(c, 'plans.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/products/{id}/plans',
      tags: plans,
      summary: 'Add a subscription plan to a product',
      request: { params: idParamSchema, body: jsonBody(createPlanSchema) },
      responses: { 201: json(planSchema, 'The plan') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'plans.create', {
          productId: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/plans/{id}',
      tags: plans,
      summary: 'Get a plan',
      request: { params: idParamSchema },
      responses: { 200: json(planSchema, 'The plan') },
    }),
    async (c) => c.json(await callCrm(c, 'plans.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/plans/{id}',
      tags: plans,
      summary: 'Update a plan (running subscriptions keep their snapshot)',
      request: { params: idParamSchema, body: jsonBody(updatePlanSchema) },
      responses: { 200: json(planSchema, 'The plan') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'plans.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/plans/{id}',
      tags: plans,
      summary: 'Delete a plan without live subscriptions',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'plans.delete', c.req.valid('param')), 200),
  );

  // ----------------------------------------------------------- promo codes
  const promos = ['Promo codes'];
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/promoCodes',
      tags: promos,
      summary: 'List promo codes',
      request: { query: pageQuerySchema.extend(activeQuery.shape) },
      responses: { 200: json(pageOf(promoCodeSchema), 'A page of promo codes') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'post',
      path: '/promoCodes',
      tags: promos,
      summary: 'Create a promo code (percent or fixed, limits and validity window)',
      request: { body: jsonBody(createPromoCodeSchema) },
      responses: { 201: json(promoCodeSchema, 'The promo code') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('products:read', {
      method: 'get',
      path: '/promoCodes/{id}',
      tags: promos,
      summary: 'Get a promo code',
      request: { params: idParamSchema },
      responses: { 200: json(promoCodeSchema, 'The promo code') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'patch',
      path: '/promoCodes/{id}',
      tags: promos,
      summary: 'Update a promo code (code and kind are immutable)',
      request: { params: idParamSchema, body: jsonBody(updatePromoCodeSchema) },
      responses: { 200: json(promoCodeSchema, 'The promo code') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'promoCodes.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('products:write', {
      method: 'delete',
      path: '/promoCodes/{id}',
      tags: promos,
      summary: 'Delete a promo code',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'promoCodes.delete', c.req.valid('param')), 200),
  );

  // ---------------------------------------------------------------- orders
  const orders = ['Orders'];
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders',
      tags: orders,
      summary: 'List orders, newest order date first',
      description:
        '`q` uses the full-text index (number, contact, items, SKUs, promo code, notes).',
      request: { query: listOrdersQuerySchema },
      responses: { 200: json(pageOf(orderSchema), 'A page of orders') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders',
      tags: orders,
      summary: 'Create an order (manual or API; no checkout)',
      description:
        'Totals are computed server-side in integer minor units. Unless `status` is `draft`, the order is finalized: promo redemption recorded, invoice issued, `order.created` emitted.',
      request: { body: jsonBody(createOrderSchema) },
      responses: { 201: json(orderSchema, 'The order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders/{id}',
      tags: orders,
      summary: 'Get an order',
      request: { params: idParamSchema },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'patch',
      path: '/orders/{id}',
      tags: orders,
      summary:
        'Update an order (drafts: everything; finalized: notes, owner, company, due date, custom fields)',
      request: { params: idParamSchema, body: jsonBody(updateOrderSchema) },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'orders.update', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'delete',
      path: '/orders/{id}',
      tags: orders,
      summary: 'Delete a draft order (finalized orders are cancelled instead)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.delete', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/finalize',
      tags: orders,
      summary: 'Finalize a draft: issue the invoice and emit order.created',
      request: { params: idParamSchema },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.finalize', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/cancel',
      tags: orders,
      summary: 'Cancel an order holding no money (voids the invoice, releases the promo code)',
      request: { params: idParamSchema, body: jsonBody(cancelOrderSchema) },
      responses: { 200: json(orderSchema, 'The order') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'orders.cancel', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders/{id}/items',
      tags: orders,
      summary: 'Lines of an order',
      request: { params: idParamSchema },
      responses: { 200: json(z.object({ data: z.array(orderItemSchema) }), 'Order lines') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.items', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/items',
      tags: orders,
      summary: 'Add a line to a draft order',
      request: { params: idParamSchema, body: jsonBody(orderItemInputSchema) },
      responses: { 201: json(orderSchema, 'The re-priced order') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'orders.addItem', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'delete',
      path: '/orders/{id}/items/{itemId}',
      tags: orders,
      summary: 'Remove a line from a draft order',
      request: { params: orderItemParamSchema },
      responses: { 200: json(orderSchema, 'The re-priced order') },
    }),
    async (c) => c.json(await callCrm(c, 'orders.removeItem', c.req.valid('param')), 200),
  );

  // ------------------------------------------------------ payments/refunds
  const money = ['Payments and refunds'];
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders/{id}/payments',
      tags: money,
      summary: 'Payments of an order',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(pageOf(paymentSchema), 'Payments, newest first') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'payments.list', {
          ...c.req.valid('query'),
          order_id: c.req.valid('param').id,
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('orders:write', {
      method: 'post',
      path: '/orders/{id}/payments',
      tags: money,
      summary: 'Record a payment (manual or API; idempotent by transaction_id)',
      description:
        'Succeeded payments are bounded by the open balance and emit `payment.recorded` (+ `order.paid` when settled). `status: failed` records a declined charge, emits `payment.failed` and moves the subscription to past_due.',
      request: { params: idParamSchema, body: jsonBody(createPaymentSchema) },
      responses: { 201: json(paymentSchema, 'The payment') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'payments.record', {
          orderId: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/payments',
      tags: money,
      summary: 'List payments across orders',
      request: { query: listPaymentsQuerySchema },
      responses: { 200: json(pageOf(paymentSchema), 'Payments, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'payments.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/payments/{id}',
      tags: money,
      summary: 'Get a payment',
      request: { params: idParamSchema },
      responses: { 200: json(paymentSchema, 'The payment') },
    }),
    async (c) => c.json(await callCrm(c, 'payments.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/orders/{id}/refunds',
      tags: money,
      summary: 'Refunds of an order',
      request: { params: idParamSchema, query: pageQuerySchema },
      responses: { 200: json(pageOf(refundSchema), 'Refunds, newest first') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'refunds.list', {
          ...c.req.valid('query'),
          order_id: c.req.valid('param').id,
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('orders:refund', {
      method: 'post',
      path: '/orders/{id}/refunds',
      tags: money,
      summary: 'Record a full or partial refund (idempotent by transaction_id)',
      request: { params: idParamSchema, body: jsonBody(createRefundSchema) },
      responses: { 201: json(refundSchema, 'The refund') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'refunds.record', {
          orderId: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        201,
      ),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/refunds',
      tags: money,
      summary: 'List refunds across orders',
      request: { query: listRefundsQuerySchema },
      responses: { 200: json(pageOf(refundSchema), 'Refunds, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'refunds.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/refunds/{id}',
      tags: money,
      summary: 'Get a refund',
      request: { params: idParamSchema },
      responses: { 200: json(refundSchema, 'The refund') },
    }),
    async (c) => c.json(await callCrm(c, 'refunds.get', c.req.valid('param')), 200),
  );

  // --------------------------------------------------------- subscriptions
  const subs = ['Subscriptions'];
  app.openapi(
    crmRoute('subscriptions:read', {
      method: 'get',
      path: '/subscriptions',
      tags: subs,
      summary: 'List subscriptions',
      request: { query: listSubscriptionsQuerySchema },
      responses: { 200: json(pageOf(subscriptionSchema), 'A page of subscriptions, newest first') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions',
      tags: subs,
      summary: 'Start a subscription on a plan',
      description:
        'With a trial nothing is billed until it ends (`subscription.trial_started`); otherwise the first period order + invoice is generated now. The billing job generates renewal orders on each due date.',
      request: { body: jsonBody(createSubscriptionSchema) },
      responses: { 201: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.create', c.req.valid('json')), 201),
  );
  app.openapi(
    crmRoute('subscriptions:read', {
      method: 'get',
      path: '/subscriptions/{id}',
      tags: subs,
      summary: 'Get a subscription',
      request: { params: idParamSchema },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.get', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/cancel',
      tags: subs,
      summary: 'Cancel at period end (default) or immediately',
      request: { params: idParamSchema, body: jsonBody(cancelSubscriptionSchema) },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'subscriptions.cancel', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/pause',
      tags: subs,
      summary: 'Pause billing',
      request: { params: idParamSchema },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.pause', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/resume',
      tags: subs,
      summary: 'Resume a paused subscription or withdraw a scheduled cancellation',
      request: { params: idParamSchema },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) => c.json(await callCrm(c, 'subscriptions.resume', c.req.valid('param')), 200),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/subscriptions/{id}/changePlan',
      tags: subs,
      summary: 'Change plan from the next period (no proration; emits upgraded/downgraded)',
      request: { params: idParamSchema, body: jsonBody(changePlanSchema) },
      responses: { 200: json(subscriptionSchema, 'The subscription') },
    }),
    async (c) =>
      c.json(
        await callCrm(c, 'subscriptions.changePlan', {
          id: c.req.valid('param').id,
          data: c.req.valid('json'),
        }),
        200,
      ),
  );
  app.openapi(
    crmRoute('subscriptions:write', {
      method: 'post',
      path: '/billing/run',
      tags: subs,
      summary: 'Run the billing job now (it also runs automatically on every due date)',
      responses: { 200: json(billingRunResultSchema, 'Run summary') },
    }),
    async (c) => c.json(await callCrm(c, 'billing.run', {}), 200),
  );

  // -------------------------------------------------------------- invoices
  const invoices = ['Invoices'];
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/invoices',
      tags: invoices,
      summary: 'List invoices, newest number first',
      request: { query: listInvoicesQuerySchema },
      responses: { 200: json(pageOf(invoiceSchema), 'A page of invoices') },
    }),
    async (c) => c.json(await callCrm(c, 'invoices.list', c.req.valid('query')), 200),
  );
  app.openapi(
    crmRoute('orders:read', {
      method: 'get',
      path: '/invoices/{id}',
      tags: invoices,
      summary: 'Get an invoice',
      request: { params: idParamSchema },
      responses: { 200: json(invoiceSchema, 'The invoice') },
    }),
    async (c) => c.json(await callCrm(c, 'invoices.get', c.req.valid('param')), 200),
  );
}
