import type {
  AddressSuggestion,
  CompleteResult,
  OfferActionResult,
  OfferState,
  PublicCheckoutConfig,
  Quote,
  SelectionInput,
  SessionPayloadInput,
  SessionResult,
} from '../public';

/** HTTP client of the edge checkout routes (same origin as the script). */

export interface ApiFailure {
  readonly status: number;
  readonly error: string;
  readonly message: string;
  readonly details: ReadonlyArray<{ path: string; message: string }>;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

async function call<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return { ok: true, value: parsed as T };
    return {
      ok: false,
      failure: {
        status: response.status,
        error: typeof parsed['error'] === 'string' ? parsed['error'] : 'error',
        message: typeof parsed['message'] === 'string' ? parsed['message'] : '',
        details: Array.isArray(parsed['details']) ? (parsed['details'] as ApiFailure['details']) : [],
      },
    };
  } catch {
    return { ok: false, failure: { status: 0, error: 'network', message: '', details: [] } };
  }
}

export class CheckoutApi {
  constructor(
    readonly base: string,
    readonly tenant: string,
  ) {}

  private url(path: string): string {
    return `${this.base}/c/${encodeURIComponent(this.tenant)}/${path}`;
  }

  private checkoutUrl(id: string, path: string): string {
    return this.url(`${encodeURIComponent(id)}/${path}`);
  }

  config(id: string): Promise<ApiResult<PublicCheckoutConfig>> {
    return call(this.checkoutUrl(id, 'config'));
  }

  quote(id: string, selection: SelectionInput, promoCode: string): Promise<ApiResult<Quote>> {
    return call(this.checkoutUrl(id, 'quote'), { selection, promo_code: promoCode });
  }

  session(id: string, payload: SessionPayloadInput): Promise<ApiResult<SessionResult>> {
    return call(this.checkoutUrl(id, 'session'), payload);
  }

  address(id: string, q: string, country: string, lang: string): Promise<ApiResult<{ data: AddressSuggestion[]; attribution?: string | null }>> {
    return call(this.checkoutUrl(id, 'address'), { q, country, lang });
  }

  complete(token: string): Promise<ApiResult<CompleteResult>> {
    return call(this.url('session/complete'), { token });
  }

  offer(token: string): Promise<ApiResult<OfferState>> {
    return call(this.url('session/offer'), { token });
  }

  offerAction(action: 'accept' | 'confirm' | 'decline', token: string, offerKey: string): Promise<ApiResult<OfferActionResult>> {
    return call(this.url(`session/${action}`), { token, offer_key: offerKey });
  }

  /** Hosted post-purchase offer page (offers without their own page). */
  offerPage(): string {
    return this.url('offer');
  }
}
