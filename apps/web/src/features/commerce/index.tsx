import { lazy, Suspense } from 'react';
import type { ContactOrdersPanelProps } from './components/contact-orders-panel';

/*
 * Public surface of the e-commerce feature for other modules. Import from
 * `features/commerce` only; internals may move.
 */

export { commerceRoutes } from './routes';
export type { ContactOrdersPanelProps } from './components/contact-orders-panel';

const LazyContactOrdersPanel = lazy(() =>
  import('./components/contact-orders-panel').then((m) => ({ default: m.ContactOrdersPanel })),
);

/**
 * "Orders" section for the contact detail page (lazy chunk). Must render
 * under the `/t/$tenant` route; hidden without `orders:read`.
 */
export function ContactOrdersPanel(props: ContactOrdersPanelProps) {
  return (
    <Suspense fallback={null}>
      <LazyContactOrdersPanel {...props} />
    </Suspense>
  );
}
