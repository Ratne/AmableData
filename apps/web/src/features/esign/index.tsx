import { lazy, Suspense } from 'react';
import type { ContactSignaturesPanelProps } from './components/contact-signatures-panel';

/*
 * Public surface of the e-signature feature for other modules. Import from
 * `features/esign` only; internals may move.
 */

export type { ContactSignaturesPanelProps } from './components/contact-signatures-panel';

const LazyContactSignaturesPanel = lazy(() =>
  import('./components/contact-signatures-panel').then((m) => ({
    default: m.ContactSignaturesPanel,
  })),
);

/** "Signatures" tab of the contact page (lazy chunk); must render under the `/t/$tenant` route. */
export function ContactSignaturesPanel(props: ContactSignaturesPanelProps) {
  return (
    <Suspense fallback={null}>
      <LazyContactSignaturesPanel {...props} />
    </Suspense>
  );
}
