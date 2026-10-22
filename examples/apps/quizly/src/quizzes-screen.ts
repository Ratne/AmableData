import { createAppBridge } from '@amable/app-bridge';
import { DEFAULT_STYLE, END, maxScore, starterDefinition, type QuizDefinition, type TagRef } from './quiz';

/** Quizly's page in the Marketing menu: quizzes, their questions and results, the code to paste, statistics and answers. */

const TEXT = {
  en: {
    title: 'Quizly',
    intro: 'Quiz funnels: questions with points, tags and their own paths; the score picks the result page.',
    add: 'New quiz',
    empty: 'No quizzes yet. Create one, then paste it in a landing page or share its link.',
    name: 'Name',
    status: 'Status',
    steps: 'Steps',
    started: 'Started',
    finished: 'Finished',
    contacts: 'Contacts',
    draft: 'Draft',
    published: 'Published',
    publish: 'Published (visible to everyone with the link)',
    back: '← Quizzes',
    save: 'Save',
    saved: 'Saved',
    duplicate: 'Duplicate',
    copySuffix: ' (copy)',
    remove: 'Delete',
    sure: 'Click again to confirm',
    failed: 'Something went wrong',
    tabQuestions: 'Questions',
    tabResults: 'Results',
    tabLook: 'Look',
    tabSettings: 'Settings',
    tabCode: 'Code to paste',
    tabPreview: 'Preview',
    tabStats: 'Statistics',
    tabResponses: 'Answers',
    addChoice: '+ Multiple choice',
    addOpen: '+ Open question',
    addOptin: '+ Opt-in form',
    kindChoice: 'Multiple choice',
    kindOpen: 'Open question',
    kindOptin: 'Opt-in form',
    question: 'Question',
    optinTitle: 'Title above the form',
    description: 'Description (optional)',
    image: 'Image URL (optional)',
    answer: 'Answer',
    points: 'Points',
    tags: 'Tags (comma separated, optional)',
    then: 'Then',
    addAnswer: '+ Answer',
    nextStep: 'Next step',
    endQuiz: 'Result',
    goTo: (n: number, text: string) => `Go to ${String(n)}. ${text}`,
    placeholder: 'Placeholder',
    required: 'Required',
    multiline: 'Long answer (several lines)',
    form: 'Form',
    chooseForm: 'Choose a form…',
    skippable: 'Can be skipped',
    optinHint: 'The form of the CRM, with its fields, connections and automations. Once sent, the quiz knows the contact: answers and tags reach it. Contacts arriving with ?c= or ?email= in the link skip this step.',
    moveUp: 'Move up',
    moveDown: 'Move down',
    delete: 'Delete',
    maxScore: (n: number) => `Highest possible score: ${String(n)}`,
    from: 'From',
    to: 'To',
    label: 'Result',
    message: 'Message (when there is no page)',
    page: 'Thank-you page (optional)',
    finalTag: 'Tag (optional)',
    addRange: '+ Result',
    rangesHint: 'The first result whose range contains the score wins. Its page opens at the end; its tag goes to the contact.',
    defaultPage: 'Page when no result matches (optional)',
    defaultMessage: 'Message when no result matches',
    colors: 'Colors',
    accent: 'Accent',
    background: 'Background',
    card: 'Card',
    text: 'Text',
    radius: 'Rounded corners',
    font: 'Font',
    fontSystem: 'System',
    fontSerif: 'Serif',
    fontRounded: 'Rounded',
    customCss: 'Custom CSS',
    customCssHint: 'Classes: .qz-card, .qz-title, .qz-desc, .qz-answer, .qz-button, .qz-progress, .qz-input.',
    language: 'Language of the quiz',
    introEnabled: 'Start with a welcome screen',
    introTitle: 'Welcome title',
    introText: 'Welcome text',
    showProgress: 'Progress bar',
    allowBack: 'Back button',
    buttons: 'Buttons',
    start: 'Start',
    next: 'Next',
    backLabel: 'Back',
    skip: 'Skip',
    saveFirst: 'Save the quiz to get its code, its preview and its statistics.',
    link: 'Link to the quiz (share it, or use it as a page)',
    emailLink: 'Link for emails (the CRM fills in the contact: answers and tags reach it without an opt-in)',
    embed: 'Embed in a landing page or a website (HTML block)',
    iframe: 'Plain iframe (when scripts are not allowed)',
    codeHint: '{{ contact.id }} is filled in by the CRM when the email is sent: keep it as it is. ?email=… works too, for contacts already in the CRM.',
    copy: 'Copy',
    copied: 'Copied',
    open: 'Open in a new tab',
    previewHint: 'Preview of the saved quiz: answers are not stored and do not reach the CRM. Save to see your changes.',
    draftHint: 'The quiz is a draft: only the preview works. Publish it to open it to everyone.',
    period: 'Period',
    days7: 'Last 7 days',
    days30: 'Last 30 days',
    days90: 'Last 90 days',
    all: 'All time',
    completion: 'Completion',
    average: 'Average score',
    reached: 'answered',
    answers: 'Answers',
    results: 'Results',
    noResult: '(no result)',
    noData: 'No answers yet.',
    when: 'When',
    contact: 'Contact',
    anonymous: 'Anonymous',
    score: 'Score',
    inProgress: 'In progress',
    finishedOnly: 'Finished only',
    more: 'More',
    formInactive: (name: string) => `The form "${name}" is not active: activate it in Forms, or the opt-in step will not work.`,
    formDomain: (name: string, host: string) => `The form "${name}" only accepts some domains: add ${host} to its allowed domains.`,
  },
  it: {
    title: 'Quizly',
    intro: 'Quiz funnel: domande con punti, tag e percorsi propri; il punteggio sceglie la pagina finale.',
    add: 'Nuovo quiz',
    empty: 'Ancora nessun quiz. Creane uno, poi incollalo in una landing page o condividi il suo link.',
    name: 'Nome',
    status: 'Stato',
    steps: 'Step',
    started: 'Iniziati',
    finished: 'Finiti',
    contacts: 'Contatti',
    draft: 'Bozza',
    published: 'Pubblicato',
    publish: 'Pubblicato (visibile a chiunque abbia il link)',
    back: '← Quiz',
    save: 'Salva',
    saved: 'Salvato',
    duplicate: 'Duplica',
    copySuffix: ' (copia)',
    remove: 'Elimina',
    sure: 'Clicca di nuovo per confermare',
    failed: 'Qualcosa è andato storto',
    tabQuestions: 'Domande',
    tabResults: 'Risultati',
    tabLook: 'Aspetto',
    tabSettings: 'Impostazioni',
    tabCode: 'Codice da incollare',
    tabPreview: 'Anteprima',
    tabStats: 'Statistiche',
    tabResponses: 'Risposte',
    addChoice: '+ Scelta multipla',
    addOpen: '+ Domanda aperta',
    addOptin: '+ Form di opt-in',
    kindChoice: 'Scelta multipla',
    kindOpen: 'Domanda aperta',
    kindOptin: 'Form di opt-in',
    question: 'Domanda',
    optinTitle: 'Titolo sopra il form',
    description: 'Descrizione (facoltativa)',
    image: 'URL immagine (facoltativa)',
    answer: 'Risposta',
    points: 'Punti',
    tags: 'Tag (separati da virgola, facoltativi)',
    then: 'Poi',
    addAnswer: '+ Risposta',
    nextStep: 'Step successivo',
    endQuiz: 'Risultato',
    goTo: (n: number, text: string) => `Vai a ${String(n)}. ${text}`,
    placeholder: 'Testo di esempio',
    required: 'Obbligatoria',
    multiline: 'Risposta lunga (più righe)',
    form: 'Form',
    chooseForm: 'Scegli un form…',
    skippable: 'Si può saltare',
    optinHint: 'Il form del CRM, con i suoi campi, connessioni e automazioni. Una volta inviato, il quiz conosce il contatto: risposte e tag arrivano su di lui. I contatti che arrivano con ?c= o ?email= nel link saltano questo step.',
    moveUp: 'Sposta su',
    moveDown: 'Sposta giù',
    delete: 'Elimina',
    maxScore: (n: number) => `Punteggio massimo possibile: ${String(n)}`,
    from: 'Da',
    to: 'A',
    label: 'Risultato',
    message: 'Messaggio (quando non c’è una pagina)',
    page: 'Pagina di ringraziamento (facoltativa)',
    finalTag: 'Tag (facoltativo)',
    addRange: '+ Risultato',
    rangesHint: 'Vince il primo risultato il cui intervallo contiene il punteggio. Alla fine si apre la sua pagina; il suo tag va al contatto.',
    defaultPage: 'Pagina quando nessun risultato corrisponde (facoltativa)',
    defaultMessage: 'Messaggio quando nessun risultato corrisponde',
    colors: 'Colori',
    accent: 'Accento',
    background: 'Sfondo',
    card: 'Scheda',
    text: 'Testo',
    radius: 'Angoli arrotondati',
    font: 'Carattere',
    fontSystem: 'Di sistema',
    fontSerif: 'Con grazie',
    fontRounded: 'Arrotondato',
    customCss: 'CSS personalizzato',
    customCssHint: 'Classi: .qz-card, .qz-title, .qz-desc, .qz-answer, .qz-button, .qz-progress, .qz-input.',
    language: 'Lingua del quiz',
    introEnabled: 'Inizia con una schermata di benvenuto',
    introTitle: 'Titolo di benvenuto',
    introText: 'Testo di benvenuto',
    showProgress: 'Barra di avanzamento',
    allowBack: 'Pulsante indietro',
    buttons: 'Pulsanti',
    start: 'Inizia',
    next: 'Avanti',
    backLabel: 'Indietro',
    skip: 'Salta',
    saveFirst: 'Salva il quiz per avere il codice, l’anteprima e le statistiche.',
    link: 'Link al quiz (condividilo, o usalo come pagina)',
    emailLink: 'Link per le email (il CRM inserisce il contatto: risposte e tag arrivano senza opt-in)',
    embed: 'Incorpora in una landing page o in un sito (blocco HTML)',
    iframe: 'Iframe semplice (quando gli script non sono permessi)',
    codeHint: '{{ contact.id }} viene compilato dal CRM quando l’email parte: lascialo così. Funziona anche ?email=…, per contatti già nel CRM.',
    copy: 'Copia',
    copied: 'Copiato',
    open: 'Apri in una nuova scheda',
    previewHint: 'Anteprima del quiz salvato: le risposte non vengono salvate e non arrivano al CRM. Salva per vedere le modifiche.',
    draftHint: 'Il quiz è una bozza: funziona solo l’anteprima. Pubblicalo per aprirlo a tutti.',
    period: 'Periodo',
    days7: 'Ultimi 7 giorni',
    days30: 'Ultimi 30 giorni',
    days90: 'Ultimi 90 giorni',
    all: 'Sempre',
    completion: 'Completamento',
    average: 'Punteggio medio',
    reached: 'risposte',
    answers: 'Risposte',
    results: 'Risultati',
    noResult: '(nessun risultato)',
    noData: 'Ancora nessuna risposta.',
    when: 'Quando',
    contact: 'Contatto',
    anonymous: 'Anonimo',
    score: 'Punteggio',
    inProgress: 'In corso',
    finishedOnly: 'Solo finiti',
    more: 'Altri',
    formInactive: (name: string) => `Il form "${name}" non è attivo: attivalo in Form, altrimenti lo step di opt-in non funziona.`,
    formDomain: (name: string, host: string) => `Il form "${name}" accetta solo alcuni domini: aggiungi ${host} ai suoi domini consentiti.`,
  },
};

type Text = (typeof TEXT)['en'];
type Tab = 'questions' | 'results' | 'look' | 'settings' | 'code' | 'preview' | 'stats' | 'responses';

interface QuizView {
  id: string;
  public_id: string;
  name: string;
  status: 'draft' | 'published';
  definition: QuizDefinition;
  max_score: number;
  steps: number;
  started: number;
  finished: number;
  contacts: number;
  snippets: Record<string, string>;
  warnings: string[];
}

/** The editor's working copy: plain JSON, mutated in place by the inputs. */
interface Draft {
  id: string | null;
  name: string;
  status: 'draft' | 'published';
  definition: Json;
  snippets: Record<string, string> | null;
  warnings: string[];
}

type Json = Record<string, any>;

interface Stats {
  started: number;
  finished: number;
  contacts: number;
  average_score: number | null;
  steps: Array<{ step_id: string; answered: number }>;
  answers: Array<{ step_id: string; answer_id: string; count: number }>;
  results: Array<{ label: string | null; count: number }>;
}

interface ResponseRow {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  started_at: number;
  finished_at: number | null;
  score: number | null;
  max_score: number | null;
  result: string | null;
  answers: Array<{ question: string; answer: string; points: number | null }>;
}

const bridge = createAppBridge();
bridge.autoResize();
let t: Text = TEXT.en;
let locale = 'en';
let quizzes: QuizView[] = [];
let forms: Array<{ id: string; name: string; status: string }> = [];
let tagNames: string[] = [];
let draft: Draft | null = null;
let tab: Tab = 'questions';
let stats: Stats | null = null;
let statsDays = 30;
let responses: ResponseRow[] = [];
let nextBefore: number | null = null;
let finishedOnly = false;
let armed: string | null = null;

const root = document.getElementById('app')!;

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function api<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${await bridge.sessionToken()}`, 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body['error'] === 'string' ? body['error'] : t.failed);
  return body as T;
}

const fail = (error: unknown) => bridge.toast(error instanceof Error ? error.message : t.failed, 'error');

const formatDate = (ms: number) => new Date(ms).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const uid = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 9)}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/* ---------- data ---------- */

async function loadQuizzes(): Promise<void> {
  quizzes = (await api<{ data: QuizView[] }>('api/quizzes')).data;
}

async function loadLookups(): Promise<void> {
  const [f, tg] = await Promise.all([
    api<{ data: typeof forms }>('api/forms').catch(() => ({ data: [] })),
    api<{ data: Array<{ name: string }> }>('api/tags').catch(() => ({ data: [] })),
  ]);
  forms = f.data;
  tagNames = tg.data.map((x) => x.name);
}

async function loadStats(): Promise<void> {
  if (draft?.id == null) return;
  stats = await api<Stats>(`api/stats?quiz=${encodeURIComponent(draft.id)}&days=${String(statsDays)}`);
}

async function loadResponses(more = false): Promise<void> {
  if (draft?.id == null) return;
  const params = new URLSearchParams({ quiz: draft.id, finished: String(finishedOnly) });
  if (more && nextBefore !== null) params.set('before', String(nextBefore));
  const page = await api<{ data: ResponseRow[]; next_before: number | null }>(`api/responses?${params.toString()}`);
  responses = more ? [...responses, ...page.data] : page.data;
  nextBefore = page.next_before;
}

function draftOf(view: QuizView): Draft {
  return { id: view.id, name: view.name, status: view.status, definition: clone(view.definition) as Json, snippets: view.snippets, warnings: view.warnings };
}

function newDraft(): Draft {
  const definition = clone(starterDefinition(locale.startsWith('it') ? 'it' : 'en')) as Json;
  return { id: null, name: '', status: 'draft', definition, snippets: null, warnings: [] };
}

async function save(): Promise<void> {
  if (draft === null) return;
  const name = draft.name.trim();
  const saved = await api<QuizView>('api/quizzes', { method: 'POST', body: { id: draft.id, name, status: draft.status, definition: draft.definition } });
  draft = draftOf(saved);
  await loadQuizzes();
  render();
  bridge.toast(t.saved, 'success');
  if (saved.warnings.length > 0) bridge.toast(warningText(saved.warnings[0]!), 'error');
}

function warningText(code: string): string {
  const [kind, name = '', host = ''] = code.split(':');
  return kind === 'form_domain' ? t.formDomain(name, host) : t.formInactive(name);
}

/* ---------- editing helpers ---------- */

function getPath(path: string): { parent: Json; key: string } {
  const parts = path.split('.');
  let node: Json = draft!.definition;
  for (const part of parts.slice(0, -1)) node = node[part] as Json;
  return { parent: node, key: parts[parts.length - 1]! };
}

/** Comma separated names → tags, keeping the ids of the names already resolved. */
function tagsFrom(text: string, previous: TagRef[]): TagRef[] {
  const known = new Map(previous.filter((p) => p.id !== null).map((p) => [p.name.toLowerCase(), p.id]));
  const seen = new Set<string>();
  const out: TagRef[] = [];
  for (const raw of text.split(',')) {
    const name = raw.trim();
    if (name === '' || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ id: known.get(name.toLowerCase()) ?? null, name });
  }
  return out;
}

function setFromInput(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const path = el.dataset['bind'];
  if (path === undefined || draft === null) return;
  if (path === 'name') {
    draft.name = el.value;
    return;
  }
  if (path === 'status') {
    draft.status = (el as HTMLInputElement).checked ? 'published' : 'draft';
    return;
  }
  const { parent, key } = getPath(path);
  switch (el.dataset['type']) {
    case 'number':
      parent[key] = el.value === '' ? 0 : Number(el.value);
      break;
    case 'bool':
      parent[key] = (el as HTMLInputElement).checked;
      break;
    case 'next':
      parent[key] = el.value === '' ? null : el.value;
      break;
    case 'tags':
      parent[key] = tagsFrom(el.value, (parent[key] ?? []) as TagRef[]);
      break;
    case 'tag':
      parent[key] = tagsFrom(el.value, parent[key] === null ? [] : [parent[key] as TagRef])[0] ?? null;
      break;
    case 'url':
      parent[key] = el.value.trim() === '' ? null : el.value.trim();
      break;
    default:
      parent[key] = el.value;
  }
}

const stepsOf = (): Json[] => draft!.definition['steps'] as Json[];

/** Jumps must go forward: after a move or a delete, those that no longer do go to the next step. */
function fixJumps(): void {
  const steps = stepsOf();
  const index = new Map(steps.map((s, i) => [s['id'] as string, i]));
  const fix = (from: number, next: unknown) => (next === null || next === END || (index.get(next as string) ?? -1) > from ? next : null);
  steps.forEach((step, i) => {
    if (step['kind'] === 'choice') for (const a of step['answers'] as Json[]) a['next'] = fix(i, a['next']);
    else step['next'] = fix(i, step['next']);
  });
}

function newStep(kind: 'choice' | 'open' | 'optin'): Json {
  const base = { id: uid('s'), kind, text: '', description: '', image: null };
  if (kind === 'choice') {
    return { ...base, answers: [1, 2].map(() => ({ id: uid('a'), text: '', image: null, points: 0, tags: [], next: null })) };
  }
  if (kind === 'open') return { ...base, placeholder: '', required: false, multiline: true, next: null };
  return { ...base, text: '', form_id: '', form_name: '', script_url: '', tenant: '', skippable: false, next: null };
}

function convertStep(step: Json, kind: 'choice' | 'open' | 'optin'): Json {
  const fresh = newStep(kind);
  return { ...fresh, id: step['id'], text: step['text'], description: step['description'], image: step['image'] };
}

/* ---------- rendering ---------- */

const option = (value: string, label: string, current: unknown) =>
  `<option value="${esc(value)}"${String(current ?? '') === value ? ' selected' : ''}>${esc(label)}</option>`;
const checked = (on: unknown) => (on === true ? ' checked' : '');

function nextSelect(path: string, from: number, current: unknown): string {
  const steps = stepsOf();
  const later = steps
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => i > from + 1)
    .map(({ s, i }) => option(s['id'] as string, t.goTo(i + 1, String(s['text'] || (s['kind'] === 'optin' ? t.kindOptin : '…')).slice(0, 40)), current));
  return `<select data-bind="${path}" data-type="next">${option('', from + 1 < steps.length ? t.nextStep : t.endQuiz, current)}${later.join('')}${from + 1 < steps.length ? option(END, t.endQuiz, current) : ''}</select>`;
}

function stepCard(step: Json, i: number, count: number): string {
  const p = `steps.${String(i)}`;
  const kind = step['kind'] as string;
  const head = `<div class="step-head">
    <span class="n">${String(i + 1)}.</span>
    <select data-step-kind="${String(i)}" style="width:auto">${option('choice', t.kindChoice, kind)}${option('open', t.kindOpen, kind)}${option('optin', t.kindOptin, kind)}</select>
    <span class="grow" style="flex:1"></span>
    <button type="button" class="icon" data-action="up" data-index="${String(i)}" title="${esc(t.moveUp)}"${i === 0 ? ' disabled' : ''}>↑</button>
    <button type="button" class="icon" data-action="down" data-index="${String(i)}" title="${esc(t.moveDown)}"${i === count - 1 ? ' disabled' : ''}>↓</button>
    <button type="button" class="icon" data-action="remove-step" data-index="${String(i)}" title="${esc(t.delete)}"${count === 1 ? ' disabled' : ''}>✕</button>
  </div>`;
  const common = `<label><span>${esc(kind === 'optin' ? t.optinTitle : t.question)}</span><input data-bind="${p}.text" maxlength="500" value="${esc(step['text'])}" /></label>
    <div class="grid">
      <label><span>${esc(t.description)}</span><textarea data-bind="${p}.description" maxlength="2000">${esc(step['description'])}</textarea></label>
      <label><span>${esc(t.image)}</span><input data-bind="${p}.image" data-type="url" type="url" value="${esc(step['image'] ?? '')}" placeholder="https://" /></label>
    </div>`;
  if (kind === 'choice') {
    const answers = (step['answers'] as Json[])
      .map((a, j) => {
        const ap = `${p}.answers.${String(j)}`;
        return `<div class="answer">
          <input data-bind="${ap}.text" maxlength="500" placeholder="${esc(t.answer)} ${String(j + 1)}" value="${esc(a['text'])}" />
          <input data-bind="${ap}.points" data-type="number" type="number" min="-1000" max="1000" step="1" value="${esc(a['points'])}" title="${esc(t.points)}" />
          <input data-bind="${ap}.tags" data-type="tags" list="quizly-tags" placeholder="${esc(t.tags)}" value="${esc((a['tags'] as TagRef[]).map((x) => x.name).join(', '))}" />
          ${nextSelect(`${ap}.next`, i, a['next'])}
          <button type="button" class="icon" data-action="remove-answer" data-index="${String(i)}" data-answer="${String(j)}" title="${esc(t.delete)}"${(step['answers'] as Json[]).length <= 2 ? ' disabled' : ''}>✕</button>
        </div>`;
      })
      .join('');
    return `<div class="card step">${head}${common}
      <div class="answers">
        <div class="answer answer-head"><span>${esc(t.answer)}</span><span>${esc(t.points)}</span><span>${esc(t.tags)}</span><span>${esc(t.then)}</span><span></span></div>
        ${answers}
      </div>
      <button type="button" class="ghost" data-action="add-answer" data-index="${String(i)}">${esc(t.addAnswer)}</button>
    </div>`;
  }
  if (kind === 'open') {
    return `<div class="card step">${head}${common}
      <div class="grid">
        <label><span>${esc(t.placeholder)}</span><input data-bind="${p}.placeholder" maxlength="200" value="${esc(step['placeholder'])}" /></label>
        <label><span>${esc(t.then)}</span>${nextSelect(`${p}.next`, i, step['next'])}</label>
      </div>
      <div class="bar">
        <label class="check"><input type="checkbox" data-bind="${p}.required" data-type="bool"${checked(step['required'])} /> ${esc(t.required)}</label>
        <label class="check"><input type="checkbox" data-bind="${p}.multiline" data-type="bool"${checked(step['multiline'])} /> ${esc(t.multiline)}</label>
      </div>
    </div>`;
  }
  const formOptions = forms.map((f) => option(f.id, f.status === 'active' ? f.name : `${f.name} (${f.status})`, step['form_id'])).join('');
  return `<div class="card step optin">${head}${common}
    <div class="grid">
      <label><span>${esc(t.form)}</span><select data-bind="${p}.form_id">${option('', t.chooseForm, step['form_id'])}${formOptions}</select></label>
      <label><span>${esc(t.then)}</span>${nextSelect(`${p}.next`, i, step['next'])}</label>
    </div>
    <label class="check"><input type="checkbox" data-bind="${p}.skippable" data-type="bool"${checked(step['skippable'])} /> ${esc(t.skippable)}</label>
    <p class="muted small">${esc(t.optinHint)}</p>
  </div>`;
}

function questionsTab(): string {
  const steps = stepsOf();
  return `${steps.map((s, i) => stepCard(s, i, steps.length)).join('')}
    <div class="bar">
      <button type="button" class="ghost" data-action="add-step" data-kind="choice">${esc(t.addChoice)}</button>
      <button type="button" class="ghost" data-action="add-step" data-kind="open">${esc(t.addOpen)}</button>
      <button type="button" class="ghost" data-action="add-step" data-kind="optin">${esc(t.addOptin)}</button>
    </div>
    <datalist id="quizly-tags">${tagNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`;
}

function safeMax(): number {
  try {
    return maxScore(draft!.definition as QuizDefinition);
  } catch {
    return 0;
  }
}

function resultsTab(): string {
  const ranges = draft!.definition['ranges'] as Json[];
  const s = draft!.definition['settings'] as Json;
  const rows = ranges
    .map((r, i) => {
      const p = `ranges.${String(i)}`;
      return `<div class="range">
        <input data-bind="${p}.min" data-type="number" type="number" value="${esc(r['min'])}" title="${esc(t.from)}" />
        <input data-bind="${p}.max" data-type="number" type="number" value="${esc(r['max'])}" title="${esc(t.to)}" />
        <input data-bind="${p}.label" maxlength="120" placeholder="${esc(t.label)}" value="${esc(r['label'])}" />
        <input data-bind="${p}.redirect_url" data-type="url" type="url" placeholder="${esc(t.page)}" value="${esc(r['redirect_url'] ?? '')}" />
        <input data-bind="${p}.tag" data-type="tag" list="quizly-tags" placeholder="${esc(t.finalTag)}" value="${esc((r['tag'] as TagRef | null)?.name ?? '')}" />
        <button type="button" class="icon" data-action="remove-range" data-index="${String(i)}" title="${esc(t.delete)}">✕</button>
      </div>
      <label style="margin-left:150px"><span class="muted small">${esc(t.message)}</span><input data-bind="${p}.message" maxlength="2000" value="${esc(r['message'])}" /></label>`;
    })
    .join('');
  return `<p class="muted">${esc(t.rangesHint)}</p>
    <p><b>${esc(t.maxScore(safeMax()))}</b></p>
    <div class="range answer-head"><span>${esc(t.from)}</span><span>${esc(t.to)}</span><span>${esc(t.label)}</span><span>${esc(t.page)}</span><span>${esc(t.finalTag)}</span><span></span></div>
    ${rows}
    <button type="button" class="ghost" data-action="add-range">${esc(t.addRange)}</button>
    <h2></h2>
    <div class="grid">
      <label><span>${esc(t.defaultPage)}</span><input data-bind="settings.default_redirect_url" data-type="url" type="url" value="${esc(s['default_redirect_url'] ?? '')}" placeholder="https://" /></label>
      <label><span>${esc(t.defaultMessage)}</span><input data-bind="settings.default_message" maxlength="2000" value="${esc(s['default_message'])}" /></label>
    </div>
    <datalist id="quizly-tags">${tagNames.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`;
}

function lookTab(): string {
  const st = { ...DEFAULT_STYLE, ...(draft!.definition['style'] as Json) };
  const color = (key: string, label: string) =>
    `<label><span>${esc(label)}</span><input type="color" data-bind="style.${key}" value="${esc(st[key as keyof typeof st])}" /></label>`;
  return `<h3>${esc(t.colors)}</h3>
    <div class="bar">${color('accent', t.accent)}${color('background', t.background)}${color('card', t.card)}${color('text', t.text)}</div>
    <div class="grid">
      <label><span>${esc(t.radius)}</span><input type="range" min="0" max="32" data-bind="style.radius" data-type="number" value="${esc(st.radius)}" /></label>
      <label><span>${esc(t.font)}</span><select data-bind="style.font">${option('system', t.fontSystem, st.font)}${option('serif', t.fontSerif, st.font)}${option('rounded', t.fontRounded, st.font)}</select></label>
    </div>
    <label><span>${esc(t.customCss)}</span><textarea class="code" data-bind="style.custom_css" maxlength="20000">${esc(st.custom_css)}</textarea></label>
    <p class="muted small">${esc(t.customCssHint)}</p>`;
}

function settingsTab(): string {
  const s = draft!.definition['settings'] as Json;
  const l = s['labels'] as Json;
  return `<div class="grid">
      <label><span>${esc(t.language)}</span><select data-bind="settings.locale">${option('it', 'Italiano', s['locale'])}${option('en', 'English', s['locale'])}</select></label>
    </div>
    <div class="bar">
      <label class="check"><input type="checkbox" data-bind="settings.show_progress" data-type="bool"${checked(s['show_progress'])} /> ${esc(t.showProgress)}</label>
      <label class="check"><input type="checkbox" data-bind="settings.allow_back" data-type="bool"${checked(s['allow_back'])} /> ${esc(t.allowBack)}</label>
      <label class="check"><input type="checkbox" data-bind="settings.intro_enabled" data-type="bool"${checked(s['intro_enabled'])} /> ${esc(t.introEnabled)}</label>
    </div>
    <div class="grid">
      <label><span>${esc(t.introTitle)}</span><input data-bind="settings.intro_title" maxlength="500" value="${esc(s['intro_title'])}" /></label>
      <label><span>${esc(t.introText)}</span><textarea data-bind="settings.intro_text" maxlength="2000">${esc(s['intro_text'])}</textarea></label>
    </div>
    <h3>${esc(t.buttons)}</h3>
    <div class="grid">
      <label><span>${esc(t.start)}</span><input data-bind="settings.labels.start" maxlength="40" value="${esc(l['start'])}" /></label>
      <label><span>${esc(t.next)}</span><input data-bind="settings.labels.next" maxlength="40" value="${esc(l['next'])}" /></label>
      <label><span>${esc(t.backLabel)}</span><input data-bind="settings.labels.back" maxlength="40" value="${esc(l['back'])}" /></label>
      <label><span>${esc(t.skip)}</span><input data-bind="settings.labels.skip" maxlength="40" value="${esc(l['skip'])}" /></label>
    </div>`;
}

function codeTab(): string {
  const sn = draft!.snippets;
  if (sn === null) return `<p class="muted">${esc(t.saveFirst)}</p>`;
  const block = (key: string, label: string) =>
    `<div class="snippet"><div class="bar"><span class="grow">${esc(label)}</span><button type="button" class="ghost" data-copy="${key}">${esc(t.copy)}</button></div><textarea class="code" readonly data-snippet="${key}">${esc(sn[key])}</textarea></div>`;
  return `${draft!.status === 'draft' ? `<p class="warn">${esc(t.draftHint)}</p>` : ''}
    ${block('embed', t.embed)}${block('link', t.link)}${block('email_link', t.emailLink)}${block('iframe', t.iframe)}
    <p class="muted small">${esc(t.codeHint)}</p>`;
}

function previewTab(): string {
  const sn = draft!.snippets;
  if (sn === null) return `<p class="muted">${esc(t.saveFirst)}</p>`;
  return `<div class="bar"><p class="muted grow">${esc(t.previewHint)}</p><a href="${esc(sn['preview'])}" target="_blank" rel="noopener"><button type="button" class="ghost">${esc(t.open)}</button></a></div>
    <iframe src="${esc(sn['preview'])}&embed=1&t=${String(Date.now())}" style="width:100%;height:640px;border:1px dashed var(--line);border-radius:12px;background:#fff" title="Preview"></iframe>`;
}

const percent = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));
const meter = (part: number, whole: number) => `<div class="meter"><span style="width:${String(percent(part, whole))}%"></span></div>`;

function statsTab(): string {
  if (draft!.id === null) return `<p class="muted">${esc(t.saveFirst)}</p>`;
  const period = `<label style="max-width:220px"><span>${esc(t.period)}</span><select id="stats-days">${option('7', t.days7, String(statsDays))}${option('30', t.days30, String(statsDays))}${option('90', t.days90, String(statsDays))}${option('0', t.all, String(statsDays))}</select></label>`;
  if (stats === null) return `${period}<p class="muted">…</p>`;
  if (stats.started === 0) return `${period}<p class="muted">${esc(t.noData)}</p>`;
  const kpi = (label: string, value: string) => `<div class="kpi"><span class="muted small">${esc(label)}</span><b>${esc(value)}</b></div>`;
  const answered = new Map(stats.steps.map((s) => [s.step_id, s.answered]));
  const byAnswer = new Map(stats.answers.map((a) => [`${a.step_id}:${a.answer_id}`, a.count]));
  const steps = stepsOf()
    .filter((s) => s['kind'] !== 'optin')
    .map((s) => {
      const total = answered.get(s['id'] as string) ?? 0;
      const answers =
        s['kind'] === 'choice'
          ? (s['answers'] as Json[])
              .map((a) => {
                const n = byAnswer.get(`${String(s['id'])}:${String(a['id'])}`) ?? 0;
                return `<tr><td>${esc(a['text'])}</td><td style="width:40%">${meter(n, total)}</td><td>${String(n)} (${String(percent(n, total))}%)</td></tr>`;
              })
              .join('')
          : '';
      return `<div class="card"><div class="bar"><b class="grow">${esc(s['text'])}</b><span class="muted">${String(total)} ${esc(t.reached)} · ${String(percent(total, stats!.started))}%</span></div>
        ${meter(total, stats!.started)}
        ${answers === '' ? '' : `<table>${answers}</table>`}</div>`;
    })
    .join('');
  const results = stats.results
    .map((r) => `<tr><td>${esc(r.label ?? t.noResult)}</td><td style="width:40%">${meter(r.count, stats!.finished)}</td><td>${String(r.count)}</td></tr>`)
    .join('');
  return `${period}
    <div class="kpis">
      ${kpi(t.started, String(stats.started))}${kpi(t.finished, String(stats.finished))}${kpi(t.completion, `${String(percent(stats.finished, stats.started))}%`)}
      ${kpi(t.contacts, String(stats.contacts))}${kpi(t.average, stats.average_score === null ? '–' : String(stats.average_score))}
    </div>
    <h2>${esc(t.answers)}</h2>${steps}
    ${results === '' ? '' : `<h2>${esc(t.results)}</h2><div class="card"><table>${results}</table></div>`}`;
}

function responsesTab(): string {
  if (draft!.id === null) return `<p class="muted">${esc(t.saveFirst)}</p>`;
  const filter = `<label class="check"><input type="checkbox" id="finished-only"${checked(finishedOnly)} /> ${esc(t.finishedOnly)}</label>`;
  if (responses.length === 0) return `${filter}<p class="muted">${esc(t.noData)}</p>`;
  const rows = responses
    .map(
      (r) => `<tr>
        <td>${esc(formatDate(r.started_at))}</td>
        <td>${r.contact_id === null ? `<span class="muted">${esc(t.anonymous)}</span>` : `<a href="#" data-contact="${esc(r.contact_id)}">${esc(r.contact_name ?? r.contact_id)}</a>`}</td>
        <td>${r.finished_at === null ? `<span class="pill off">${esc(t.inProgress)}</span>` : `${String(r.score)} / ${String(r.max_score)}`}</td>
        <td>${esc(r.result ?? '')}</td>
        <td class="small">${r.answers.map((a) => `<div><span class="muted">${esc(a.question)}</span> → ${esc(a.answer)}</div>`).join('')}</td>
      </tr>`,
    )
    .join('');
  return `${filter}
    <table><thead><tr><th>${esc(t.when)}</th><th>${esc(t.contact)}</th><th>${esc(t.score)}</th><th>${esc(t.label)}</th><th>${esc(t.answers)}</th></tr></thead><tbody>${rows}</tbody></table>
    ${nextBefore === null ? '' : `<p><button type="button" class="ghost" data-action="more">${esc(t.more)}</button></p>`}`;
}

function listView(): string {
  const rows = quizzes
    .map(
      (q) => `<tr class="click" data-open="${esc(q.id)}">
        <td><b>${esc(q.name)}</b></td>
        <td><span class="pill ${q.status === 'published' ? 'on' : 'off'}">${esc(q.status === 'published' ? t.published : t.draft)}</span></td>
        <td>${String(q.steps)}</td><td>${String(q.started)}</td><td>${String(q.finished)}</td><td>${String(q.contacts)}</td>
      </tr>`,
    )
    .join('');
  return `<div class="bar"><h1 class="grow">${esc(t.title)}</h1><button type="button" data-action="new">${esc(t.add)}</button></div>
    <p class="muted">${esc(t.intro)}</p>
    ${
      quizzes.length === 0
        ? `<div class="card"><p class="muted">${esc(t.empty)}</p></div>`
        : `<table><thead><tr><th>${esc(t.name)}</th><th>${esc(t.status)}</th><th>${esc(t.steps)}</th><th>${esc(t.started)}</th><th>${esc(t.finished)}</th><th>${esc(t.contacts)}</th></tr></thead><tbody>${rows}</tbody></table>`
    }`;
}

function editorView(): string {
  const d = draft!;
  const tabs: Array<[Tab, string]> = [
    ['questions', t.tabQuestions],
    ['results', t.tabResults],
    ['look', t.tabLook],
    ['settings', t.tabSettings],
    ['code', t.tabCode],
    ['preview', t.tabPreview],
    ['stats', t.tabStats],
    ['responses', t.tabResponses],
  ];
  const body =
    tab === 'questions' ? questionsTab()
    : tab === 'results' ? resultsTab()
    : tab === 'look' ? lookTab()
    : tab === 'settings' ? settingsTab()
    : tab === 'code' ? codeTab()
    : tab === 'preview' ? previewTab()
    : tab === 'stats' ? statsTab()
    : responsesTab();
  return `<div class="bar">
      <button type="button" class="ghost" data-action="back">${esc(t.back)}</button>
      <input class="grow" data-bind="name" maxlength="200" placeholder="${esc(t.name)}" value="${esc(d.name)}" style="flex:1;font-weight:600" />
      <label class="check" style="margin:0"><input type="checkbox" data-bind="status"${checked(d.status === 'published')} /> ${esc(t.publish)}</label>
      <button type="button" data-action="save">${esc(t.save)}</button>
    </div>
    ${d.warnings.map((w) => `<p class="warn">${esc(warningText(w))}</p>`).join('')}
    <div class="tabs">${tabs.map(([key, label]) => `<button type="button" data-tab="${key}" class="${tab === key ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>
    ${body}
    ${
      d.id === null
        ? ''
        : `<div class="bar" style="margin-top:18px"><span class="grow"></span>
            <button type="button" class="ghost" data-action="duplicate">${esc(t.duplicate)}</button>
            <button type="button" class="danger" data-action="delete">${esc(armed === 'delete' ? t.sure : t.remove)}</button></div>`
    }`;
}

function render(): void {
  root.innerHTML = draft === null ? listView() : editorView();
}

/* ---------- events ---------- */

root.addEventListener('input', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.dataset['bind'] !== undefined && el.type !== 'checkbox' && el.tagName !== 'SELECT') setFromInput(el);
});

root.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement | HTMLSelectElement;
  if (el.id === 'stats-days') {
    statsDays = Number(el.value);
    void loadStats().then(render, fail);
    return;
  }
  if (el.id === 'finished-only') {
    finishedOnly = (el as HTMLInputElement).checked;
    void loadResponses().then(render, fail);
    return;
  }
  const kindOf = el.dataset['stepKind'];
  if (kindOf !== undefined && draft !== null) {
    const steps = stepsOf();
    steps[Number(kindOf)] = convertStep(steps[Number(kindOf)]!, el.value as 'choice' | 'open' | 'optin');
    render();
    return;
  }
  if (el.dataset['bind'] === undefined) return;
  setFromInput(el);
});

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const el = target.closest<HTMLElement>('[data-action],[data-tab],[data-open],[data-copy],[data-contact]');
  if (el === null) return;
  const { action, index, answer, kind } = el.dataset;
  if (el.dataset['open'] !== undefined) {
    const view = quizzes.find((q) => q.id === el.dataset['open']);
    if (view !== undefined) {
      draft = draftOf(view);
      tab = 'questions';
      stats = null;
      responses = [];
      armed = null;
      render();
    }
    return;
  }
  if (el.dataset['tab'] !== undefined) {
    tab = el.dataset['tab'] as Tab;
    if (tab === 'stats') void loadStats().then(render, fail);
    if (tab === 'responses') void loadResponses().then(render, fail);
    render();
    return;
  }
  if (el.dataset['copy'] !== undefined) {
    const key = el.dataset['copy'];
    const text = draft?.snippets?.[key] ?? '';
    const done = () => bridge.toast(t.copied, 'success');
    navigator.clipboard?.writeText(text).then(done, () => {
      const area = document.querySelector<HTMLTextAreaElement>(`[data-snippet="${key}"]`);
      area?.select();
      document.execCommand('copy');
      done();
    });
    return;
  }
  if (el.dataset['contact'] !== undefined) {
    event.preventDefault();
    bridge.openContact(el.dataset['contact']);
    return;
  }
  if (draft === null && action !== 'new') return;
  const steps = draft === null ? [] : stepsOf();
  const i = Number(index);
  switch (action) {
    case 'new':
      draft = newDraft();
      tab = 'questions';
      armed = null;
      render();
      (document.querySelector('[data-bind="name"]') as HTMLInputElement | null)?.focus();
      break;
    case 'back':
      draft = null;
      armed = null;
      void loadQuizzes().then(render, fail);
      break;
    case 'save':
      void save().catch(fail);
      break;
    case 'duplicate':
      void api<QuizView>('api/quizzes/duplicate', { method: 'POST', body: { id: draft!.id, suffix: t.copySuffix } })
        .then(async (copy) => {
          await loadQuizzes();
          draft = draftOf(copy);
          tab = 'questions';
          render();
        })
        .catch(fail);
      break;
    case 'delete':
      if (armed !== 'delete') {
        armed = 'delete';
        render();
        return;
      }
      armed = null;
      void api(`api/quizzes?id=${encodeURIComponent(draft!.id!)}`, { method: 'DELETE' })
        .then(async () => {
          draft = null;
          await loadQuizzes();
          render();
        })
        .catch(fail);
      break;
    case 'add-step':
      steps.push(newStep((kind ?? 'choice') as 'choice' | 'open' | 'optin'));
      render();
      break;
    case 'remove-step': {
      const [removed] = steps.splice(i, 1);
      for (const s of steps) {
        if (s['kind'] === 'choice') for (const a of s['answers'] as Json[]) if (a['next'] === removed?.['id']) a['next'] = null;
        if (s['next'] === removed?.['id']) s['next'] = null;
      }
      fixJumps();
      render();
      break;
    }
    case 'up':
    case 'down': {
      const j = action === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j]!, steps[i]!];
      fixJumps();
      render();
      break;
    }
    case 'add-answer':
      (steps[i]!['answers'] as Json[]).push({ id: uid('a'), text: '', image: null, points: 0, tags: [], next: null });
      render();
      break;
    case 'remove-answer':
      (steps[i]!['answers'] as Json[]).splice(Number(answer), 1);
      render();
      break;
    case 'add-range': {
      const ranges = draft!.definition['ranges'] as Json[];
      const last = ranges[ranges.length - 1];
      const min = last === undefined ? 0 : Number(last['max']) + 1;
      ranges.push({ min, max: Math.max(min, safeMax()), label: '', message: '', redirect_url: null, tag: null });
      render();
      break;
    }
    case 'remove-range':
      (draft!.definition['ranges'] as Json[]).splice(i, 1);
      render();
      break;
    case 'more':
      void loadResponses(true).then(render, fail);
      break;
  }
});

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  locale = context.locale;
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  render();
});

Promise.all([loadQuizzes(), loadLookups()]).then(render).catch(fail);
