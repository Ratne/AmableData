/**
 * A quiz is an ordered list of steps: questions (multiple choice or open) and
 * opt-in steps that show one of the workspace's forms. Every choice gives
 * points, may apply CRM tags and may jump to a later step; at the end the
 * score picks a range (result), which can redirect to a page and apply a tag.
 *
 * Jumps only go forward, so every path ends and the highest possible score is
 * exact. Scores are always computed here, from the stored answers, never by
 * the browser. Pure module: the player bundles it too.
 */

export interface TagRef {
  /** CRM tag id, resolved (or created) when the quiz is saved. */
  readonly id: string | null;
  readonly name: string;
}

/** `null`: the next step in order; `'end'`: the result; otherwise the id of a later step. */
export type Next = string | null;
export const END = 'end';

export interface Choice {
  readonly id: string;
  readonly text: string;
  readonly image: string | null;
  readonly points: number;
  readonly tags: readonly TagRef[];
  readonly next: Next;
}

interface StepBase {
  readonly id: string;
  readonly text: string;
  readonly description: string;
  readonly image: string | null;
}

export interface ChoiceStep extends StepBase {
  readonly kind: 'choice';
  readonly answers: readonly Choice[];
}

export interface OpenStep extends StepBase {
  readonly kind: 'open';
  readonly placeholder: string;
  readonly required: boolean;
  readonly multiline: boolean;
  readonly next: Next;
}

export interface OptinStep extends StepBase {
  readonly kind: 'optin';
  readonly form_id: string;
  /** Filled when saved, from the form's embed facts in the CRM. */
  readonly form_name: string;
  readonly script_url: string;
  readonly tenant: string;
  readonly skippable: boolean;
  readonly next: Next;
}

export type Step = ChoiceStep | OpenStep | OptinStep;

export interface Range {
  readonly min: number;
  readonly max: number;
  readonly label: string;
  /** Shown on the result screen when there is no redirect. */
  readonly message: string;
  readonly redirect_url: string | null;
  readonly tag: TagRef | null;
}

export type Locale = 'it' | 'en';

export interface Labels {
  readonly start: string;
  readonly next: string;
  readonly back: string;
  readonly skip: string;
  readonly finish: string;
}

export interface QuizSettings {
  readonly locale: Locale;
  readonly intro_enabled: boolean;
  readonly intro_title: string;
  readonly intro_text: string;
  readonly show_progress: boolean;
  readonly allow_back: boolean;
  readonly labels: Labels;
  /** Used when no range matches the score. */
  readonly default_redirect_url: string | null;
  readonly default_message: string;
}

export interface QuizStyle {
  readonly accent: string;
  readonly background: string;
  readonly card: string;
  readonly text: string;
  readonly radius: number;
  readonly font: 'system' | 'serif' | 'rounded';
  readonly custom_css: string;
}

export interface QuizDefinition {
  readonly steps: readonly Step[];
  readonly ranges: readonly Range[];
  readonly settings: QuizSettings;
  readonly style: QuizStyle;
}

export const LIMITS = {
  steps: 60,
  answers: 12,
  tags: 10,
  ranges: 20,
  points: 1000,
  text: 500,
  description: 2000,
  open: 5000,
  css: 20_000,
} as const;

export const DEFAULT_LABELS: Readonly<Record<Locale, Labels>> = {
  it: { start: 'Inizia', next: 'Avanti', back: 'Indietro', skip: 'Salta', finish: 'Vedi il risultato' },
  en: { start: 'Start', next: 'Next', back: 'Back', skip: 'Skip', finish: 'See my result' },
};

export const DEFAULT_STYLE: QuizStyle = {
  accent: '#7c3aed',
  background: '#f5f3ff',
  card: '#ffffff',
  text: '#1f2937',
  radius: 14,
  font: 'system',
  custom_css: '',
};

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** `null` for empty, `undefined` for an invalid URL. */
export function httpUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2000 || !URL.canParse(value.trim())) return undefined;
  return /^https?:$/.test(new URL(value.trim()).protocol) ? value.trim() : undefined;
}

function points(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(-LIMITS.points, Math.min(LIMITS.points, Math.round(n)));
}

function tagsOf(value: unknown): TagRef[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const out: TagRef[] = [];
  for (const item of list) {
    const raw = typeof item === 'string' ? { name: item } : (item ?? {}) as { id?: unknown; name?: unknown };
    const name = str(raw.name, 100);
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : null, name });
    if (out.length === LIMITS.tags) break;
  }
  return out;
}

function tagOf(value: unknown): TagRef | null {
  return tagsOf(value === null || value === undefined ? [] : [value])[0] ?? null;
}

function nextOf(value: unknown): Next {
  if (value === END) return END;
  return typeof value === 'string' && ID.test(value) ? value : null;
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : fallback;
}

export function normalizeStyle(value: unknown): QuizStyle {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const radius = Number(raw['radius']);
  return {
    accent: color(raw['accent'], DEFAULT_STYLE.accent),
    background: color(raw['background'], DEFAULT_STYLE.background),
    card: color(raw['card'], DEFAULT_STYLE.card),
    text: color(raw['text'], DEFAULT_STYLE.text),
    radius: Number.isFinite(radius) ? Math.max(0, Math.min(32, Math.round(radius))) : DEFAULT_STYLE.radius,
    font: raw['font'] === 'serif' || raw['font'] === 'rounded' ? raw['font'] : 'system',
    custom_css: typeof raw['custom_css'] === 'string' ? raw['custom_css'].slice(0, LIMITS.css) : '',
  };
}

export function normalizeSettings(value: unknown): Parsed<QuizSettings> {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const locale: Locale = raw['locale'] === 'en' ? 'en' : 'it';
  const labelsRaw = (raw['labels'] ?? {}) as Record<string, unknown>;
  const defaults = DEFAULT_LABELS[locale];
  const label = (key: keyof Labels) => str(labelsRaw[key], 40) || defaults[key];
  const redirect = httpUrl(raw['default_redirect_url']);
  if (redirect === undefined) return { ok: false, error: 'the default redirect must be an http(s) URL' };
  return {
    ok: true,
    value: {
      locale,
      intro_enabled: raw['intro_enabled'] === true,
      intro_title: str(raw['intro_title'], LIMITS.text),
      intro_text: str(raw['intro_text'], LIMITS.description),
      show_progress: raw['show_progress'] !== false,
      allow_back: raw['allow_back'] !== false,
      labels: { start: label('start'), next: label('next'), back: label('back'), skip: label('skip'), finish: label('finish') },
      default_redirect_url: redirect,
      default_message: str(raw['default_message'], LIMITS.description),
    },
  };
}

function parseStep(raw: Record<string, unknown>, index: number): Parsed<Step> {
  const where = `step ${String(index + 1)}`;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  if (!ID.test(id)) return { ok: false, error: `${where}: invalid id` };
  const image = httpUrl(raw['image']);
  if (image === undefined) return { ok: false, error: `${where}: the image must be an http(s) URL` };
  const base = { id, text: str(raw['text'], LIMITS.text), description: str(raw['description'], LIMITS.description), image };
  const kind = raw['kind'];
  if (kind === 'choice') {
    if (base.text === '') return { ok: false, error: `${where}: write the question` };
    const list = Array.isArray(raw['answers']) ? raw['answers'] : [];
    if (list.length < 2) return { ok: false, error: `${where}: a choice needs at least two answers` };
    if (list.length > LIMITS.answers) return { ok: false, error: `${where}: at most ${String(LIMITS.answers)} answers` };
    const answers: Choice[] = [];
    for (const [i, item] of list.entries()) {
      const a = (item ?? {}) as Record<string, unknown>;
      const answerId = typeof a['id'] === 'string' ? a['id'] : '';
      if (!ID.test(answerId)) return { ok: false, error: `${where}, answer ${String(i + 1)}: invalid id` };
      const text = str(a['text'], LIMITS.text);
      if (text === '') return { ok: false, error: `${where}, answer ${String(i + 1)}: write the answer` };
      const answerImage = httpUrl(a['image']);
      if (answerImage === undefined) return { ok: false, error: `${where}, answer ${String(i + 1)}: the image must be an http(s) URL` };
      answers.push({ id: answerId, text, image: answerImage, points: points(a['points']), tags: tagsOf(a['tags']), next: nextOf(a['next']) });
    }
    if (new Set(answers.map((a) => a.id)).size !== answers.length) return { ok: false, error: `${where}: answer ids must be unique` };
    return { ok: true, value: { ...base, kind, answers } };
  }
  if (kind === 'open') {
    if (base.text === '') return { ok: false, error: `${where}: write the question` };
    return {
      ok: true,
      value: {
        ...base,
        kind,
        placeholder: str(raw['placeholder'], 200),
        required: raw['required'] === true,
        multiline: raw['multiline'] !== false,
        next: nextOf(raw['next']),
      },
    };
  }
  if (kind === 'optin') {
    const formId = typeof raw['form_id'] === 'string' ? raw['form_id'].trim() : '';
    if (!ID.test(formId)) return { ok: false, error: `${where}: choose the form of the opt-in` };
    const script = httpUrl(raw['script_url']);
    return {
      ok: true,
      value: {
        ...base,
        kind,
        form_id: formId,
        form_name: str(raw['form_name'], 200),
        script_url: script ?? '',
        tenant: str(raw['tenant'], 80),
        skippable: raw['skippable'] === true,
        next: nextOf(raw['next']),
      },
    };
  }
  return { ok: false, error: `${where}: unknown kind` };
}

/** Validates what the editor sends: unique ids, forward jumps only, ranges in order. */
export function parseDefinition(value: unknown): Parsed<QuizDefinition> {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const list = Array.isArray(raw['steps']) ? raw['steps'] : [];
  if (list.length === 0) return { ok: false, error: 'add at least one question' };
  if (list.length > LIMITS.steps) return { ok: false, error: `at most ${String(LIMITS.steps)} steps` };
  const steps: Step[] = [];
  for (const [i, item] of list.entries()) {
    const step = parseStep((item ?? {}) as Record<string, unknown>, i);
    if (!step.ok) return step;
    steps.push(step.value);
  }
  const index = new Map(steps.map((s, i) => [s.id, i]));
  if (index.size !== steps.length) return { ok: false, error: 'step ids must be unique' };
  if (!steps.some((s) => s.kind !== 'optin')) return { ok: false, error: 'add at least one question' };
  for (const [i, step] of steps.entries()) {
    const targets = step.kind === 'choice' ? step.answers.map((a) => a.next) : [step.next];
    for (const target of targets) {
      if (target === null || target === END) continue;
      const to = index.get(target);
      if (to === undefined) return { ok: false, error: `step ${String(i + 1)}: jumps to a step that does not exist` };
      if (to <= i) return { ok: false, error: `step ${String(i + 1)}: jumps can only go to a later step` };
    }
  }
  const rangeList = Array.isArray(raw['ranges']) ? raw['ranges'] : [];
  if (rangeList.length > LIMITS.ranges) return { ok: false, error: `at most ${String(LIMITS.ranges)} results` };
  const ranges: Range[] = [];
  for (const [i, item] of rangeList.entries()) {
    const r = (item ?? {}) as Record<string, unknown>;
    const min = points(r['min']);
    const max = points(r['max']);
    if (min > max) return { ok: false, error: `result ${String(i + 1)}: "from" is higher than "to"` };
    const redirect = httpUrl(r['redirect_url']);
    if (redirect === undefined) return { ok: false, error: `result ${String(i + 1)}: the page must be an http(s) URL` };
    ranges.push({ min, max, label: str(r['label'], 120), message: str(r['message'], LIMITS.description), redirect_url: redirect, tag: tagOf(r['tag']) });
  }
  const settings = normalizeSettings(raw['settings']);
  if (!settings.ok) return settings;
  return { ok: true, value: { steps, ranges, settings: settings.value, style: normalizeStyle(raw['style']) } };
}

/** Every tag the definition uses (answers and results), for the save-time resolution. */
export function definitionTags(definition: QuizDefinition): TagRef[] {
  const out: TagRef[] = [];
  for (const step of definition.steps) if (step.kind === 'choice') for (const a of step.answers) out.push(...a.tags);
  for (const range of definition.ranges) if (range.tag !== null) out.push(range.tag);
  return out;
}

/** The same definition with every tag carrying the id `resolve` found for its name. */
export function withTagIds(definition: QuizDefinition, ids: ReadonlyMap<string, string>): QuizDefinition {
  const fix = (tag: TagRef): TagRef => ({ id: ids.get(tag.name.toLowerCase()) ?? tag.id, name: tag.name });
  return {
    ...definition,
    steps: definition.steps.map((s) => (s.kind === 'choice' ? { ...s, answers: s.answers.map((a) => ({ ...a, tags: a.tags.map(fix) })) } : s)),
    ranges: definition.ranges.map((r) => ({ ...r, tag: r.tag === null ? null : fix(r.tag) })),
  };
}

export function formIds(definition: QuizDefinition): string[] {
  return [...new Set(definition.steps.flatMap((s) => (s.kind === 'optin' ? [s.form_id] : [])))];
}

/* ---------- paths and scores ---------- */

/** Where a step leads: `null` is the result. */
export function nextIndex(definition: QuizDefinition, from: number, next: Next): number | null {
  if (next === END) return null;
  if (next === null) return from + 1 < definition.steps.length ? from + 1 : null;
  const to = definition.steps.findIndex((s) => s.id === next);
  return to > from ? to : null;
}

export interface Given {
  readonly answerId: string | null;
  readonly text: string | null;
}

export interface Walk {
  /** Steps the respondent went through, in order. */
  readonly path: readonly Step[];
  /** Chosen answers on the path (their points and tags count). */
  readonly chosen: ReadonlyArray<{ readonly step: ChoiceStep; readonly answer: Choice }>;
  readonly score: number;
  /** The path reached the result. */
  readonly complete: boolean;
}

/**
 * Follows the quiz from the first step with the stored answers. Answers off the
 * path (given before going back and taking another branch) do not count.
 */
export function walk(definition: QuizDefinition, given: ReadonlyMap<string, Given>): Walk {
  const path: Step[] = [];
  const chosen: Array<{ step: ChoiceStep; answer: Choice }> = [];
  let score = 0;
  let at: number | null = 0;
  while (at !== null) {
    const step: Step = definition.steps[at]!;
    const answer = given.get(step.id);
    if (step.kind === 'choice') {
      const choice = step.answers.find((a) => a.id === answer?.answerId);
      if (choice === undefined) return { path, chosen, score, complete: false };
      path.push(step);
      chosen.push({ step, answer: choice });
      score += choice.points;
      at = nextIndex(definition, at, choice.next);
      continue;
    }
    if (step.kind === 'open' && step.required && (answer?.text ?? '').trim() === '') return { path, chosen, score, complete: false };
    path.push(step);
    at = nextIndex(definition, at, step.next);
  }
  return { path, chosen, score, complete: true };
}

/** The highest score any path can reach (jumps go forward, so this is exact). */
export function maxScore(definition: QuizDefinition): number {
  const best: number[] = new Array<number>(definition.steps.length).fill(0);
  const after = (from: number, next: Next) => {
    const to = nextIndex(definition, from, next);
    return to === null ? 0 : best[to]!;
  };
  for (let i = definition.steps.length - 1; i >= 0; i--) {
    const step = definition.steps[i]!;
    best[i] = step.kind === 'choice' ? Math.max(...step.answers.map((a) => a.points + after(i, a.next))) : after(i, step.next);
  }
  return best[0] ?? 0;
}

/** The first range containing the score, or null. */
export function pickRange(definition: QuizDefinition, score: number): { index: number; range: Range } | null {
  const index = definition.ranges.findIndex((r) => score >= r.min && score <= r.max);
  return index === -1 ? null : { index, range: definition.ranges[index]! };
}

/* ---------- what the browser gets ---------- */

export type PublicStep =
  | (Omit<ChoiceStep, 'answers'> & { readonly answers: ReadonlyArray<Pick<Choice, 'id' | 'text' | 'image' | 'next'>> })
  | OpenStep
  | Omit<OptinStep, 'form_name'>;

export interface PublicQuiz {
  readonly public_id: string;
  readonly name: string;
  readonly steps: readonly PublicStep[];
  readonly settings: Omit<QuizSettings, 'default_redirect_url' | 'default_message'>;
  readonly style: QuizStyle;
  readonly preview: boolean;
}

/** The definition without points, tags and results: those stay on the server. */
export function publicQuiz(publicId: string, name: string, definition: QuizDefinition, preview: boolean): PublicQuiz {
  const { default_redirect_url: _r, default_message: _m, ...settings } = definition.settings;
  void _r;
  void _m;
  return {
    public_id: publicId,
    name,
    preview,
    settings,
    style: definition.style,
    steps: definition.steps.map((step): PublicStep => {
      if (step.kind === 'choice') return { ...step, answers: step.answers.map((a) => ({ id: a.id, text: a.text, image: a.image, next: a.next })) };
      if (step.kind === 'optin') {
        const { form_name: _n, ...rest } = step;
        void _n;
        return rest;
      }
      return step;
    }),
  };
}

/** A starter quiz for the editor's "New quiz". */
export function starterDefinition(locale: Locale = 'it'): QuizDefinition {
  const it = locale === 'it';
  return {
    steps: [
      {
        id: 'q1',
        kind: 'choice',
        text: it ? 'Qual è il tuo obiettivo principale?' : 'What is your main goal?',
        description: '',
        image: null,
        answers: [
          { id: 'a1', text: it ? 'Trovare nuovi clienti' : 'Find new customers', image: null, points: 3, tags: [], next: null },
          { id: 'a2', text: it ? 'Fidelizzare quelli che ho' : 'Keep the ones I have', image: null, points: 2, tags: [], next: null },
          { id: 'a3', text: it ? 'Sto solo guardando' : 'Just looking', image: null, points: 0, tags: [], next: null },
        ],
      },
    ],
    ranges: [
      { min: 0, max: 1, label: it ? 'Curioso' : 'Curious', message: '', redirect_url: null, tag: null },
      { min: 2, max: LIMITS.points, label: it ? 'Pronto' : 'Ready', message: '', redirect_url: null, tag: null },
    ],
    settings: {
      locale,
      intro_enabled: false,
      intro_title: '',
      intro_text: '',
      show_progress: true,
      allow_back: true,
      labels: DEFAULT_LABELS[locale],
      default_redirect_url: null,
      default_message: '',
    },
    style: DEFAULT_STYLE,
  };
}
