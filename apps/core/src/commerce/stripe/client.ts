/**
 * Minimal Stripe REST client over `fetch` (form-encoded requests, pinned API
 * version, idempotency keys). Only what checkouts and automatic renewals use:
 * customers, PaymentIntents, SetupIntents, payment methods, refunds.
 */

export const STRIPE_API = 'https://api.stripe.com';
export const STRIPE_API_VERSION = '2024-06-20';

export type StripeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface StripeError {
  type: string;
  code: string | null;
  decline_code: string | null;
  message: string;
  /** The intent the failed call was about (card errors on confirm). */
  payment_intent: StripePaymentIntent | null;
}

export class StripeApiError extends Error {
  override readonly name = 'StripeApiError';
  constructor(
    readonly status: number,
    readonly error: StripeError,
  ) {
    super(error.message);
  }
}

export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded';
  amount: number;
  amount_received: number;
  currency: string;
  client_secret: string | null;
  customer: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
  last_payment_error: { code?: string; decline_code?: string; message?: string } | null;
  latest_charge: string | null;
}

export interface StripeSetupIntent {
  id: string;
  object: 'setup_intent';
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'canceled'
    | 'succeeded';
  client_secret: string | null;
  customer: string | null;
  payment_method: string | null;
  metadata: Record<string, string>;
  last_setup_error: { code?: string; message?: string } | null;
}

export interface StripeCustomer {
  id: string;
  object: 'customer';
}

export interface StripeRefund {
  id: string;
  object: 'refund';
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'canceled';
  amount: number;
  charge: string | null;
  payment_intent: string | null;
  failure_reason: string | null;
}

export interface StripeChargeSummary {
  id: string;
  object: 'charge';
  amount: number;
  /** Cumulative, every refund of the charge included. */
  amount_refunded: number;
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** `a[b][c]=…` bracket encoding of nested params (Stripe's form convention). */
export function formEncode(params: Record<string, Param>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: Param): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${String(i)}]`, item));
    } else if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) walk(`${prefix}[${key}]`, nested);
    } else {
      out.append(prefix, String(value));
    }
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return out.toString();
}

function parseError(status: number, body: unknown): StripeApiError {
  const raw =
    typeof body === 'object' && body !== null && 'error' in body
      ? ((body as { error: Record<string, unknown> }).error ?? {})
      : {};
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return new StripeApiError(status, {
    type: str(raw['type']) ?? 'api_error',
    code: str(raw['code']),
    decline_code: str(raw['decline_code']),
    message: str(raw['message']) ?? `Stripe request failed (${String(status)})`,
    payment_intent:
      typeof raw['payment_intent'] === 'object' && raw['payment_intent'] !== null
        ? (raw['payment_intent'] as StripePaymentIntent)
        : null,
  });
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: StripeFetch,
  ) {}

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, Param> = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const body = formEncode(params);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
    };
    let url = `${STRIPE_API}${path}`;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    } else if (body !== '') {
      url = `${url}?${body}`;
    }
    const response = await this.fetchFn(url, {
      method,
      headers,
      ...(method === 'POST' ? { body } : {}),
    });
    const json: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw parseError(response.status, json);
    return json as T;
  }

  /** Cheap authenticated call to validate a secret key. */
  async verify(): Promise<void> {
    await this.request('GET', '/v1/balance');
  }

  createCustomer(
    params: { email: string | null; name: string | null; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeCustomer> {
    return this.request('POST', '/v1/customers', params, idempotencyKey);
  }

  /**
   * On-session intent the Payment Element confirms in the browser. With
   * `save` the method is attached to the customer for later off-session
   * charges (renewals, one-click post-purchase offers).
   */
  createPaymentIntent(
    params: {
      amount: number;
      currency: string;
      customer: string;
      save: boolean;
      description: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<StripePaymentIntent> {
    return this.request(
      'POST',
      '/v1/payment_intents',
      {
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        customer: params.customer,
        description: params.description,
        metadata: params.metadata,
        automatic_payment_methods: { enabled: true },
        ...(params.save ? { setup_future_usage: 'off_session' } : {}),
      },
      idempotencyKey,
    );
  }

  updatePaymentIntent(
    id: string,
    params: { amount: number; save: boolean; description: string; metadata: Record<string, string> },
  ): Promise<StripePaymentIntent> {
    return this.request('POST', `/v1/payment_intents/${encodeURIComponent(id)}`, {
      amount: params.amount,
      description: params.description,
      metadata: params.metadata,
      // Empty string unsets it.
      setup_future_usage: params.save ? 'off_session' : '',
    });
  }

  /**
   * Charges a saved method. `offSession`: the buyer is not present (renewals);
   * otherwise the buyer just clicked (one-click offers) and 3-D Secure may be
   * asked back through `requires_action`.
   */
  chargeSavedMethod(
    params: {
      amount: number;
      currency: string;
      customer: string;
      paymentMethod: string;
      offSession: boolean;
      description: string;
      metadata: Record<string, string>;
    },
    idempotencyKey: string,
  ): Promise<StripePaymentIntent> {
    return this.request(
      'POST',
      '/v1/payment_intents',
      {
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        customer: params.customer,
        payment_method: params.paymentMethod,
        confirm: true,
        description: params.description,
        metadata: params.metadata,
        // Saved methods never redirect: 3-D Secure comes back as `requires_action`.
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        ...(params.offSession ? { off_session: true } : {}),
      },
      idempotencyKey,
    );
  }

  retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
    return this.request('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
  }

  cancelPaymentIntent(id: string): Promise<StripePaymentIntent> {
    return this.request('POST', `/v1/payment_intents/${encodeURIComponent(id)}/cancel`);
  }

  /** Saves a method without charging (trial subscriptions, 100% discounts). */
  createSetupIntent(
    params: { customer: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeSetupIntent> {
    return this.request(
      'POST',
      '/v1/setup_intents',
      {
        customer: params.customer,
        usage: 'off_session',
        metadata: params.metadata,
        automatic_payment_methods: { enabled: true },
      },
      idempotencyKey,
    );
  }

  retrieveSetupIntent(id: string): Promise<StripeSetupIntent> {
    return this.request('GET', `/v1/setup_intents/${encodeURIComponent(id)}`);
  }

  /** Full or partial refund of a PaymentIntent's charge, back to the buyer's card. */
  createRefund(
    params: { paymentIntent: string; amount: number; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeRefund> {
    return this.request(
      'POST',
      '/v1/refunds',
      { payment_intent: params.paymentIntent, amount: params.amount, metadata: params.metadata },
      idempotencyKey,
    );
  }

  retrieveCharge(id: string): Promise<StripeChargeSummary> {
    return this.request('GET', `/v1/charges/${encodeURIComponent(id)}`);
  }
}
