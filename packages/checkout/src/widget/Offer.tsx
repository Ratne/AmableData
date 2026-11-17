import { useEffect, useState } from 'preact/hooks';
import { OFFER_RETURN_PARAM, SESSION_PARAM } from '../gateway';
import type { BankTransferDetails, NextStep, OfferActionResult, OfferView } from '../public';
import {
  everyLabel,
  fill,
  formatMoney,
  type CheckoutLocale,
  type CheckoutStrings,
} from '../strings';
import type { CheckoutApi } from './api';
import { BankDetails } from './BankDetails';
import { followNext, navigate, widgetNavigated, withParam } from './nav';
import { loadStripe } from './stripe';

export interface OfferProps {
  api: CheckoutApi;
  token: string;
  strings: CheckoutStrings;
  locale: CheckoutLocale;
  /** Only the accept/decline buttons (the page around describes the offer). */
  buttonsOnly: boolean;
  /** Custom accept text (`{amount}` = price); empty: the default one. */
  acceptLabel: string;
  declineLabel: string;
  /** Draft preview: sample offer, no calls. */
  preview: boolean;
}

const PREVIEW_OFFER: OfferView = {
  key: 'preview',
  kind: 'upsell',
  title: 'Special offer',
  description: 'Post-purchase offer description.',
  image_url: '',
  name: 'Product',
  currency: 'EUR',
  amount_minor: 4700,
  regular_amount_minor: 9700,
  quantity: 1,
  recurring: null,
  checkout_id: '',
  locale: 'en',
  payment_method: 'card',
  card_flow: 'element',
};

type State =
  | { kind: 'loading' }
  | { kind: 'offer'; offer: OfferView }
  | { kind: 'message'; text: string; bank: BankTransferDetails | null };

/** This page as Stripe Checkout should come back to it (the session token kept, the return marker dropped). */
function offerReturnUrl(token: string): string {
  const url = new URL(withParam(location.href, SESSION_PARAM, token));
  url.searchParams.delete(OFFER_RETURN_PARAM);
  return url.toString();
}

/**
 * Post-purchase offer block (`data-amable-offer`): one click charges the
 * card saved by the checkout; 3-D Secure, when the bank asks for it, runs in
 * place. Bank transfer purchases add the offer to the transfer to make;
 * Managed Payments ones pay it on Stripe Checkout. Accept and decline both
 * follow the chain configured on the checkout.
 */
export function Offer({
  api,
  token,
  strings,
  locale,
  buttonsOnly,
  acceptLabel,
  declineLabel,
  preview,
}: OfferProps) {
  const [state, setState] = useState<State>(
    preview ? { kind: 'offer', offer: PREVIEW_OFFER } : { kind: 'loading' },
  );
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState('');

  const go = (next: NextStep, message: string) => {
    if (followNext(api, next, token) === 'navigating') {
      setState({ kind: 'message', text: strings.redirecting, bank: null });
      return;
    }
    setState({ kind: 'message', text: message !== '' ? message : strings.success, bank: null });
    // End of the chain of a bank transfer purchase: show where to transfer.
    void api.complete(token).then((result) => {
      if (result.ok && result.value.bank_transfer !== null) {
        setState({ kind: 'message', text: strings.bankPending, bank: result.value.bank_transfer });
      }
    });
  };

  useEffect(() => {
    if (preview) return;
    if (token === '') {
      setState({ kind: 'message', text: strings.offerExpired, bank: null });
      return;
    }
    void api.offer(token).then((result) => {
      if (!result.ok) {
        setState({
          kind: 'message',
          text: result.failure.status === 0 ? strings.networkError : strings.offerExpired,
          bank: null,
        });
        return;
      }
      const value = result.value;
      if (value.status !== 'offer') {
        go(value.next, value.success_message);
        return;
      }
      setState({ kind: 'offer', offer: value.offer });
      // Back from Stripe Checkout: read how the offer payment went.
      if (new URLSearchParams(location.search).get(OFFER_RETURN_PARAM) === value.offer.key)
        void act(value.offer, 'confirm');
    });
  }, [token]);

  // The buyer leaves a bank transfer purchase: the summary email goes out now rather than after the idle time.
  const bank = state.kind === 'offer' && state.offer.payment_method === 'bank_transfer';
  useEffect(() => {
    if (!bank) return undefined;
    const onHide = () => {
      if (!widgetNavigated()) api.flush(token);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [bank, token]);

  const outcome = async (offer: OfferView, result: OfferActionResult): Promise<void> => {
    if (result.status === 'redirect' && result.redirect_url !== null) {
      setState({ kind: 'message', text: strings.redirecting, bank: null });
      navigate(result.redirect_url);
      return;
    }
    if (
      result.status === 'requires_action' &&
      result.client_secret !== null &&
      result.publishable_key !== null
    ) {
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

  const act = async (offer: OfferView, action: 'accept' | 'decline' | 'confirm') => {
    if (busy) return;
    if (preview) {
      setAlert(strings.previewNotice);
      return;
    }
    setBusy(true);
    setAlert('');
    try {
      const result = await api.offerAction(
        action,
        token,
        offer.key,
        action === 'accept' ? offerReturnUrl(token) : '',
      );
      if (!result.ok) {
        if (result.failure.status === 404 || result.failure.status === 410) {
          setState({ kind: 'message', text: strings.offerExpired, bank: null });
        } else setAlert(result.failure.status === 0 ? strings.networkError : strings.genericError);
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
        <div class="af-success" part="message" role="status">
          {state.text}
        </div>
        {state.bank !== null ? (
          <BankDetails details={state.bank} strings={strings} locale={locale} />
        ) : null}
      </div>
    );
  }
  const offer = state.offer;
  const money = (minor: number) => formatMoney(minor, offer.currency, locale);
  const price =
    offer.recurring === null
      ? money(offer.amount_minor)
      : `${money(offer.amount_minor)} ${everyLabel(strings, offer.recurring.interval, offer.recurring.interval_count)}`;
  const note =
    offer.payment_method === 'bank_transfer'
      ? strings.offerBankNote
      : offer.card_flow === 'redirect'
        ? strings.redirectNote
        : strings.oneClickNote;
  return (
    <div class="ac-root">
      <div class="ac-offer" part="box">
        {buttonsOnly ? null : (
          <>
            {offer.image_url !== '' ? (
              <img class="ac-offer-img" src={offer.image_url} alt="" loading="lazy" />
            ) : null}
            <h2 class="ac-offer-title" part="title">
              {offer.title !== '' ? offer.title : offer.name}
            </h2>
            {offer.description !== '' ? (
              <div class="ac-item-desc" part="description">
                {offer.description}
              </div>
            ) : null}
            <div class="ac-offer-price" part="price">
              {offer.regular_amount_minor !== null ? (
                <span class="ac-strike" part="strike">
                  {money(offer.regular_amount_minor)}
                </span>
              ) : null}
              {price}
            </div>
          </>
        )}
        {alert !== '' ? (
          <div class="af-alert" role="alert">
            {alert}
          </div>
        ) : null}
        <button
          type="button"
          class="af-button"
          part="accept"
          disabled={busy}
          onClick={() => void act(offer, 'accept')}
        >
          {busy
            ? strings.offerProcessing
            : fill(acceptLabel !== '' ? acceptLabel : strings.offerAccept, {
                amount: money(offer.amount_minor),
              })}
        </button>
        <div class="ac-muted" part="note">
          {note}
        </div>
        <button
          type="button"
          class="ac-decline"
          part="decline"
          disabled={busy}
          onClick={() => void act(offer, 'decline')}
        >
          {declineLabel !== '' ? declineLabel : strings.offerDecline}
        </button>
      </div>
    </div>
  );
}
