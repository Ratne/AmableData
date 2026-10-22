/**
 * @amable/checkout — checkout definition schema (items, custom fields, order
 * bumps, post-purchase offer chain), public widget types, widget strings and
 * the edge ↔ core gateway op types. The embeddable preact widget lives in
 * `src/widget` and ships prebuilt through `@amable/checkout/bundle`.
 */

export * from './schema';
export * from './public';
export * from './strings';
export type { CheckoutGatewayOps } from './gateway';
export { CHECKOUT_GATEWAY_OPS, SESSION_PARAM } from './gateway';
