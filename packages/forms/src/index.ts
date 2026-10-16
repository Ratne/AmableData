/**
 * @amable/forms — form definition schema, shared submission validation, widget
 * strings and the edge ↔ core gateway op types. The embeddable preact widget
 * lives in `src/widget` and ships prebuilt through `@amable/forms/bundle`.
 */

export * from './schema';
export * from './validate';
export * from './strings';
export type { FormsGatewayOps } from './gateway';
export { FORMS_GATEWAY_OPS } from './gateway';
