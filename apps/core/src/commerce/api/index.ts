import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../../middleware';
import { registerSettingsRoutes } from './settings';
import { registerCategoriesRoutes } from './categories';
import { registerProductsRoutes } from './products';
import { registerPlansRoutes } from './plans';
import { registerPromoCodesRoutes } from './promo-codes';
import { registerOrdersRoutes } from './orders';
import { registerPaymentsRefundsRoutes } from './payments-refunds';
import { registerSubscriptionsRoutes } from './subscriptions';
import { registerInvoicesRoutes } from './invoices';

/** E-commerce REST v2 routes, relative to `/api/v2/t/{slug}` (registered on the CRM router). */
export function registerCommerceRoutes(app: OpenAPIHono<AppEnv>): void {
  registerSettingsRoutes(app);
  registerCategoriesRoutes(app);
  registerProductsRoutes(app);
  registerPlansRoutes(app);
  registerPromoCodesRoutes(app);
  registerOrdersRoutes(app);
  registerPaymentsRefundsRoutes(app);
  registerSubscriptionsRoutes(app);
  registerInvoicesRoutes(app);
}
