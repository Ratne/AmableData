import { nextIndex, type PublicQuiz, type PublicStep, type QuizDefinition } from './quiz';

/**
 * The quiz page (`/q/<public id>`, also inside the embed iframe). Every answer
 * is sent as soon as it is given, in order; the server keeps the score and
 * decides the result. An opt-in step mounts the workspace form and hands its
 * submission id to the server, which matches it with `form.submitted`.
 */

interface Boot {
  readonly quiz: PublicQuiz;
  readonly base_url: string;
  readonly embed: boolean;
}

interface FinishAnswer {
  readonly score: number;
  readonly max_score: number;
  readonly label: string | null;
  readonly message: string;
  readonly redirect_url: string | null;
}

const TEXT = {
  it: {
    preview: 'Anteprima: le risposte non arrivano al CRM.',
    error: 'Qualcosa è andato storto. Riprova.',
    retry: 'Riprova',
    required: 'Rispondi per continuare.',
    loading: 'Un momento…',
    result: 'Il tuo risultato',
    formMissing: 'Il modulo non è disponibile.',
  },
  en: {
    preview: 'Preview: answers do not reach the CRM.',
    error: 'Something went wrong. Please try again.',
    retry: 'Try again',
    required: 'Answer to continue.',
    loading: 'One moment…',
    result: 'Your result',
    formMissing: 'The form is not available.',
  },
} as const;

const boot = JSON.parse(document.getElementById('quizly-data')?.textContent ?? '{}') as Boot;
const quiz = boot.quiz;
const t = TEXT[quiz.settings.locale];
const labels = quiz.settings.labels;
const root = document.getElementById('quizly')!;
const api = `${boot.base_url}/q/${quiz.public_id}`;
const storageKey = `quizly:${quiz.public_id}${quiz.preview ? ':preview' : ''}`;
/** Only what navigation needs: the server has the rest. */
const shape = { steps: quiz.steps } as unknown as QuizDefinition;

type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | boolean | ((event: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, ''), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false) el.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== false && child !== undefined) el.append(child);
  return el;
}

const store = {
  get(): string | null {
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  },
  set(value: string | null): void {
    try {
      if (value === null) sessionStorage.removeItem(storageKey);
      else sessionStorage.setItem(storageKey, value);
    } catch {
      // storage blocked (third-party iframe): the session lives as long as the page
    }
  },
};

async function post<T>(action: string, body: Record<string, unknown>): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${api}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
      });
      const data = (await response.json().catch(() => ({}))) as T & { error?: string };
      if (response.ok) return data;
      lastError = new Error(data.error ?? `HTTP ${String(response.status)}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error('request failed');
}

/* ---------- state ---------- */

let session: string | null = null;
let known = false;
let starting: Promise<void> | null = null;
/** Answers are sent one after the other, so the server sees them in order. */
let queue: Promise<void> = Promise.resolve();
let failed = false;
let goingBack = false;
const history: number[] = [];
const picked = new Map<string, string>();
const typed = new Map<string, string>();

function startSession(): Promise<void> {
  starting ??= (async () => {
    const params = new URLSearchParams(location.search);
    const data = await post<{ session: string; known: boolean }>('session', {
      c: params.get('c') ?? undefined,
      email: params.get('email') ?? undefined,
      preview: quiz.preview,
      resume: store.get() ?? undefined,
    });
    session = data.session;
    known = data.known;
    store.set(session);
  })();
  return starting;
}

function send(body: Record<string, unknown>): void {
  queue = queue
    .then(() => startSession())
    .then(() => post('answer', { session, ...body }))
    .then(
      () => undefined,
      () => {
        failed = true;
      },
    );
}

/* ---------- screens ---------- */

function frame(...children: Child[]): void {
  const card = h('div', { class: 'qz-card qz-fade' }, ...children);
  if (quiz.preview) root.replaceChildren(h('p', { class: 'qz-preview' }, t.preview), card);
  else root.replaceChildren(card);
  const focusable = card.querySelector<HTMLElement>('[autofocus]');
  focusable?.focus({ preventScroll: true });
  if (boot.embed) window.scrollTo(0, 0);
  else card.scrollIntoView({ block: 'nearest' });
}

function progress(index: number): Child {
  if (!quiz.settings.show_progress) return null;
  const bar = h('span');
  bar.style.width = `${String(Math.round((index / quiz.steps.length) * 100))}%`;
  return h('div', { class: 'qz-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round((index / quiz.steps.length) * 100)) }, bar);
}

function head(step: PublicStep): Child[] {
  return [
    h('h1', { class: 'qz-title' }, step.text),
    step.description === '' ? null : h('p', { class: 'qz-desc' }, step.description),
    step.image === null ? null : h('img', { class: 'qz-image', src: step.image, alt: '' }),
  ];
}

function backButton(): Child {
  if (!quiz.settings.allow_back || history.length === 0) return null;
  return h('button', { type: 'button', class: 'qz-link', onclick: () => back() }, `← ${labels.back}`);
}

function intro(): void {
  frame(
    h('h1', { class: 'qz-title' }, quiz.settings.intro_title || quiz.name),
    quiz.settings.intro_text === '' ? null : h('p', { class: 'qz-desc' }, quiz.settings.intro_text),
    h('div', { class: 'qz-actions' }, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'qz-button', autofocus: true, onclick: () => show(0) }, labels.start)),
  );
}

function go(from: number, next: string | null): void {
  goingBack = false;
  history.push(from);
  const to = nextIndex(shape, from, next);
  if (to === null) void finish();
  else show(to);
}

function back(): void {
  const previous = history.pop();
  if (previous === undefined) return;
  goingBack = true;
  show(previous);
}

function show(index: number): void {
  void startSession().catch(() => undefined);
  const step = quiz.steps[index]!;
  if (step.kind === 'optin') {
    void optinStep(index, step);
    return;
  }
  if (step.kind === 'choice') {
    const withImages = step.answers.some((a) => a.image !== null);
    const buttons = step.answers.map((a) =>
      h(
        'button',
        {
          type: 'button',
          class: `qz-answer${picked.get(step.id) === a.id ? ' selected' : ''}`,
          onclick: () => {
            picked.set(step.id, a.id);
            send({ step_id: step.id, answer_id: a.id });
            go(index, a.next);
          },
        },
        a.image === null ? null : h('img', { src: a.image, alt: '' }),
        h('span', {}, a.text),
      ),
    );
    frame(progress(index), ...head(step), h('div', { class: `qz-answers${withImages ? ' images' : ''}` }, ...buttons), h('div', { class: 'qz-actions' }, backButton()));
    return;
  }
  const field = step.multiline
    ? h('textarea', { class: 'qz-input', placeholder: step.placeholder, maxlength: '5000', autofocus: true })
    : h('input', { class: 'qz-input', type: 'text', placeholder: step.placeholder, maxlength: '5000', autofocus: true });
  field.value = typed.get(step.id) ?? '';
  const error = h('p', { class: 'qz-error', hidden: true }, t.required);
  const submit = () => {
    const value = field.value.trim();
    if (value === '' && step.required) {
      error.hidden = false;
      return;
    }
    typed.set(step.id, value);
    if (value !== '' || step.required) send({ step_id: step.id, text: value });
    go(index, step.next);
  };
  if (field instanceof HTMLInputElement) field.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && submit());
  frame(
    progress(index),
    ...head(step),
    field,
    error,
    h('div', { class: 'qz-actions' }, backButton(), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'qz-button', onclick: submit }, labels.next)),
  );
}

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  let loading = scripts.get(src);
  if (loading === undefined) {
    loading = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('form script'));
      document.head.append(el);
    });
    scripts.set(src, loading);
  }
  return loading;
}

async function optinStep(index: number, step: Extract<PublicStep, { kind: 'optin' }>): Promise<void> {
  await startSession().catch(() => undefined);
  if (known) {
    // The contact is already known (link with `c`, or an earlier opt-in): no need to ask again.
    if (goingBack && history.length > 0) back();
    else go(index, step.next);
    return;
  }
  const host = h('div', { 'data-amable-form': step.form_id, 'data-amable-tenant': step.tenant });
  const error = h('p', { class: 'qz-error', hidden: true }, t.error);
  host.addEventListener('amable-form:submitted', (event) => {
    event.preventDefault();
    const detail = (event as CustomEvent<{ submission_id?: string }>).detail;
    const submission = detail.submission_id ?? '';
    queue = queue
      .then(() => startSession())
      .then(() => (submission === '' ? undefined : post('optin', { session, submission_id: submission })))
      .then(
        () => {
          known = true;
        },
        () => undefined,
      );
    go(index, step.next);
  });
  frame(
    progress(index),
    ...head(step),
    host,
    error,
    h(
      'div',
      { class: 'qz-actions' },
      backButton(),
      h('span', { class: 'grow' }),
      step.skippable ? h('button', { type: 'button', class: 'qz-link', onclick: () => go(index, step.next) }, labels.skip) : null,
    ),
  );
  if (step.script_url === '') {
    error.textContent = t.formMissing;
    error.hidden = false;
    return;
  }
  loadScript(step.script_url).catch(() => {
    error.textContent = t.formMissing;
    error.hidden = false;
  });
}

/** Leaves the quiz for the result page: the embedding page does it, or the top window, or this frame. */
function leave(url: string): void {
  if (window.parent === window) {
    window.location.assign(url);
    return;
  }
  let handled = false;
  const onAck = (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (data?.type === 'quizly:redirect-ack') handled = true;
  };
  window.addEventListener('message', onAck);
  window.parent.postMessage({ type: 'quizly:redirect', id: quiz.public_id, url }, '*');
  setTimeout(() => {
    window.removeEventListener('message', onAck);
    if (handled) return;
    try {
      window.top!.location.href = url;
    } catch {
      window.location.assign(url);
    }
  }, 600);
}

async function finish(): Promise<void> {
  frame(progress(quiz.steps.length), h('p', { class: 'qz-desc' }, t.loading));
  try {
    await startSession();
    await queue;
    if (failed) {
      failed = false;
      throw new Error('an answer was not saved');
    }
    const result = await post<FinishAnswer>('finish', { session });
    store.set(null);
    if (result.redirect_url !== null && !quiz.preview) {
      leave(result.redirect_url);
      return;
    }
    frame(
      h(
        'div',
        { class: 'qz-result' },
        h('h1', { class: 'qz-title' }, result.label ?? t.result),
        result.message === '' ? null : h('p', { class: 'qz-desc' }, result.message),
        quiz.preview ? h('p', { class: 'qz-desc' }, `${String(result.score)} / ${String(result.max_score)}${result.redirect_url === null ? '' : ` → ${result.redirect_url}`}`) : null,
      ),
    );
  } catch {
    frame(
      h('p', { class: 'qz-desc' }, t.error),
      h('div', { class: 'qz-actions' }, backButton(), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'qz-button', onclick: () => void finish() }, t.retry)),
    );
  }
}

/* ---------- embed height ---------- */

if (boot.embed && window.parent !== window) {
  let last = 0;
  const report = () => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    window.parent.postMessage({ type: 'quizly:height', id: quiz.public_id, height }, '*');
  };
  new ResizeObserver(report).observe(document.documentElement);
  report();
}

if (quiz.settings.intro_enabled) intro();
else show(0);
