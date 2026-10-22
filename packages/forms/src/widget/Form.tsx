import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PublicFormConfig, SubmitPayloadInput, SubmitResult } from '../schema';
import type { WidgetStrings } from '../strings';
import { splitSteps, validateSubmission, visibleFieldKeys, type FieldErrorCode } from '../validate';
import { collectMeta, collectTracking, initialValues } from './capture';
import { FieldRow } from './fields';
import { mountTurnstile, type TurnstileHandle } from './turnstile';

export interface FormProps {
  config: PublicFormConfig;
  strings: WidgetStrings;
  /** Origin serving the widget and the submit endpoint. */
  apiBase: string;
  /** Host element (attribution facts such as the landing page id). */
  host: Element;
  /** Builder preview: no network, submit only validates. */
  preview: boolean;
}

interface ErrorBody {
  error?: string;
  details?: Array<{ path?: string; message?: string }>;
}

function isFieldErrorCode(code: string, strings: WidgetStrings): code is FieldErrorCode {
  return Object.hasOwn(strings.fieldErrors, code);
}

export function Form({ config, strings, apiBase, host, preview }: FormProps) {
  const steps = useMemo(() => splitSteps(config.fields), [config.fields]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(config.fields));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState('');
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const mountedAt = useRef(Date.now());
  const hpRef = useRef<HTMLInputElement>(null);
  const turnstileBox = useRef<HTMLDivElement>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);
  const rootRef = useRef<HTMLFormElement>(null);

  const lastStep = stepIndex >= steps.length - 1;
  const visible = visibleFieldKeys(config.fields, values);
  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? { title: '', fields: [] };

  useEffect(() => {
    collectTracking();
  }, []);

  useEffect(() => {
    if (preview || !lastStep || config.turnstile_site_key === null || turnstileBox.current === null) {
      return undefined;
    }
    const handle = mountTurnstile(turnstileBox.current, config.turnstile_site_key);
    turnstile.current = handle;
    return () => {
      handle.remove();
      turnstile.current = null;
    };
  }, [preview, lastStep, config.turnstile_site_key]);

  const setValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const localizedErrors = (codes: Record<string, string>, keys?: Set<string>) => {
    const out: Record<string, string> = {};
    for (const [key, code] of Object.entries(codes)) {
      if (keys !== undefined && !keys.has(key)) continue;
      out[key] = isFieldErrorCode(code, strings) ? strings.fieldErrors[code] : strings.fieldErrors.invalid_value;
    }
    return out;
  };

  const focusFirstError = () => {
    window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>('[data-af-invalid] input, [data-af-invalid] textarea, [data-af-invalid] select, [data-af-invalid] button');
      el?.focus();
    }, 30);
  };

  /** Errors of the given fields only (the current step). */
  const check = (keys: Set<string>): boolean => {
    const result = validateSubmission(config, values);
    if (result.ok) return true;
    const stepErrors = localizedErrors(result.errors, keys);
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) {
      focusFirstError();
      return false;
    }
    return true;
  };

  const goNext = () => {
    setAlert('');
    if (!check(new Set(step.fields.map((f) => f.key)))) return;
    setStepIndex((i) => Math.min(i + 1, steps.length - 1));
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    if (submitting) return;
    if (!lastStep) {
      goNext();
      return;
    }
    setAlert('');
    const result = validateSubmission(config, values);
    if (!result.ok) {
      const all = localizedErrors(result.errors);
      setErrors(all);
      const firstStep = steps.findIndex((s) => s.fields.some((f) => f.key in all));
      if (firstStep >= 0 && firstStep !== stepIndex) setStepIndex(firstStep);
      setAlert(strings.fixErrors);
      focusFirstError();
      return;
    }
    if (preview) {
      setDone(config.settings.success_message || strings.success);
      return;
    }
    const payload: SubmitPayloadInput = {
      values: result.values,
      tracking: collectTracking(),
      meta: collectMeta(host),
      hp: hpRef.current?.value ?? '',
      elapsed_ms: Math.min(Date.now() - mountedAt.current, 86_400_000),
      turnstile_token: turnstile.current?.token() ?? '',
    };
    setSubmitting(true);
    try {
      const response = await fetch(
        `${apiBase}/f/${encodeURIComponent(config.tenant)}/${encodeURIComponent(config.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'omit',
        },
      );
      const body = (await response.json().catch(() => ({}))) as Partial<SubmitResult> & ErrorBody;
      if (!response.ok || body.ok !== true) {
        turnstile.current?.reset();
        if (body.error === 'validation_failed' && body.details !== undefined) {
          const codes: Record<string, string> = {};
          for (const detail of body.details) {
            if (detail.path !== undefined) codes[detail.path] = detail.message ?? 'invalid_value';
          }
          setErrors(localizedErrors(codes));
          setAlert(strings.fixErrors);
        } else if (body.error === 'turnstile_failed') {
          setAlert(strings.turnstileFailed);
        } else if (body.error === 'domain_not_allowed') {
          setAlert(strings.domainNotAllowed);
        } else if (response.status === 404) {
          setAlert(strings.notFound);
        } else {
          setAlert(strings.genericError);
        }
        return;
      }
      // The page embedding the form (e.g. a quiz) hears the submission and may take over the redirect.
      const proceed = host.dispatchEvent(
        new CustomEvent('amable-form:submitted', {
          bubbles: true,
          composed: true,
          cancelable: true,
          detail: { form_id: config.id, submission_id: body.submission_id ?? '' },
        }),
      );
      if (proceed && body.success_mode === 'redirect' && body.redirect_url) {
        window.location.assign(body.redirect_url);
        return;
      }
      setDone(body.success_message || config.settings.success_message || strings.success);
    } catch {
      setAlert(strings.networkError);
    } finally {
      setSubmitting(false);
    }
  };

  if (done !== null) {
    return (
      <div class="af-root">
        <div class="af-success" role="status">
          {done}
        </div>
      </div>
    );
  }

  return (
    <div class="af-root">
      <form ref={rootRef} class="af-form" onSubmit={(e) => void onSubmit(e)} noValidate>
        {preview ? <div class="af-notice">{strings.previewNotice}</div> : null}
        {steps.length > 1 ? (
          <div class="af-progress">
            {strings.step.replace('{n}', String(stepIndex + 1)).replace('{total}', String(steps.length))}
          </div>
        ) : null}
        {step.title ? <div class="af-step-title">{step.title}</div> : null}
        {step.fields.map((field) =>
          visible.has(field.key) ? (
            <FieldRow
              key={field.id}
              field={field}
              value={values[field.key]}
              error={errors[field.key]}
              strings={strings}
              onChange={(value) => setValue(field.key, value)}
            />
          ) : null,
        )}
        {lastStep && config.turnstile_site_key !== null && !preview ? (
          <div class="af-turnstile" ref={turnstileBox} />
        ) : null}
        <input
          ref={hpRef}
          class="af-hp"
          tabIndex={-1}
          autoComplete="off"
          name="company_website"
          aria-hidden="true"
        />
        {alert ? (
          <div class="af-alert" role="alert">
            {alert}
          </div>
        ) : null}
        <div class="af-actions">
          {stepIndex > 0 ? (
            <button
              type="button"
              class="af-button af-secondary"
              onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            >
              {config.settings.back_label || strings.back}
            </button>
          ) : null}
          <button type="submit" class="af-button" disabled={submitting}>
            {submitting
              ? strings.submitting
              : lastStep
                ? config.settings.submit_label || strings.submit
                : config.settings.next_label || strings.next}
          </button>
        </div>
      </form>
    </div>
  );
}
