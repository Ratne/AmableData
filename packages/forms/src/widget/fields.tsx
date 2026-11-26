import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  countryForNumber,
  countryOptions,
  dialCodeOf,
  flagEmoji,
  isCountryCode,
  phoneCountryOptions,
} from '../countries';
import type { AddressSuggestion } from '../gateway';
import type { FormField, PublicFormConfig } from '../schema';
import type { WidgetStrings } from '../strings';

/** Form-wide facts some controls need (phone prefix default, address autocomplete). */
export interface FieldFormContext {
  config: PublicFormConfig;
  /** Origin serving the widget and its JSON endpoints. */
  apiBase: string;
  preview: boolean;
  values: Readonly<Record<string, unknown>>;
  /** Sets several values at once (an address suggestion fills its sibling fields). */
  patch: (next: Record<string, unknown>) => void;
}

interface FieldProps {
  field: FormField;
  value: unknown;
  error: string | undefined;
  strings: WidgetStrings;
  onChange: (value: unknown) => void;
  /** Absent in standalone uses of `FieldRow` (checkout custom fields). */
  form?: FieldFormContext;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const uiLocale = (): string => (typeof navigator === 'undefined' ? 'en' : navigator.language || 'en');

/** Region of the browser locale (`it-IT` → `IT`), when it is a known country. */
function localeRegion(): string | null {
  const match = /^[A-Za-z]{2,3}-([A-Za-z]{2})(?:\b|$)/.exec(uiLocale());
  const code = match?.[1]?.toUpperCase() ?? '';
  return isCountryCode(code) ? code : null;
}

function autoComplete(field: FormField): string {
  switch (field.map_to) {
    case 'email':
      return 'email';
    case 'given_name':
      return 'given-name';
    case 'family_name':
      return 'family-name';
    case 'phone':
      return 'tel';
    case 'company_name':
      return 'organization';
    case 'job_title':
      return 'organization-title';
    case 'website':
      return 'url';
    case 'address.line1':
      return 'address-line1';
    case 'address.line2':
      return 'address-line2';
    case 'address.locality':
      return 'address-level2';
    case 'address.region':
      return 'address-level1';
    case 'address.postal_code':
      return 'postal-code';
    case 'address.country_code':
      return 'country';
    default:
      return field.kind === 'email'
        ? 'email'
        : field.kind === 'phone'
          ? 'tel'
          : field.kind === 'country'
            ? 'country'
            : 'on';
  }
}

/**
 * Phone with a country-prefix selector (flag + calling code): the submitted
 * value is one string (`+39 333 1234567`). Default country: parsed from the
 * value, else the geolocated visitor country, else the browser locale region.
 */
function PhoneControl({ field, value, strings, onChange, form }: FieldProps) {
  const raw = text(value);
  const fallback = useMemo(() => {
    const visitor = form?.config.visitor_country ?? null;
    return visitor !== null && isCountryCode(visitor) ? visitor : localeRegion();
  }, [form?.config.visitor_country]);
  const [chosen, setChosen] = useState<string | null>(() => countryForNumber(raw) ?? fallback);
  const options = useMemo(() => phoneCountryOptions(uiLocale()), []);
  const parsed = countryForNumber(raw, chosen);
  const country = parsed ?? chosen;
  const dial = country === null ? null : dialCodeOf(country);
  const national =
    parsed !== null && dial !== null ? raw.replace(new RegExp(`^\\s*\\+${dial}\\s*`), '') : raw;

  const compose = (c: string | null, n: string): string => {
    const trimmed = n.trim();
    if (trimmed === '' || trimmed.startsWith('+')) return trimmed;
    const d = c === null ? null : dialCodeOf(c);
    return d === null ? trimmed : `+${d} ${trimmed}`;
  };

  return (
    <div class="af-phone">
      <span class="af-phone-prefix">
        <span aria-hidden="true">{country === null ? '🌐' : `${flagEmoji(country)} +${dial ?? ''}`}</span>
        <select
          aria-label={strings.phoneCountry}
          value={country ?? ''}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value || null;
            setChosen(next);
            onChange(compose(next, national));
          }}
        >
          <option value="">{strings.phoneNoPrefix}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {`${flagEmoji(o.code)} ${o.name} (+${o.dial})`}
            </option>
          ))}
        </select>
      </span>
      <input
        id={`af-${field.id}`}
        class="af-input"
        type="tel"
        name={field.key}
        placeholder={field.placeholder}
        autoComplete={autoComplete(field)}
        maxLength={field.max_length ?? 255}
        value={national}
        onInput={(e) => {
          const typed = (e.target as HTMLInputElement).value;
          if (typed.trimStart().startsWith('+')) {
            // A pasted or autofilled international number: adopt its prefix.
            const match = countryForNumber(typed, chosen);
            if (match !== null) setChosen(match);
            onChange(typed.trim());
          } else {
            onChange(compose(country, typed));
          }
        }}
      />
    </div>
  );
}

/** Dropdown of every country, named in the browser language; value is the ISO-2 code. */
function CountryControl({ field, value, strings, onChange }: FieldProps) {
  const options = useMemo(() => countryOptions(uiLocale()), []);
  const current = text(value).toUpperCase();
  return (
    <select
      id={`af-${field.id}`}
      class="af-select"
      name={field.key}
      autoComplete={autoComplete(field)}
      value={isCountryCode(current) ? current : ''}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
    >
      <option value="">{field.placeholder || strings.select}</option>
      {options.map((o) => (
        <option key={o.code} value={o.code}>
          {`${flagEmoji(o.code)} ${o.name}`}
        </option>
      ))}
    </select>
  );
}

/**
 * Street field with address autocomplete (the installation geocoder or address
 * app): picking a suggestion also fills the sibling fields mapped to the other
 * `address.*` attributes.
 */
function AddressTextControl({
  field,
  value,
  strings,
  onChange,
  form,
}: FieldProps & { form: FieldFormContext }) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [attribution, setAttribution] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const typed = useRef(false);
  const current = text(value);
  const target = (mapTo: string): FormField | undefined =>
    form.config.fields.find((f) => f.map_to === mapTo);
  const countrySibling = target('address.country_code');
  const siblingCode = countrySibling === undefined ? '' : text(form.values[countrySibling.key]).toUpperCase();
  const country = /^[A-Z]{2}$/.test(siblingCode) ? siblingCode : (form.config.visitor_country ?? '');

  useEffect(() => {
    if (!typed.current || current.trim().length < 4) {
      setSuggestions([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const url = `${form.apiBase}/f/${encodeURIComponent(form.config.tenant)}/${encodeURIComponent(form.config.id)}/address`;
      void fetch(url, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ q: current.trim(), country, lang: uiLocale().slice(0, 2) }),
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ data?: AddressSuggestion[]; attribution?: string | null }>)
            : null,
        )
        .then((body) => {
          if (body === null || !Array.isArray(body.data)) return;
          setSuggestions(body.data.slice(0, 5));
          setAttribution(body.attribution ?? null);
          setOpen(true);
        })
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [current, country]);

  const pick = (s: AddressSuggestion) => {
    typed.current = false;
    setOpen(false);
    const patch: Record<string, unknown> = {};
    const numberField = target('address.street_number');
    patch[field.key] =
      numberField === undefined && s.street_number !== null && s.street_number !== ''
        ? `${s.line1} ${s.street_number}`
        : s.line1;
    const parts = [
      ['address.street_number', s.street_number],
      ['address.locality', s.locality],
      ['address.region', s.region],
      ['address.postal_code', s.postal_code],
      ['address.country_code', s.country_code],
    ] as const;
    for (const [mapTo, part] of parts) {
      const sibling = target(mapTo);
      if (sibling !== undefined && part !== null && part !== '') patch[sibling.key] = part;
    }
    form.patch(patch);
  };

  const list = open ? suggestions : [];
  return (
    <div class="af-suggest">
      <input
        id={`af-${field.id}`}
        class="af-input"
        type="text"
        name={field.key}
        placeholder={field.placeholder}
        autoComplete="off"
        maxLength={field.max_length ?? 255}
        value={current}
        onInput={(e) => {
          typed.current = true;
          onChange((e.target as HTMLInputElement).value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {list.length > 0 ? (
        <ul class="af-suggest-list" role="listbox" aria-label={strings.addressSuggestions}>
          {list.map((s, i) => (
            <li key={`${s.label}-${String(i)}`}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                {s.label}
              </button>
            </li>
          ))}
          {attribution !== null ? <li class="af-suggest-attribution">{attribution}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function Control(props: FieldProps) {
  const { field, value, strings, onChange, form } = props;
  const id = `af-${field.id}`;
  switch (field.kind) {
    case 'textarea':
      return (
        <textarea
          id={id}
          class="af-textarea"
          name={field.key}
          placeholder={field.placeholder}
          maxLength={field.max_length ?? 5000}
          value={text(value)}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        />
      );
    case 'phone':
      return <PhoneControl {...props} />;
    case 'country':
      return <CountryControl {...props} />;
    case 'select':
      return (
        <select
          id={id}
          class="af-select"
          name={field.key}
          value={text(value)}
          onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        >
          <option value="">{field.placeholder || strings.select}</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'radio':
      return (
        <div class="af-choices" role="radiogroup">
          {field.options.map((o) => (
            <label key={o.value} class="af-choice">
              <input
                type="radio"
                name={field.key}
                value={o.value}
                checked={value === o.value}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    case 'multicheck': {
      const list = Array.isArray(value) ? value.map(String) : [];
      return (
        <div class="af-choices">
          {field.options.map((o) => (
            <label key={o.value} class="af-choice">
              <input
                type="checkbox"
                name={field.key}
                value={o.value}
                checked={list.includes(o.value)}
                onChange={(e) =>
                  onChange(
                    (e.target as HTMLInputElement).checked
                      ? [...list, o.value]
                      : list.filter((v) => v !== o.value),
                  )
                }
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case 'checkbox':
    case 'consent':
      return (
        <label class="af-choice">
          <input
            id={id}
            type="checkbox"
            name={field.key}
            checked={value === true}
            onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
          />
          <span>
            {field.label}
            {field.required ? <span class="af-req">{'\u00a0*'}</span> : null}
            {field.link_url !== '' ? (
              <>
                {' '}
                <a href={field.link_url} target="_blank" rel="noopener noreferrer">
                  {field.link_text || field.link_url}
                </a>
              </>
            ) : null}
          </span>
        </label>
      );
    case 'rating': {
      const current = typeof value === 'number' ? value : 0;
      return (
        <div class="af-rating" role="radiogroup">
          {Array.from({ length: field.max_rating }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              class={`af-star${n <= current ? ' af-star-on' : ''}`}
              aria-label={String(n)}
              aria-pressed={n === current}
              onClick={() => onChange(n === current ? null : n)}
            >
              ★
            </button>
          ))}
        </div>
      );
    }
    default: {
      if (
        field.map_to === 'address.line1' &&
        form !== undefined &&
        form.config.address_lookup &&
        !form.preview
      ) {
        return <AddressTextControl {...props} form={form} />;
      }
      // Preact 11 types <input> as a union discriminated by `type`, so each literal needs its own element.
      const shared = {
        id,
        class: 'af-input',
        name: field.key,
        placeholder: field.placeholder,
        autoComplete: autoComplete(field),
        value: text(value),
        onInput: (e: { target: EventTarget | null }) =>
          onChange((e.target as HTMLInputElement).value),
      };
      const maxLength = field.max_length ?? 255;
      switch (field.kind) {
        case 'number':
          return <input {...shared} type="number" min={field.min} max={field.max} />;
        case 'date':
          return <input {...shared} type="date" min={field.min} max={field.max} />;
        case 'email':
          return <input {...shared} type="email" maxLength={maxLength} />;
        default:
          return <input {...shared} type="text" maxLength={maxLength} />;
      }
    }
  }
}

/** One field row: label, description, control and inline error. */
export function FieldRow(props: FieldProps) {
  const { field, error } = props;
  if (field.kind === 'hidden' || field.kind === 'page_break') return null;
  if (field.kind === 'heading') {
    return (
      <div class="af-field">
        {field.label ? <div class="af-heading">{field.label}</div> : null}
        {field.description ? <div class="af-desc">{field.description}</div> : null}
      </div>
    );
  }
  if (field.kind === 'html') {
    return <div class="af-field af-html" dangerouslySetInnerHTML={{ __html: field.html }} />;
  }
  const inlineLabel = field.kind === 'checkbox' || field.kind === 'consent';
  const classes = ['af-field', `af-${field.kind}`];
  if (field.width === 'half') classes.push('af-half');
  if (error !== undefined) classes.push('af-invalid');
  return (
    <div class={classes.join(' ')} data-af-invalid={error === undefined ? undefined : ''}>
      {!inlineLabel && field.label ? (
        <label class="af-label" for={`af-${field.id}`}>
          {field.label}
          {field.required ? <span class="af-req">{'\u00a0*'}</span> : null}
        </label>
      ) : null}
      {field.description ? <div class="af-desc">{field.description}</div> : null}
      <Control {...props} />
      {error !== undefined ? (
        <div class="af-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
