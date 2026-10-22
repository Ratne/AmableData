/**
 * Minimal typing of Stripe.js v3 (loaded from js.stripe.com, never bundled)
 * for the deferred-intent Payment Element flow.
 */

export interface StripeError {
  readonly type: string;
  readonly code?: string;
  readonly message?: string;
}

export interface StripeElementsOptions {
  mode: 'payment' | 'setup';
  amount?: number;
  currency: string;
  setupFutureUsage?: 'off_session' | null;
  paymentMethodCreation?: 'manual';
  appearance?: { theme?: 'stripe' | 'flat'; variables?: Record<string, string> };
  locale?: string;
}

export interface StripePaymentElement {
  mount(target: HTMLElement): void;
  destroy(): void;
  on(event: 'change', handler: (event: { complete: boolean }) => void): void;
}

export interface StripeElements {
  create(kind: 'payment', options?: { layout?: 'tabs' | 'accordion'; fields?: unknown }): StripePaymentElement;
  update(options: Partial<StripeElementsOptions>): void;
  submit(): Promise<{ error?: StripeError }>;
}

interface ConfirmParams {
  return_url: string;
  payment_method_data?: { billing_details?: { email?: string; name?: string } };
}

export interface StripeJs {
  elements(options: StripeElementsOptions): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    clientSecret: string;
    confirmParams: ConfirmParams;
    redirect: 'if_required';
  }): Promise<{ error?: StripeError; paymentIntent?: { status: string } }>;
  confirmSetup(options: {
    elements: StripeElements;
    clientSecret: string;
    confirmParams: ConfirmParams;
    redirect: 'if_required';
  }): Promise<{ error?: StripeError; setupIntent?: { status: string } }>;
  handleNextAction(options: { clientSecret: string }): Promise<{ error?: StripeError; paymentIntent?: { status: string } }>;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string, options?: { locale?: string }) => StripeJs;
  }
}

const SRC = 'https://js.stripe.com/v3/';
let loading: Promise<NonNullable<Window['Stripe']>> | null = null;

function loadScript(): Promise<NonNullable<Window['Stripe']>> {
  if (window.Stripe !== undefined) return Promise.resolve(window.Stripe);
  if (loading !== null) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.onload = () => (window.Stripe === undefined ? reject(new Error('stripe')) : resolve(window.Stripe));
    script.onerror = () => {
      loading = null;
      reject(new Error('stripe'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

const instances = new Map<string, StripeJs>();

export async function loadStripe(publishableKey: string, locale: string): Promise<StripeJs> {
  const key = `${publishableKey}:${locale}`;
  const existing = instances.get(key);
  if (existing !== undefined) return existing;
  const factory = await loadScript();
  const stripe = factory(publishableKey, { locale });
  instances.set(key, stripe);
  return stripe;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/** Payment Element theme from the checkout style (only values Stripe accepts). */
export function appearanceOf(style: {
  primary_color: string;
  text_color: string;
  radius: string;
  font_family: string;
}): NonNullable<StripeElementsOptions['appearance']> {
  const variables: Record<string, string> = {};
  if (HEX.test(style.primary_color)) variables['colorPrimary'] = style.primary_color;
  if (HEX.test(style.text_color)) variables['colorText'] = style.text_color;
  if (/^\d+(\.\d+)?px$/.test(style.radius)) variables['borderRadius'] = style.radius;
  if (style.font_family !== '' && !/[;{}]/.test(style.font_family)) variables['fontFamily'] = style.font_family;
  return { theme: 'stripe', variables };
}
