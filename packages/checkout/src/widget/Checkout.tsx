import { collectMeta, collectTracking, initialValues } from '@amable/forms/widget/capture';
import { FieldRow } from '@amable/forms/widget/fields';
import { WIDGET_STRINGS } from '@amable/forms/strings';
import { EMAIL_RE, validateSubmission, visibleFieldKeys } from '@amable/forms/validate';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { countryOptions } from '../countries';
import type { ContactFieldMode } from '../schema';
import type { AddressSuggestion, PublicBump, PublicCheckoutConfig, PublicCheckoutItem, Quote, QuoteLine } from '../public';
import { everyLabel, fill, formatMoney, type CheckoutLocale, type CheckoutStrings } from '../strings';
import type { CheckoutApi } from './api';
import { followNext, sessionTokenFromUrl, storedToken, storeToken, withParam } from './nav';
import { appearanceOf, loadStripe, type StripeElements, type StripeJs } from './stripe';
import { PAYMENT_SLOT } from './styles';

export interface CheckoutProps {
  config: PublicCheckoutConfig;
  api: CheckoutApi;
  strings: CheckoutStrings;
  locale: CheckoutLocale;
  host: HTMLElement;
  /** Light-DOM node slotted into the shadow root, where the Payment Element mounts. */
  paymentHost: HTMLElement;
  /** Builder preview: no network, no payment. */
  preview: boolean;
}

interface Selection {
  items: string[];
  quantities: Record<string, number>;
  bumps: string[];
}

type Buyer = Record<
  | 'email'
  | 'given_name'
  | 'family_name'
  | 'phone'
  | 'company_name'
  | 'address_line1'
  | 'address_line2'
  | 'address_city'
  | 'address_postal_code'
  | 'address_region'
  | 'address_country',
  string
>;

type Done = { message: string; order: string | null };

function initialSelection(config: PublicCheckoutConfig): Selection {
  const items =
    config.settings.item_selection === 'one'
      ? [(config.items.find((i) => i.preselected) ?? config.items[0])?.id ?? ''].filter((id) => id !== '')
      : config.items.map((i) => i.id);
  return { items, quantities: {}, bumps: config.bumps.filter((b) => b.checked).map((b) => b.id) };
}

function initialBuyer(config: PublicCheckoutConfig): Buyer {
  const params = new URLSearchParams(location.search);
  const get = (...keys: string[]) => {
    for (const key of keys) {
      const value = params.get(key);
      if (value !== null && value !== '') return value.slice(0, 200);
    }
    return '';
  };
  return {
    email: get('email'),
    given_name: get('given_name', 'first_name', 'name'),
    family_name: get('family_name', 'last_name'),
    phone: get('phone'),
    company_name: get('company', 'company_name'),
    address_line1: '',
    address_line2: '',
    address_city: '',
    address_postal_code: '',
    address_region: '',
    address_country: config.contact.default_country,
  };
}

/** Before (or without) the server quote: list prices, no promo nor taxes. */
function localQuote(config: PublicCheckoutConfig, selection: Selection): Quote {
  const lines: QuoteLine[] = [];
  let recurring: Quote['recurring'] = null;
  const line = (name: string, amount: number, quantity: number, kind: QuoteLine['kind']) =>
    lines.push({ name, quantity, subtotal_minor: amount, discount_minor: 0, total_minor: amount, kind });
  for (const item of config.items) {
    if (!selection.items.includes(item.id)) continue;
    const quantity = selection.quantities[item.id] ?? item.quantity;
    const r = item.recurring;
    if (r !== null) {
      recurring = {
        amount_minor: item.unit_price_minor * quantity,
        interval: r.interval,
        interval_count: r.interval_count,
        trial_days: r.trial_days,
        discounted_periods: null,
        discounted_amount_minor: null,
      };
      if (r.trial_days > 0) line(item.name, 0, quantity, 'trial');
      else line(item.name, item.unit_price_minor * quantity, quantity, 'item');
      if (r.setup_fee_minor > 0) line(item.name, r.setup_fee_minor, 1, 'setup_fee');
    } else line(item.name, item.unit_price_minor * quantity, quantity, 'item');
  }
  for (const bump of config.bumps) {
    if (selection.bumps.includes(bump.id)) line(bump.title, bump.unit_price_minor * bump.quantity, bump.quantity, 'bump');
  }
  const total = lines.reduce((sum, l) => sum + l.total_minor, 0);
  return {
    currency: config.currency,
    lines,
    subtotal_minor: total,
    discount_minor: 0,
    tax_minor: 0,
    total_minor: total,
    recurring,
    promo: null,
  };
}

function modeLabel(mode: ContactFieldMode, label: string): string {
  return mode === 'required' ? `${label} *` : label;
}

export function Checkout({ config, api, strings, locale, host, paymentHost, preview }: CheckoutProps) {
  const fieldStrings = WIDGET_STRINGS[locale];
  const money = (minor: number) => formatMoney(minor, config.currency, locale);
  const promoParam = config.settings.promo_param;
  const [selection, setSelection] = useState<Selection>(() => initialSelection(config));
  const [buyer, setBuyer] = useState<Buyer>(() => initialBuyer(config));
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(config.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState(false);
  const [promoInput, setPromoInput] = useState(() =>
    config.settings.promo_codes && promoParam !== '' ? (new URLSearchParams(location.search).get(promoParam) ?? '').slice(0, 64) : '',
  );
  const [promoCode, setPromoCode] = useState(promoInput);
  const [quote, setQuote] = useState<Quote>(() => localQuote(config, initialSelection(config)));
  const [alert, setAlert] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [stripeReady, setStripeReady] = useState(false);
  const stripe = useRef<{ js: StripeJs; elements: StripeElements } | null>(null);
  const mountedAt = useRef(Date.now());
  const hp = useRef<HTMLInputElement>(null);

  const hasPlan = config.items.some((i) => i.recurring !== null && selection.items.includes(i.id));
  const intentMode: 'payment' | 'setup' | 'none' = quote.total_minor > 0 ? 'payment' : hasPlan ? 'setup' : 'none';
  const saveCard = hasPlan || config.offers_enabled;
  const visible = visibleFieldKeys(config.fields, values);
  const selectionKey = JSON.stringify(selection);

  useEffect(() => {
    collectTracking();
  }, []);

  // Back from a redirect-based payment method (bank page): settle and move on.
  useEffect(() => {
    if (preview) return;
    const params = new URLSearchParams(location.search);
    const token = sessionTokenFromUrl();
    if (token === '' || params.get('redirect_status') === null) return;
    setBusy(true);
    void api.complete(token).then((result) => {
      setBusy(false);
      if (!result.ok || result.value.status === 'failed') {
        setAlert(result.ok && result.value.message !== null ? result.value.message : strings.paymentFailed);
        return;
      }
      finish(token, result.value.next, result.value.status === 'processing' ? strings.processing : result.value.success_message, result.value.order_number);
    });
  }, []);

  useEffect(() => {
    const local = localQuote(config, selection);
    if (preview) {
      setQuote(local);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void api.quote(config.id, selection, promoCode).then((result) => setQuote(result.ok ? result.value : local));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [selectionKey, promoCode]);

  // Payment Element: created once Stripe.js is there, updated when the amount or the mode change.
  useEffect(() => {
    if (preview || config.stripe_publishable_key === null || intentMode === 'none') return;
    const options = {
      mode: intentMode,
      currency: config.currency.toLowerCase(),
      ...(intentMode === 'payment'
        ? { amount: quote.total_minor, setupFutureUsage: saveCard ? ('off_session' as const) : null }
        : {}),
    };
    if (stripe.current !== null) {
      stripe.current.elements.update(options);
      return;
    }
    let cancelled = false;
    void loadStripe(config.stripe_publishable_key, locale)
      .then((js) => {
        if (cancelled || stripe.current !== null) return;
        const elements = js.elements({ ...options, appearance: appearanceOf(config.style) });
        elements.create('payment', { layout: 'tabs' }).mount(paymentHost);
        stripe.current = { js, elements };
        setStripeReady(true);
      })
      .catch(() => setAlert(strings.loadError));
    return () => {
      cancelled = true;
    };
  }, [intentMode, quote.total_minor, saveCard]);

  useEffect(() => {
    paymentHost.style.display = intentMode === 'none' ? 'none' : '';
  }, [intentMode]);

  const finish = (token: string, next: Parameters<typeof followNext>[1] | null, message: string, order: string | null) => {
    storeToken(config.id, null);
    if (next !== null && followNext(api, next, token) === 'navigating') {
      setDone({ message: strings.redirecting, order: null });
      return;
    }
    setDone({ message: message !== '' ? message : config.settings.success_message || strings.success, order });
  };

  const setBuyerField = (key: keyof Buyer, value: string) => {
    setBuyer((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const setValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const fieldError = (code: string) =>
    Object.hasOwn(fieldStrings.fieldErrors, code)
      ? fieldStrings.fieldErrors[code as keyof typeof fieldStrings.fieldErrors]
      : fieldStrings.fieldErrors.invalid_value;

  const localCheck = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const c = config.contact;
    if (buyer.email.trim() === '') out['email'] = fieldError('required');
    else if (!EMAIL_RE.test(buyer.email.trim())) out['email'] = fieldError('invalid_email');
    const need = (mode: ContactFieldMode, keys: Array<keyof Buyer>) => {
      if (mode !== 'required') return;
      for (const key of keys) if (buyer[key].trim() === '') out[key] = fieldError('required');
    };
    need(c.name, ['given_name', 'family_name']);
    need(c.phone, ['phone']);
    need(c.company, ['company_name']);
    need(c.address, ['address_line1', 'address_city', 'address_postal_code', 'address_country']);
    const custom = validateSubmission(config, values);
    if (!custom.ok) for (const [key, code] of Object.entries(custom.errors)) out[key] = fieldError(code);
    if (config.settings.terms_url !== '' && !terms) out['terms_accepted'] = strings.termsRequired;
    return out;
  };

  const showErrors = (found: Record<string, string>) => {
    setErrors(found);
    setAlert(found['terms_accepted'] !== undefined && Object.keys(found).length === 1 ? strings.termsRequired : strings.fixErrors);
    window.setTimeout(() => host.shadowRoot?.querySelector<HTMLElement>('[data-af-invalid] input, [data-af-invalid] select, [data-af-invalid] textarea')?.focus(), 30);
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (busy) return;
    setAlert('');
    const found = localCheck();
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    if (preview) {
      setAlert(strings.previewNotice);
      return;
    }
    if (config.stripe_publishable_key === null) {
      setAlert(strings.stripeMissing);
      return;
    }
    setBusy(true);
    try {
      const s = stripe.current;
      if (intentMode !== 'none') {
        if (s === null) {
          setAlert(strings.loadError);
          return;
        }
        const submitted = await s.elements.submit();
        if (submitted.error !== undefined) {
          setAlert(submitted.error.message ?? strings.paymentFailed);
          return;
        }
      }
      const custom = validateSubmission(config, values);
      const result = await api.session(config.id, {
        selection,
        promo_code: quote.promo?.applied === true ? quote.promo.code : '',
        buyer: {
          email: buyer.email,
          given_name: buyer.given_name,
          family_name: buyer.family_name,
          phone: buyer.phone,
          company_name: buyer.company_name,
          address: {
            line1: buyer.address_line1,
            line2: buyer.address_line2,
            city: buyer.address_city,
            postal_code: buyer.address_postal_code,
            region: buyer.address_region,
            country: buyer.address_country,
          },
        },
        values: custom.ok ? custom.values : {},
        tracking: collectTracking(),
        meta: collectMeta(host),
        terms_accepted: terms,
        session_token: storedToken(config.id),
        hp: hp.current?.value ?? '',
        elapsed_ms: Math.min(Date.now() - mountedAt.current, 86_400_000),
      });
      if (!result.ok) {
        const f = result.failure;
        if (f.error === 'validation_failed' && f.details.length > 0) {
          const mapped: Record<string, string> = {};
          for (const d of f.details) {
            const key = d.path.replace(/^values\./, '');
            mapped[key] = key === 'terms_accepted' ? strings.termsRequired : key === 'promo_code' ? d.message : fieldError(d.message);
          }
          showErrors(mapped);
        } else if (f.error === 'domain_not_allowed') setAlert(strings.domainNotAllowed);
        else if (f.error === 'stripe_not_configured') setAlert(strings.stripeMissing);
        else if (f.status === 0) setAlert(strings.networkError);
        else if (f.status === 404) setAlert(strings.notFound);
        else setAlert(f.message !== '' && f.status < 500 ? f.message : strings.genericError);
        return;
      }
      const { session_token: token, intent } = result.value;
      storeToken(config.id, token);
      setQuote(result.value.quote);
      if (intent.kind !== 'none' && s !== null && intent.client_secret !== null) {
        const confirmParams = {
          return_url: withParam(location.href, 'amb_cs', token),
          payment_method_data: {
            billing_details: { email: buyer.email, name: `${buyer.given_name} ${buyer.family_name}`.trim() },
          },
        };
        const confirmed =
          intent.kind === 'payment'
            ? await s.js.confirmPayment({ elements: s.elements, clientSecret: intent.client_secret, confirmParams, redirect: 'if_required' })
            : await s.js.confirmSetup({ elements: s.elements, clientSecret: intent.client_secret, confirmParams, redirect: 'if_required' });
        if (confirmed.error !== undefined) {
          setAlert(confirmed.error.message ?? strings.paymentFailed);
          return;
        }
      }
      const completed = await api.complete(token);
      if (!completed.ok) {
        setAlert(completed.failure.status === 0 ? strings.networkError : strings.genericError);
        return;
      }
      const c = completed.value;
      if (c.status === 'failed') {
        setAlert(c.message ?? strings.paymentFailed);
        return;
      }
      finish(token, c.next, c.status === 'processing' ? strings.processing : c.success_message, c.order_number);
    } finally {
      setBusy(false);
    }
  };

  const countries = useMemo(() => countryOptions(locale), [locale]);

  if (done !== null) {
    return (
      <div class="ac-root">
        <div class="af-success" role="status">
          <div>{done.message}</div>
          {done.order !== null ? <div class="ac-muted">{fill(strings.orderNumber, { number: done.order })}</div> : null}
        </div>
      </div>
    );
  }

  const bumpsAt = (position: PublicBump['position']) =>
    config.bumps
      .filter((b) => b.position === position)
      .map((b) => (
        <BumpBox
          key={b.id}
          bump={b}
          money={money}
          strings={strings}
          checked={selection.bumps.includes(b.id)}
          onToggle={(on) =>
            setSelection((prev) => ({ ...prev, bumps: on ? [...prev.bumps, b.id] : prev.bumps.filter((id) => id !== b.id) }))
          }
        />
      ));

  const c = config.contact;
  const input = (key: keyof Buyer, label: string, mode: ContactFieldMode, type = 'text', autoComplete = 'on') =>
    mode === 'hidden' ? null : (
      <div class={`af-field${errors[key] !== undefined ? ' af-invalid' : ''}`} data-af-invalid={errors[key] === undefined ? undefined : ''}>
        <label class="af-label" for={`ac-${key}`}>
          {modeLabel(mode, label)}
        </label>
        <input
          id={`ac-${key}`}
          class="af-input"
          type={type}
          autoComplete={autoComplete}
          value={buyer[key]}
          onInput={(e) => setBuyerField(key, (e.target as HTMLInputElement).value)}
        />
        {errors[key] !== undefined ? <div class="af-error">{errors[key]}</div> : null}
      </div>
    );

  const buttonLabel =
    config.settings.button_label !== ''
      ? config.settings.button_label
      : intentMode === 'setup'
        ? strings.start
        : fill(strings.pay, { amount: money(quote.total_minor) });

  return (
    <div class="ac-root">
      <form class="ac-grid" onSubmit={(e) => void onSubmit(e)} noValidate>
        <div class="ac-main">
          {config.settings.heading !== '' ? <h2 class="ac-heading">{config.settings.heading}</h2> : null}
          {preview ? <div class="af-notice">{strings.previewNotice}</div> : null}
          <Items config={config} selection={selection} setSelection={setSelection} money={money} strings={strings} />
          {bumpsAt('below_items')}
          <section class="ac-section">
            <div class="ac-section-title">{strings.contactTitle}</div>
            {input('email', strings.email, 'required', 'email', 'email')}
            {c.name !== 'hidden' ? (
              <div class="ac-row">
                {input('given_name', strings.firstName, c.name, 'text', 'given-name')}
                {input('family_name', strings.lastName, c.name, 'text', 'family-name')}
              </div>
            ) : null}
            {input('phone', strings.phone, c.phone, 'tel', 'tel')}
            {input('company_name', strings.company, c.company, 'text', 'organization')}
            {c.address !== 'hidden' ? (
              <>
                <AddressLine
                  api={api}
                  config={config}
                  locale={locale}
                  preview={preview}
                  label={modeLabel(c.address, strings.addressLine1)}
                  value={buyer.address_line1}
                  country={buyer.address_country}
                  error={errors['address_line1']}
                  onInput={(v) => setBuyerField('address_line1', v)}
                  onPick={(s) => {
                    const line1 = s.street_number !== null && !s.line1.includes(s.street_number) ? `${s.line1}, ${s.street_number}` : s.line1;
                    setBuyer((prev) => ({
                      ...prev,
                      address_line1: line1,
                      address_city: s.locality ?? prev.address_city,
                      address_region: s.region ?? prev.address_region,
                      address_postal_code: s.postal_code ?? prev.address_postal_code,
                      address_country: s.country_code ?? prev.address_country,
                    }));
                    setErrors({});
                  }}
                />
                {input('address_line2', strings.addressLine2, 'optional', 'text', 'address-line2')}
                <div class="ac-row">
                  {input('address_postal_code', strings.postalCode, c.address, 'text', 'postal-code')}
                  {input('address_city', strings.city, c.address, 'text', 'address-level2')}
                </div>
                <div class="ac-row">
                  {input('address_region', strings.region, 'optional', 'text', 'address-level1')}
                  <div
                    class={`af-field${errors['address_country'] !== undefined ? ' af-invalid' : ''}`}
                    data-af-invalid={errors['address_country'] === undefined ? undefined : ''}
                  >
                    <label class="af-label" for="ac-address_country">
                      {modeLabel(c.address, strings.country)}
                    </label>
                    <select
                      id="ac-address_country"
                      class="af-select"
                      autoComplete="country"
                      value={buyer.address_country}
                      onChange={(e) => setBuyerField('address_country', (e.target as HTMLSelectElement).value)}
                    >
                      {c.address === 'required' ? null : <option value="">—</option>}
                      {countries.map((o) => (
                        <option key={o.code} value={o.code}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                    {errors['address_country'] !== undefined ? <div class="af-error">{errors['address_country']}</div> : null}
                  </div>
                </div>
              </>
            ) : null}
          </section>
          {config.fields.length > 0 ? (
            <section class="ac-section">
              <div class="ac-section-title">{strings.detailsTitle}</div>
              <div class="af-form">
                {config.fields.map((field) =>
                  visible.has(field.key) ? (
                    <FieldRow
                      key={field.id}
                      field={field}
                      value={values[field.key]}
                      error={errors[field.key]}
                      strings={fieldStrings}
                      onChange={(value) => setValue(field.key, value)}
                    />
                  ) : null,
                )}
              </div>
            </section>
          ) : null}
          {bumpsAt('above_payment')}
          <section class="ac-section" style={intentMode === 'none' ? 'display:none' : undefined}>
            <div class="ac-section-title">{strings.paymentTitle}</div>
            {config.stripe_publishable_key === null && !preview ? <div class="af-alert">{strings.stripeMissing}</div> : null}
            {preview ? <div class="af-notice">{strings.previewNotice}</div> : null}
            <div class="ac-payment">
              <slot name={PAYMENT_SLOT} />
            </div>
          </section>
          {bumpsAt('below_payment')}
          {config.settings.terms_url !== '' ? (
            <div class={`af-field${errors['terms_accepted'] !== undefined ? ' af-invalid' : ''}`}>
              <label class="af-choice">
                <input type="checkbox" checked={terms} onChange={(e) => setTerms((e.target as HTMLInputElement).checked)} />
                <span>
                  <a href={config.settings.terms_url} target="_blank" rel="noopener noreferrer">
                    {config.settings.terms_label || strings.terms}
                  </a>
                </span>
              </label>
            </div>
          ) : null}
          <input ref={hp} class="af-hp" tabIndex={-1} autoComplete="off" name="company_website" aria-hidden="true" />
          {alert !== '' ? (
            <div class="af-alert" role="alert">
              {alert}
            </div>
          ) : null}
          <div class="af-actions">
            <button type="submit" class="af-button" disabled={busy || (intentMode !== 'none' && !stripeReady && !preview)}>
              {busy ? strings.paying : buttonLabel}
            </button>
          </div>
        </div>
        <Summary
          quote={quote}
          strings={strings}
          money={money}
          promoEnabled={config.settings.promo_codes}
          promoInput={promoInput}
          setPromoInput={setPromoInput}
          applied={promoCode}
          apply={(code) => setPromoCode(code.trim())}
        />
      </form>
    </div>
  );
}

function Items({
  config,
  selection,
  setSelection,
  money,
  strings,
}: {
  config: PublicCheckoutConfig;
  selection: Selection;
  setSelection: (fn: (prev: Selection) => Selection) => void;
  money: (minor: number) => string;
  strings: CheckoutStrings;
}) {
  const pickOne = config.settings.item_selection === 'one';
  const price = (item: PublicCheckoutItem) => {
    const base = money(item.unit_price_minor);
    if (item.recurring === null) return base;
    return `${base} ${everyLabel(strings, item.recurring.interval, item.recurring.interval_count)}`;
  };
  return (
    <section class="ac-section">
      {pickOne && config.items.length > 1 ? <div class="ac-section-title">{strings.chooseOne}</div> : null}
      <div class="ac-items" role={pickOne ? 'radiogroup' : undefined}>
        {config.items.map((item) => {
          const on = selection.items.includes(item.id);
          const body = (
            <>
              {pickOne ? (
                <input
                  type="radio"
                  name="ac-item"
                  checked={on}
                  onChange={() => setSelection((prev) => ({ ...prev, items: [item.id] }))}
                />
              ) : null}
              {item.image_url !== '' ? <img class="ac-thumb" src={item.image_url} alt="" loading="lazy" /> : null}
              <div class="ac-item-body">
                <span class="ac-item-name">{item.name}</span>
                {item.description !== '' ? <span class="ac-item-desc">{item.description}</span> : null}
                {item.recurring !== null && item.recurring.trial_days > 0 ? (
                  <span class="ac-ok">{fill(strings.trial, { n: item.recurring.trial_days })}</span>
                ) : null}
                {item.recurring !== null && item.recurring.setup_fee_minor > 0 ? (
                  <span class="ac-muted">
                    {strings.setupFee}: {money(item.recurring.setup_fee_minor)}
                  </span>
                ) : null}
              </div>
              {config.settings.allow_quantity && on ? (
                <input
                  class="ac-qty"
                  type="number"
                  min={1}
                  max={999}
                  aria-label={strings.quantity}
                  value={selection.quantities[item.id] ?? item.quantity}
                  onClick={(e) => e.stopPropagation()}
                  onInput={(e) => {
                    const n = Math.max(1, Math.min(999, Math.round(Number((e.target as HTMLInputElement).value) || 1)));
                    setSelection((prev) => ({ ...prev, quantities: { ...prev.quantities, [item.id]: n } }));
                  }}
                />
              ) : null}
              <span class="ac-price">{price(item)}</span>
            </>
          );
          return pickOne ? (
            <label key={item.id} class={`ac-item${on ? ' ac-item-on' : ''}`}>
              {body}
            </label>
          ) : (
            <div key={item.id} class="ac-item">
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function BumpBox({
  bump,
  money,
  strings,
  checked,
  onToggle,
}: {
  bump: PublicBump;
  money: (minor: number) => string;
  strings: CheckoutStrings;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const box = (
    <input type="checkbox" checked={checked} onChange={(e) => onToggle((e.target as HTMLInputElement).checked)} />
  );
  const price = (
    <span class="ac-price">
      {bump.regular_price_minor !== null ? <span class="ac-strike">{money(bump.regular_price_minor * bump.quantity)}</span> : null}
      {money(bump.unit_price_minor * bump.quantity)}
    </span>
  );
  const body = (
    <div class="ac-bump-body">
      {bump.image_url !== '' ? <img class="ac-thumb" src={bump.image_url} alt="" loading="lazy" /> : null}
      <div class="ac-item-body">
        {bump.skin === 'ribbon' ? null : <span class="ac-bump-title">{bump.title || strings.bumpAdd}</span>}
        {bump.description !== '' ? <span class="ac-item-desc">{bump.description}</span> : null}
      </div>
      {price}
    </div>
  );
  const style = bump.color !== '' ? `--ac-bump:${bump.color}` : undefined;
  if (bump.skin === 'ribbon') {
    return (
      <label class="ac-bump ac-bump-ribbon" style={style}>
        <span class="ac-ribbon">
          {box}
          {bump.title || strings.bumpAdd}
        </span>
        {body}
      </label>
    );
  }
  return (
    <label class={`ac-bump ac-bump-${bump.skin}`} style={style}>
      {box}
      {body}
    </label>
  );
}

function AddressLine({
  api,
  config,
  locale,
  preview,
  label,
  value,
  country,
  error,
  onInput,
  onPick,
}: {
  api: CheckoutApi;
  config: PublicCheckoutConfig;
  locale: CheckoutLocale;
  preview: boolean;
  label: string;
  value: string;
  country: string;
  error: string | undefined;
  onInput: (value: string) => void;
  onPick: (s: AddressSuggestion) => void;
}) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const typed = useRef(false);
  const enabled = config.contact.address_autocomplete && !preview;

  useEffect(() => {
    if (!enabled || !typed.current || value.trim().length < 4) {
      setSuggestions([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void api.address(config.id, value.trim(), country, locale).then((result) => {
        if (result.ok) {
          setSuggestions(result.value.data.slice(0, 5));
          setOpen(true);
        }
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [value, country]);

  const list = useMemo(() => (open ? suggestions : []), [open, suggestions]);
  return (
    <div class={`af-field ac-suggest${error !== undefined ? ' af-invalid' : ''}`} data-af-invalid={error === undefined ? undefined : ''}>
      <label class="af-label" for="ac-address_line1">
        {label}
      </label>
      <input
        id="ac-address_line1"
        class="af-input"
        autoComplete={enabled ? 'off' : 'address-line1'}
        value={value}
        onInput={(e) => {
          typed.current = true;
          onInput((e.target as HTMLInputElement).value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {list.length > 0 ? (
        <ul class="ac-suggest-list" role="listbox">
          {list.map((s, i) => (
            <li key={`${s.label}-${String(i)}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  typed.current = false;
                  setOpen(false);
                  onPick(s);
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error !== undefined ? <div class="af-error">{error}</div> : null}
    </div>
  );
}

function Summary({
  quote,
  strings,
  money,
  promoEnabled,
  promoInput,
  setPromoInput,
  applied,
  apply,
}: {
  quote: Quote;
  strings: CheckoutStrings;
  money: (minor: number) => string;
  promoEnabled: boolean;
  promoInput: string;
  setPromoInput: (value: string) => void;
  applied: string;
  apply: (code: string) => void;
}) {
  const r = quote.recurring;
  return (
    <aside class="ac-summary">
      <div class="ac-section-title">{strings.summaryTitle}</div>
      {quote.lines.map((line, i) => (
        <div class="ac-line" key={`${line.name}-${String(i)}`}>
          <span>
            {line.kind === 'setup_fee' ? `${strings.setupFee} · ${line.name}` : line.name}
            {line.quantity > 1 ? ` × ${String(line.quantity)}` : ''}
          </span>
          <span>{line.kind === 'trial' ? fill(strings.trial, { n: r?.trial_days ?? 0 }) : money(line.subtotal_minor)}</span>
        </div>
      ))}
      {quote.discount_minor > 0 ? (
        <div class="ac-line ac-ok">
          <span>{strings.discount}</span>
          <span>−{money(quote.discount_minor)}</span>
        </div>
      ) : null}
      {quote.tax_minor > 0 ? (
        <div class="ac-line">
          <span>{strings.tax}</span>
          <span>{money(quote.tax_minor)}</span>
        </div>
      ) : null}
      <div class="ac-line ac-total">
        <span>{r !== null ? strings.dueToday : strings.total}</span>
        <span>{money(quote.total_minor)}</span>
      </div>
      {r !== null ? (
        <div class="ac-muted">
          {fill(strings.then, {
            amount: money(r.discounted_amount_minor ?? r.amount_minor),
            every: everyLabel(strings, r.interval, r.interval_count),
          })}
          {r.discounted_amount_minor !== null && r.discounted_periods !== null ? (
            <div>{fill(strings.discountedRenewals, { amount: money(r.discounted_amount_minor), n: r.discounted_periods })}</div>
          ) : null}
          {r.discounted_amount_minor !== null && r.discounted_periods === null ? <div>{strings.discountedForever}</div> : null}
        </div>
      ) : null}
      {promoEnabled ? (
        applied !== '' && quote.promo?.applied === true ? (
          <div class="ac-line">
            <span class="ac-ok">{fill(strings.promoApplied, { code: quote.promo.code })}</span>
            <button
              type="button"
              class="ac-link"
              onClick={() => {
                setPromoInput('');
                apply('');
              }}
            >
              {strings.promoRemove}
            </button>
          </div>
        ) : (
          <>
            <div class="ac-promo">
              <input
                class="af-input"
                placeholder={strings.promoPlaceholder}
                value={promoInput}
                maxLength={64}
                onInput={(e) => setPromoInput((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    apply(promoInput);
                  }
                }}
              />
              <button type="button" class="ac-small-button" onClick={() => apply(promoInput)}>
                {strings.promoApply}
              </button>
            </div>
            {quote.promo !== null && !quote.promo.applied && quote.promo.message !== null ? (
              <div class="ac-warn">{quote.promo.message}</div>
            ) : null}
          </>
        )
      ) : null}
    </aside>
  );
}
