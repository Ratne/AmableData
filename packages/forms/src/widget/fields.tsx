import type { FormField } from '../schema';
import type { WidgetStrings } from '../strings';

interface FieldProps {
  field: FormField;
  value: unknown;
  error: string | undefined;
  strings: WidgetStrings;
  onChange: (value: unknown) => void;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

function inputType(kind: FormField['kind']): string {
  switch (kind) {
    case 'email':
      return 'email';
    case 'phone':
      return 'tel';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    default:
      return 'text';
  }
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
      return field.kind === 'email' ? 'email' : field.kind === 'phone' ? 'tel' : 'on';
  }
}

function Control({ field, value, strings, onChange }: FieldProps) {
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
    default:
      return (
        <input
          id={id}
          class="af-input"
          type={inputType(field.kind)}
          name={field.key}
          placeholder={field.placeholder}
          autoComplete={autoComplete(field)}
          min={field.min}
          max={field.max}
          maxLength={field.kind === 'number' || field.kind === 'date' ? undefined : (field.max_length ?? 255)}
          value={text(value)}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        />
      );
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
