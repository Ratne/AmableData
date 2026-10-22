import { useEffect, useState } from 'preact/hooks';
import type { NextStep, OfferActionResult, OfferView } from '../public';
import { everyLabel, fill, formatMoney, type CheckoutLocale, type CheckoutStrings } from '../strings';
import type { CheckoutApi } from './api';
import { followNext } from './nav';
import { loadStripe } from './stripe';

export interface OfferProps {
  api: CheckoutApi;
  token: string;
  strings: CheckoutStrings;
  locale: CheckoutLocale;
  /** Only the accept/decline buttons (the page around describes the offer). */
  buttonsOnly: boolean;
}

type State =
  | { kind: 'loading' }
  | { kind: 'offer'; offer: OfferView }
  | { kind: 'message'; text: string };

/**
 * Post-purchase offer block (`data-amable-offer`): one click charges the
 * card saved by the checkout; 3-D Secure, when the bank asks for it, runs in
 * place. Accept and decline both follow the chain configured on the checkout.
 */
export function Offer({ api, token, strings, locale, buttonsOnly }: OfferProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState('');

  const go = (next: NextStep, message: string) => {
    if (followNext(api, next, token) === 'navigating') setState({ kind: 'message', text: strings.redirecting });
    else setState({ kind: 'message', text: message !== '' ? message : strings.success });
  };

  useEffect(() => {
    if (token === '') {
      setState({ kind: 'message', text: strings.offerExpired });
      return;
    }
    void api.offer(token).then((result) => {
      if (!result.ok) {
        setState({ kind: 'message', text: result.failure.status === 0 ? strings.networkError : strings.offerExpired });
        return;
      }
      const value = result.value;
      if (value.status === 'offer') setState({ kind: 'offer', offer: value.offer });
      else go(value.next, value.success_message);
    });
  }, [token]);

  const outcome = async (offer: OfferView, result: OfferActionResult): Promise<void> => {
    if (result.status === 'requires_action' && result.client_secret !== null && result.publishable_key !== null) {
      const stripe = await loadStripe(result.publishable_key, locale);
      const handled = await stripe.handleNextAction({ clientSecret: result.client_secret });
      if (handled.error !== undefined) {
        setAlert(handled.error.message ?? strings.paymentFailed);
        return;
      }
      const confirmed = await api.offerAction('confirm', token, offer.key);
      if (!confirmed.ok) {
        setAlert(strings.genericError);
        return;
      }
      if (confirmed.value.status === 'requires_action') {
        setAlert(strings.processing);
        return;
      }
      await outcome(offer, confirmed.value);
      return;
    }
    if (result.next !== null && result.status !== 'failed') {
      go(result.next, '');
      return;
    }
    setAlert(result.message ?? strings.paymentFailed);
  };

  const act = async (offer: OfferView, action: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(true);
    setAlert('');
    try {
      const result = await api.offerAction(action, token, offer.key);
      if (!result.ok) {
        if (result.failure.status === 404 || result.failure.status === 410) setState({ kind: 'message', text: strings.offerExpired });
        else setAlert(result.failure.status === 0 ? strings.networkError : strings.genericError);
        return;
      }
      await outcome(offer, result.value);
    } catch {
      setAlert(strings.genericError);
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'loading') return <div class="ac-root ac-offer" aria-busy="true" />;
  if (state.kind === 'message') {
    return (
      <div class="ac-root">
        <div class="af-success" role="status">
          {state.text}
        </div>
      </div>
    );
  }
  const offer = state.offer;
  const money = (minor: number) => formatMoney(minor, offer.currency, locale);
  const price = offer.recurring === null ? money(offer.amount_minor) : `${money(offer.amount_minor)} ${everyLabel(strings, offer.recurring.interval, offer.recurring.interval_count)}`;
  return (
    <div class="ac-root">
      <div class="ac-offer">
        {buttonsOnly ? null : (
          <>
            <h2 class="ac-offer-title">{offer.title !== '' ? offer.title : offer.name}</h2>
            {offer.description !== '' ? <div class="ac-item-desc">{offer.description}</div> : null}
            <div class="ac-offer-price">
              {offer.regular_amount_minor !== null ? <span class="ac-strike">{money(offer.regular_amount_minor)}</span> : null}
              {price}
            </div>
          </>
        )}
        {alert !== '' ? (
          <div class="af-alert" role="alert">
            {alert}
          </div>
        ) : null}
        <button type="button" class="af-button" disabled={busy} onClick={() => void act(offer, 'accept')}>
          {busy ? strings.offerProcessing : fill(strings.offerAccept, { amount: money(offer.amount_minor) })}
        </button>
        <div class="ac-muted">{strings.oneClickNote}</div>
        <button type="button" class="ac-decline" disabled={busy} onClick={() => void act(offer, 'decline')}>
          {strings.offerDecline}
        </button>
      </div>
    </div>
  );
}
