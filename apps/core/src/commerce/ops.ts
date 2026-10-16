import type { CrmContext } from '../crm/context';
import * as catalog from './catalog';
import * as invoices from './invoices';
import * as orders from './orders';
import * as payments from './payments';
import * as promo from './promo';
import * as settings from './settings';
import * as subscriptions from './subscriptions';

/**
 * E-commerce operations, merged into the TenantDb operation registry
 * (`crmOps`): same single RPC entry point, one transaction per call.
 */
export const commerceOps = {
  'commerce.settings.get': settings.getSettings,
  'commerce.settings.update': settings.updateSettings,
  // catalog
  'productCategories.list': catalog.listCategories,
  'productCategories.get': catalog.getCategory,
  'productCategories.create': catalog.createCategory,
  'productCategories.update': catalog.updateCategory,
  'productCategories.delete': catalog.deleteCategory,
  'products.list': catalog.listProducts,
  'products.get': catalog.getProduct,
  'products.create': catalog.createProduct,
  'products.update': catalog.updateProduct,
  'products.delete': catalog.deleteProduct,
  'plans.list': catalog.listPlans,
  'plans.get': catalog.getPlan,
  'plans.create': catalog.createPlan,
  'plans.update': catalog.updatePlan,
  'plans.delete': catalog.deletePlan,
  // promo codes
  'promoCodes.list': promo.listPromoCodes,
  'promoCodes.get': promo.getPromoCode,
  'promoCodes.create': promo.createPromoCode,
  'promoCodes.update': promo.updatePromoCode,
  'promoCodes.delete': promo.deletePromoCode,
  // orders
  'orders.list': orders.listOrders,
  'orders.get': orders.getOrder,
  'orders.create': orders.createOrder,
  'orders.update': orders.updateOrder,
  'orders.finalize': orders.finalizeOrder,
  'orders.cancel': orders.cancelOrder,
  'orders.delete': orders.deleteOrder,
  'orders.items': orders.listOrderItems,
  'orders.addItem': orders.addOrderItem,
  'orders.removeItem': orders.removeOrderItem,
  // payments & refunds
  'payments.list': payments.listPayments,
  'payments.get': payments.getPayment,
  'payments.record': payments.recordPayment,
  'refunds.list': payments.listRefunds,
  'refunds.get': payments.getRefund,
  'refunds.record': payments.recordRefund,
  // subscriptions & billing automation
  'subscriptions.list': subscriptions.listSubscriptions,
  'subscriptions.get': subscriptions.getSubscription,
  'subscriptions.create': subscriptions.createSubscription,
  'subscriptions.cancel': subscriptions.cancelSubscription,
  'subscriptions.pause': subscriptions.pauseSubscription,
  'subscriptions.resume': subscriptions.resumeSubscription,
  'subscriptions.changePlan': subscriptions.changeSubscriptionPlan,
  'billing.run': subscriptions.runBilling,
  // invoices
  'invoices.list': invoices.listInvoices,
  'invoices.get': invoices.getInvoice,
} satisfies Record<string, (ctx: CrmContext, input: never) => unknown>;

/** Ops after which the billing alarm of the DO must be re-armed. */
export function affectsBillingSchedule(op: string): boolean {
  return op.startsWith('subscriptions.') || op === 'billing.run';
}
