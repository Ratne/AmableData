import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  createPaymentSchema,
  createRefundSchema,
  idParamSchema,
  listPaymentsQuerySchema,
  listRefundsQuerySchema,
  pageOf,
  pageQuerySchema,
  paymentSchema,
  refundSchema,
} from '@amable/api-types';
import { audit, type AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { refundOnStripe } from '../stripe/refunds';

export function registerPaymentsRefundsRoutes(app: OpenAPIHono<AppEnv>): void {
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
      summary:
        'Record a full or partial refund (idempotent by transaction_id); `stripe: true` also refunds the card',
      request: { params: idParamSchema, body: jsonBody(createRefundSchema) },
      responses: { 201: json(refundSchema, 'The refund') },
    }),
    async (c) => {
      const orderId = c.req.valid('param').id;
      const { stripe, ...data } = c.req.valid('json');
      if (stripe === true) {
        const refund = await refundOnStripe(c, orderId, data);
        await audit(c, 'commerce.stripe_refunded', {
          target: orderId,
          details: { amount_minor: refund.amount_minor },
        });
        return c.json(refund, 201);
      }
      return c.json(await callCrm(c, 'refunds.record', { orderId, data }), 201);
    },
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
}
