import { z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  bankAccountSchema,
  createBankAccountSchema,
  updateBankAccountSchema,
  commerceSettingsSchema,
  deletedResponseSchema,
  idParamSchema,
  updateCommerceSettingsSchema,
} from '@amable/api-types';
import { audit, type AppEnv } from '../../middleware';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';

export function registerSettingsRoutes(app: OpenAPIHono<AppEnv>): void {
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
  app.openapi(
    crmRoute('checkouts:write', {
      method: 'get',
      path: '/commerce/bank-accounts',
      tags: settings,
      summary: 'Bank accounts offered to checkout buyers paying by bank transfer',
      responses: { 200: json(z.object({ data: z.array(bankAccountSchema) }), 'Bank accounts') },
    }),
    async (c) => c.json(await callCrm(c, 'bankAccounts.list', {}), 200),
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/commerce/bank-accounts',
      tags: settings,
      summary: 'Add a bank account',
      request: { body: jsonBody(createBankAccountSchema) },
      responses: { 201: json(bankAccountSchema, 'The bank account') },
    }),
    async (c) => {
      const account = await callCrm(c, 'bankAccounts.create', c.req.valid('json'));
      await audit(c, 'commerce.bank_account_created', { target: account.id });
      return c.json(account, 201);
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'patch',
      path: '/commerce/bank-accounts/{id}',
      tags: settings,
      summary: 'Update a bank account',
      request: { params: idParamSchema, body: jsonBody(updateBankAccountSchema) },
      responses: { 200: json(bankAccountSchema, 'The bank account') },
    }),
    async (c) => {
      const account = await callCrm(c, 'bankAccounts.update', {
        id: c.req.valid('param').id,
        data: c.req.valid('json'),
      });
      await audit(c, 'commerce.bank_account_updated', { target: account.id });
      return c.json(account, 200);
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'delete',
      path: '/commerce/bank-accounts/{id}',
      tags: settings,
      summary: 'Delete a bank account (checkouts using it stop offering bank transfer)',
      request: { params: idParamSchema },
      responses: { 200: json(deletedResponseSchema, 'Deleted') },
    }),
    async (c) => {
      const result = await callCrm(c, 'bankAccounts.delete', c.req.valid('param'));
      await audit(c, 'commerce.bank_account_deleted', { target: result.id });
      return c.json(result, 200);
    },
  );
}
