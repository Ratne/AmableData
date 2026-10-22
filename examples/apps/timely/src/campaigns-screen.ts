import { createAppBridge } from '@amable/app-bridge';
import { LABELS, normalizeStyle, PRESET_PALETTES, PRESETS, presetStyle, UNITS, type Preset, type TimerStyle, type Unit } from './style';
import { mountTimer, type MountedTimer } from './widget-view';

/** Timely's page in the Marketing menu: campaigns, their look, the code to paste, the deadlines of contacts. */

const TEXT = {
  en: {
    title: 'Timely',
    intro: 'Countdown timers that are true: each contact has one deadline per campaign, the same in emails, on pages and in automations.',
    add: 'New campaign',
    empty: 'No campaigns yet. Create one, then paste its timer in an email or a page.',
    name: 'Name',
    type: 'Type',
    running: 'Running',
    expiredCount: 'Expired',
    back: '← Campaigns',
    save: 'Save',
    saved: 'Saved',
    remove: 'Delete',
    sure: 'Click again to confirm',
    failed: 'Something went wrong',
    tabSetup: 'Deadline',
    tabDesign: 'Look',
    tabCode: 'Code to paste',
    tabContacts: 'Contacts',
    evergreen: 'Evergreen: every contact gets their own countdown',
    fixed: 'Fixed date: same deadline for everyone',
    duration: 'Duration',
    minutes: 'minutes',
    hours: 'hours',
    days: 'days',
    hardEnd: 'Never later than (optional)',
    fixedEnd: 'Deadline',
    startOn: 'The countdown starts when the contact…',
    email_open: 'opens an email with the timer',
    email_click: 'clicks a Timely link',
    page_visit: 'visits a page with the timer (anonymous visitors too)',
    startHint: 'The "Start Timely deadline" automation step starts it too.',
    openHint:
      'Apple Mail and Gmail can download images as soon as the email arrives, before the contact reads it: an email open may start the countdown early. For strict campaigns, start it on a click, a page visit or an automation step.',
    expiry: 'When the time is up, pages…',
    zeros: 'show zeros',
    message: 'show the expired message',
    hide: 'hide the timer',
    redirect: 'go to the expired page',
    offerUrl: 'Offer page (Timely links open it)',
    expiredUrl: 'Expired page (after the deadline)',
    preset: 'Preset',
    colors: 'Colors',
    background: 'Background',
    box: 'Boxes',
    digits: 'Digits',
    labels: 'Labels',
    boxes: 'Boxes around the digits',
    radius: 'Rounded corners',
    separators: 'Colons between units',
    showLabels: 'Unit labels',
    units: 'Units',
    size: 'Size',
    weight: 'Weight',
    sm: 'Small',
    md: 'Medium',
    lg: 'Large',
    thin: 'Thin',
    regular: 'Regular',
    bold: 'Bold',
    labelLocale: 'Language of the labels',
    labelText: 'Custom labels',
    expiredText: 'Expired message (empty: zeros)',
    customCss: 'Custom CSS (page widget)',
    customCssHint: 'Scope it with .timely-<id> or the classes .timely-unit, .timely-value, .timely-label, .timely-sep, .timely-expired.',
    preview: 'Preview',
    previewEmail: 'Email (animated GIF)',
    previewPage: 'Page',
    saveFirst: 'Save the campaign to get its code and its contacts.',
    codeEmail: 'Email',
    emailHtml: 'Timer with link (paste in an HTML block of the email)',
    emailImage: 'Image URL of the timer (image block)',
    emailLink: 'Link that starts the countdown and opens the offer',
    emailShared: 'Same timer for everyone (fixed date, no contact needed)',
    codePage: 'Pages and websites',
    pageInline: 'Inline timer (HTML block of the landing page, or any website)',
    pageBar: 'Bar at the top of the page',
    codeHint: '{{ contact.id }} is filled in by the CRM when the email is sent: keep it as it is.',
    copy: 'Copy',
    copied: 'Copied',
    search: 'Search contacts',
    onlyContacts: 'Only contacts (hide anonymous visitors)',
    contact: 'Contact',
    started: 'Started',
    deadline: 'Deadline',
    source: 'Started by',
    visitor: 'Anonymous visitor',
    none: 'No deadlines yet.',
    selected: (n: number) => `${String(n)} selected`,
    all: 'all',
    reset: 'Reset (start again at the next trigger)',
    restart: 'Restart now',
    extend: 'Extend by',
    setTo: 'Set deadline to',
    apply: 'Apply',
    changed: (n: number) => `${String(n)} deadlines changed`,
    startFor: 'Start the countdown for a contact',
    start: 'Start',
    more: 'More',
    expiredState: 'expired',
    sources: { email_open: 'email open', email_click: 'email click', page_visit: 'page visit', automation: 'automation', manual: 'manual' } as Record<string, string>,
  },
  it: {
    title: 'Timely',
    intro: 'Countdown veri: ogni contatto ha una sola scadenza per campagna, la stessa nelle email, nelle pagine e nelle automazioni.',
    add: 'Nuova campagna',
    empty: 'Nessuna campagna. Creane una, poi incolla il suo timer in un’email o in una pagina.',
    name: 'Nome',
    type: 'Tipo',
    running: 'In corso',
    expiredCount: 'Scadute',
    back: '← Campagne',
    save: 'Salva',
    saved: 'Salvato',
    remove: 'Elimina',
    sure: 'Clicca di nuovo per confermare',
    failed: 'Qualcosa è andato storto',
    tabSetup: 'Scadenza',
    tabDesign: 'Grafica',
    tabCode: 'Codice da incollare',
    tabContacts: 'Contatti',
    evergreen: 'Evergreen: ogni contatto ha il suo countdown',
    fixed: 'Data fissa: stessa scadenza per tutti',
    duration: 'Durata',
    minutes: 'minuti',
    hours: 'ore',
    days: 'giorni',
    hardEnd: 'Mai oltre il (facoltativo)',
    fixedEnd: 'Scadenza',
    startOn: 'Il countdown parte quando il contatto…',
    email_open: 'apre un’email con il timer',
    email_click: 'clicca un link Timely',
    page_visit: 'visita una pagina con il timer (anche visitatori anonimi)',
    startHint: 'Anche il passo di automazione "Avvia scadenza Timely" lo fa partire.',
    openHint:
      'Apple Mail e Gmail possono scaricare le immagini appena l’email arriva, prima che il contatto la legga: l’apertura può far partire il countdown in anticipo. Per campagne rigide, fallo partire da un clic, una visita o un passo di automazione.',
    expiry: 'Allo scadere, le pagine…',
    zeros: 'mostrano gli zeri',
    message: 'mostrano il messaggio di scadenza',
    hide: 'nascondono il timer',
    redirect: 'vanno alla pagina di offerta scaduta',
    offerUrl: 'Pagina dell’offerta (la aprono i link Timely)',
    expiredUrl: 'Pagina di offerta scaduta (dopo la scadenza)',
    preset: 'Preset',
    colors: 'Colori',
    background: 'Sfondo',
    box: 'Riquadri',
    digits: 'Cifre',
    labels: 'Etichette',
    boxes: 'Riquadri attorno alle cifre',
    radius: 'Angoli arrotondati',
    separators: 'Due punti tra le unità',
    showLabels: 'Etichette delle unità',
    units: 'Unità',
    size: 'Dimensione',
    weight: 'Spessore',
    sm: 'Piccolo',
    md: 'Medio',
    lg: 'Grande',
    thin: 'Sottile',
    regular: 'Normale',
    bold: 'Grassetto',
    labelLocale: 'Lingua delle etichette',
    labelText: 'Etichette personalizzate',
    expiredText: 'Messaggio di scadenza (vuoto: zeri)',
    customCss: 'CSS custom (widget delle pagine)',
    customCssHint: 'Usa .timely-<id> o le classi .timely-unit, .timely-value, .timely-label, .timely-sep, .timely-expired.',
    preview: 'Anteprima',
    previewEmail: 'Email (GIF animata)',
    previewPage: 'Pagina',
    saveFirst: 'Salva la campagna per avere il codice e i contatti.',
    codeEmail: 'Email',
    emailHtml: 'Timer con link (incollalo in un blocco HTML dell’email)',
    emailImage: 'URL immagine del timer (blocco immagine)',
    emailLink: 'Link che avvia il countdown e apre l’offerta',
    emailShared: 'Stesso timer per tutti (data fissa, senza contatto)',
    codePage: 'Pagine e siti web',
    pageInline: 'Timer nella pagina (blocco HTML della landing, o qualsiasi sito)',
    pageBar: 'Barra in cima alla pagina',
    codeHint: '{{ contact.id }} lo compila il CRM all’invio dell’email: lascialo così.',
    copy: 'Copia',
    copied: 'Copiato',
    search: 'Cerca contatti',
    onlyContacts: 'Solo contatti (nascondi visitatori anonimi)',
    contact: 'Contatto',
    started: 'Avviata',
    deadline: 'Scadenza',
    source: 'Avviata da',
    visitor: 'Visitatore anonimo',
    none: 'Ancora nessuna scadenza.',
    selected: (n: number) => `${String(n)} selezionate`,
    all: 'tutte',
    reset: 'Resetta (ripartirà al prossimo evento)',
    restart: 'Riavvia ora',
    extend: 'Estendi di',
    setTo: 'Imposta scadenza al',
    apply: 'Applica',
    changed: (n: number) => `${String(n)} scadenze modificate`,
    startFor: 'Avvia il countdown per un contatto',
    start: 'Avvia',
    more: 'Altri',
    expiredState: 'scaduta',
    sources: { email_open: 'apertura email', email_click: 'clic email', page_visit: 'visita pagina', automation: 'automazione', manual: 'manuale' } as Record<string, string>,
  },
};

type Text = typeof TEXT.en;
type Tab = 'setup' | 'design' | 'code' | 'contacts';

interface CampaignView {
  id: string;
  public_id: string;
  name: string;
  mode: 'evergreen' | 'fixed';
  duration_minutes: number | null;
  fixed_end_at: number | null;
  hard_end_at: number | null;
  start_on: string[];
  expiry: 'zeros' | 'message' | 'hide' | 'redirect';
  style: TimerStyle;
  offer_url: string | null;
  expired_url: string | null;
  running: number;
  expired: number;
  snippets: Record<string, string>;
}

interface Draft {
  id: string | null;
  public_id: string | null;
  name: string;
  mode: 'evergreen' | 'fixed';
  duration_value: number;
  duration_unit: 'minutes' | 'hours' | 'days';
  fixed_end_at: string;
  hard_end_at: string;
  start_on: string[];
  expiry: CampaignView['expiry'];
  style: TimerStyle;
  offer_url: string;
  expired_url: string;
  snippets: Record<string, string> | null;
}

interface DeadlineRow {
  id: string;
  contact_id: string | null;
  contact_name: string | null;
  started_at: number;
  deadline_at: number;
  source: string;
  expired: boolean;
}

const bridge = createAppBridge();
bridge.autoResize();
let t: Text = TEXT.en;
let locale = 'en';
let settings = { label_locale: 'it' as 'it' | 'en', preset: 'classic' as Preset, duration_hours: 72 };
let campaigns: CampaignView[] = [];
let draft: Draft | null = null;
let tab: Tab = 'setup';
let rows: DeadlineRow[] = [];
let nextBefore: string | null = null;
let selected = new Set<string>();
let query = '';
let onlyContacts = false;
let previewTimer: MountedTimer | null = null;
let previewDebounce: ReturnType<typeof setTimeout> | null = null;
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

/** `datetime-local` value of an instant, in the browser's time zone. */
function localInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
const fromLocalInput = (value: string) => (value === '' ? null : new Date(value).toISOString());
const formatDate = (ms: number) =>
  new Date(ms).toLocaleString(locale, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function durationParts(minutes: number | null): Pick<Draft, 'duration_value' | 'duration_unit'> {
  const m = minutes ?? settings.duration_hours * 60;
  if (m % 1440 === 0) return { duration_value: m / 1440, duration_unit: 'days' };
  if (m % 60 === 0) return { duration_value: m / 60, duration_unit: 'hours' };
  return { duration_value: m, duration_unit: 'minutes' };
}
const durationMinutes = (d: Draft) => Math.round(d.duration_value * { minutes: 1, hours: 60, days: 1440 }[d.duration_unit]);

function newDraft(): Draft {
  return {
    id: null,
    public_id: null,
    name: '',
    mode: 'evergreen',
    ...durationParts(null),
    fixed_end_at: localInput(Date.now() + 7 * 86_400_000),
    hard_end_at: '',
    start_on: ['email_open', 'email_click', 'page_visit'],
    expiry: 'zeros',
    style: presetStyle(settings.preset, settings.label_locale),
    offer_url: '',
    expired_url: '',
    snippets: null,
  };
}

function draftOf(c: CampaignView): Draft {
  return {
    id: c.id,
    public_id: c.public_id,
    name: c.name,
    mode: c.mode,
    ...durationParts(c.duration_minutes),
    fixed_end_at: localInput(c.fixed_end_at),
    hard_end_at: localInput(c.hard_end_at),
    start_on: [...c.start_on],
    expiry: c.expiry,
    style: normalizeStyle(c.style),
    offer_url: c.offer_url ?? '',
    expired_url: c.expired_url ?? '',
    snippets: c.snippets,
  };
}

function payload(d: Draft): Record<string, unknown> {
  return {
    ...(d.id === null ? {} : { id: d.id }),
    name: d.name,
    mode: d.mode,
    duration_minutes: d.mode === 'evergreen' ? durationMinutes(d) : null,
    fixed_end_at: d.mode === 'fixed' ? fromLocalInput(d.fixed_end_at) : null,
    hard_end_at: d.mode === 'evergreen' ? fromLocalInput(d.hard_end_at) : null,
    start_on: d.start_on,
    expiry: d.expiry,
    style: d.style,
    offer_url: d.offer_url.trim() === '' ? null : d.offer_url.trim(),
    expired_url: d.expired_url.trim() === '' ? null : d.expired_url.trim(),
  };
}

/* ---------- list ---------- */

function typeLabel(c: CampaignView): string {
  if (c.mode === 'fixed') return `${t.fixedEnd}: ${formatDate(c.fixed_end_at ?? 0)}`;
  const { duration_value, duration_unit } = durationParts(c.duration_minutes);
  return `Evergreen · ${String(duration_value)} ${t[duration_unit]}`;
}

function renderList(): void {
  stopPreview();
  root.innerHTML = `
    <div class="bar"><h1 class="grow">${esc(t.title)}</h1><button type="button" data-action="new">${esc(t.add)}</button></div>
    <p class="muted">${esc(t.intro)}</p>
    ${
      campaigns.length === 0
        ? `<div class="card"><p class="muted">${esc(t.empty)}</p></div>`
        : `<table><thead><tr><th>${esc(t.name)}</th><th>${esc(t.type)}</th><th>${esc(t.running)}</th><th>${esc(t.expiredCount)}</th></tr></thead><tbody>
          ${campaigns
            .map(
              (c) => `<tr class="click" data-open="${esc(c.id)}"><td><strong>${esc(c.name)}</strong></td><td class="muted">${esc(typeLabel(c))}</td>
                <td><span class="pill on">${String(c.running)}</span></td><td><span class="pill off">${String(c.expired)}</span></td></tr>`,
            )
            .join('')}
        </tbody></table>`
    }`;
}

/* ---------- editor ---------- */

const checked = (on: boolean) => (on ? ' checked' : '');
const option = (value: string, label: string, current: string) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;

function setupTab(d: Draft): string {
  return `
    <label class="check"><input type="radio" name="mode" value="evergreen"${checked(d.mode === 'evergreen')} /> ${esc(t.evergreen)}</label>
    <label class="check"><input type="radio" name="mode" value="fixed"${checked(d.mode === 'fixed')} /> ${esc(t.fixed)}</label>
    <div class="grid" style="margin-top:10px">
      ${
        d.mode === 'evergreen'
          ? `<label><span>${esc(t.duration)}</span><span class="bar"><input name="duration_value" type="number" min="1" value="${String(d.duration_value)}" style="width:90px" />
              <select name="duration_unit">${(['minutes', 'hours', 'days'] as const).map((u) => option(u, t[u], d.duration_unit)).join('')}</select></span></label>
            <label><span>${esc(t.hardEnd)}</span><input name="hard_end_at" type="datetime-local" value="${esc(d.hard_end_at)}" /></label>`
          : `<label><span>${esc(t.fixedEnd)}</span><input name="fixed_end_at" type="datetime-local" value="${esc(d.fixed_end_at)}" /></label>`
      }
    </div>
    <h3>${esc(t.startOn)}</h3>
    ${(['email_open', 'email_click', 'page_visit'] as const)
      .map((k) => `<label class="check"><input type="checkbox" name="start_on" value="${k}"${checked(d.start_on.includes(k))} /> ${esc(t[k])}</label>`)
      .join('')}
    <p class="muted">${esc(t.startHint)}</p>
    <p class="muted">${esc(t.openHint)}</p>
    <h3>${esc(t.expiry)}</h3>
    <label><select name="expiry">${(['zeros', 'message', 'hide', 'redirect'] as const).map((k) => option(k, t[k], d.expiry)).join('')}</select></label>
    <label><span>${esc(t.offerUrl)}</span><input name="offer_url" type="url" placeholder="https://" value="${esc(d.offer_url)}" /></label>
    <label><span>${esc(t.expiredUrl)}</span><input name="expired_url" type="url" placeholder="https://" value="${esc(d.expired_url)}" /></label>`;
}

function designTab(d: Draft): string {
  const s = d.style;
  const color = (key: 'background' | 'box' | 'digits' | 'labels') =>
    `<label><span>${esc(t[key])}</span><input type="color" name="style.${key}" value="${esc(s[key])}" /></label>`;
  return `
    <h3>${esc(t.preset)}</h3>
    <div class="swatches">
      ${PRESETS.map((p) => {
        const pal = PRESET_PALETTES[p];
        return `<button type="button" class="swatch${p === s.preset ? ' active' : ''}" data-preset="${p}">
          <span style="background:${pal.background};border:1px solid #0001;display:flex;align-items:center;justify-content:center"><i style="display:block;width:40px;height:12px;border-radius:3px;background:${pal.boxes ? pal.box : pal.digits}"></i></span>${esc(p)}</button>`;
      }).join('')}
    </div>
    <h3>${esc(t.colors)}</h3>
    <div class="bar">${color('background')}${color('box')}${color('digits')}${color('labels')}</div>
    <label class="check"><input type="checkbox" name="style.boxes"${checked(s.boxes)} /> ${esc(t.boxes)}</label>
    <label><span>${esc(t.radius)}</span><input type="range" name="style.radius" min="0" max="1" step="0.05" value="${String(s.radius)}" /></label>
    <label class="check"><input type="checkbox" name="style.separators"${checked(s.separators)} /> ${esc(t.separators)}</label>
    <label class="check"><input type="checkbox" name="style.show_labels"${checked(s.show_labels)} /> ${esc(t.showLabels)}</label>
    <h3>${esc(t.units)}</h3>
    <div class="bar">${UNITS.map((u) => `<label class="check"><input type="checkbox" name="style.units" value="${u}"${checked(s.units.includes(u))} /> ${esc(LABELS[s.label_locale][u])}</label>`).join('')}</div>
    <div class="grid">
      <label><span>${esc(t.size)}</span><select name="style.size">${(['sm', 'md', 'lg'] as const).map((k) => option(k, t[k], s.size)).join('')}</select></label>
      <label><span>${esc(t.weight)}</span><select name="style.weight">${(['thin', 'regular', 'bold'] as const).map((k) => option(k, t[k], s.weight)).join('')}</select></label>
      <label><span>${esc(t.labelLocale)}</span><select name="style.label_locale">${option('it', 'Italiano', s.label_locale)}${option('en', 'English', s.label_locale)}</select></label>
    </div>
    <h3>${esc(t.labelText)}</h3>
    <div class="grid">${UNITS.map((u) => `<label><input name="style.label_text.${u}" maxlength="24" placeholder="${esc(LABELS[s.label_locale][u])}" value="${esc(s.label_text[u] ?? '')}" /></label>`).join('')}</div>
    <label><span>${esc(t.expiredText)}</span><input name="style.expired_text" maxlength="60" value="${esc(s.expired_text)}" /></label>
    <label><span>${esc(t.customCss)}</span><textarea name="style.custom_css" spellcheck="false">${esc(s.custom_css)}</textarea></label>
    <p class="muted">${esc(t.customCssHint.replace('<id>', d.public_id ?? '<id>'))}</p>`;
}

function codeTab(d: Draft): string {
  if (d.snippets === null) return `<p class="muted">${esc(t.saveFirst)}</p>`;
  const s = d.snippets;
  const item = (label: string, key: string) =>
    `<div class="snippet"><div class="bar"><span class="grow">${esc(label)}</span><button type="button" class="ghost" data-copy="${esc(key)}">${esc(t.copy)}</button></div>
      <textarea readonly data-snippet="${esc(key)}">${esc(s[key])}</textarea></div>`;
  return `
    <h3>${esc(t.codeEmail)}</h3>
    ${item(t.emailHtml, 'email_html')}${item(t.emailImage, 'email_image')}${item(t.emailLink, 'email_link')}
    ${d.mode === 'fixed' ? item(t.emailShared, 'email_image_shared') : ''}
    <p class="muted">${esc(t.codeHint)}</p>
    <h3>${esc(t.codePage)}</h3>
    ${item(t.pageInline, 'page_inline')}${item(t.pageBar, 'page_bar')}`;
}

function contactsTab(d: Draft): string {
  if (d.id === null) return `<p class="muted">${esc(t.saveFirst)}</p>`;
  const now = Date.now();
  return `
    <div class="card">
      <strong>${esc(t.startFor)}</strong>
      <div class="bar" style="margin-top:8px"><input id="start-q" class="grow" placeholder="${esc(t.search)}" /><select id="start-contact"></select><button type="button" data-action="start">${esc(t.start)}</button></div>
    </div>
    <div class="bar">
      <input id="q" class="grow" placeholder="${esc(t.search)}" value="${esc(query)}" />
      <label class="check" style="margin:0"><input type="checkbox" id="only"${checked(onlyContacts)} /> ${esc(t.onlyContacts)}</label>
    </div>
    <div class="card bar" style="margin-top:10px">
      <span class="muted">${esc(selected.size === 0 ? `${t.selected(0)} (${t.all})` : t.selected(selected.size))}</span>
      <select id="change">
        ${option('reset', t.reset, '')}${option('restart', t.restart, '')}${option('extend', t.extend, '')}${option('set', t.setTo, '')}
      </select>
      <span id="extend-box" hidden><input id="extend-value" type="number" value="24" style="width:80px" /> <select id="extend-unit">${(['minutes', 'hours', 'days'] as const).map((u) => option(u, t[u], 'hours')).join('')}</select></span>
      <input id="set-value" type="datetime-local" hidden />
      <button type="button" data-action="apply">${esc(armed === 'apply' ? t.sure : t.apply)}</button>
    </div>
    ${
      rows.length === 0
        ? `<p class="muted">${esc(t.none)}</p>`
        : `<table><thead><tr><th><input type="checkbox" id="select-all"${checked(selected.size > 0 && selected.size === rows.length)} /></th><th>${esc(t.contact)}</th><th>${esc(t.started)}</th><th>${esc(t.deadline)}</th><th>${esc(t.source)}</th></tr></thead><tbody>
          ${rows
            .map(
              (r) => `<tr><td><input type="checkbox" data-select="${esc(r.id)}"${checked(selected.has(r.id))} /></td>
                <td>${r.contact_id === null ? `<span class="muted">${esc(t.visitor)}</span>` : `<a href="#" data-contact="${esc(r.contact_id)}">${esc(r.contact_name ?? r.contact_id)}</a>`}</td>
                <td class="muted">${esc(formatDate(r.started_at))}</td>
                <td>${esc(formatDate(r.deadline_at))} ${r.deadline_at <= now ? `<span class="pill off">${esc(t.expiredState)}</span>` : ''}</td>
                <td class="muted">${esc(t.sources[r.source] ?? r.source)}</td></tr>`,
            )
            .join('')}
        </tbody></table>
        ${nextBefore === null ? '' : `<p><button type="button" class="ghost" data-action="more">${esc(t.more)}</button></p>`}`
    }`;
}

function renderEditor(): void {
  const d = draft!;
  const tabs: Tab[] = ['setup', 'design', 'code', 'contacts'];
  const tabLabel = { setup: t.tabSetup, design: t.tabDesign, code: t.tabCode, contacts: t.tabContacts };
  const body = { setup: setupTab, design: designTab, code: codeTab, contacts: contactsTab }[tab](d);
  const withPreview = tab === 'setup' || tab === 'design';
  root.innerHTML = `
    <div class="bar">
      <button type="button" class="ghost" data-action="back">${esc(t.back)}</button>
      <input name="name" class="grow" placeholder="${esc(t.name)}" value="${esc(d.name)}" style="font-size:16px;font-weight:600" />
      ${d.id === null ? '' : `<button type="button" class="danger" data-action="delete">${esc(armed === 'delete' ? t.sure : t.remove)}</button>`}
      <button type="button" data-action="save">${esc(t.save)}</button>
    </div>
    <div class="tabs">${tabs.map((k) => `<button type="button" data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(tabLabel[k])}</button>`).join('')}</div>
    ${
      withPreview
        ? `<div class="cols"><form id="form" onsubmit="return false">${body}</form>
            <div><h3>${esc(t.preview)}</h3><div class="preview">
              <div class="muted">${esc(t.previewEmail)}</div><img id="preview-gif" alt="" />
              <div class="muted">${esc(t.previewPage)}</div><div id="preview-widget" style="width:100%"></div>
            </div></div></div>`
        : `<form id="form" onsubmit="return false">${body}</form>`
    }`;
  if (withPreview) refreshPreview(true);
  else stopPreview();
}

function render(): void {
  if (draft === null) renderList();
  else renderEditor();
}

/* ---------- preview ---------- */

function stopPreview(): void {
  previewTimer?.stop();
  previewTimer = null;
}

function previewSeconds(d: Draft): number {
  if (d.mode === 'fixed') {
    const end = d.fixed_end_at === '' ? Date.now() : new Date(d.fixed_end_at).getTime();
    return Math.max(0, (end - Date.now()) / 1000);
  }
  return durationMinutes(d) * 60;
}

function refreshPreview(now = false): void {
  if (previewDebounce !== null) clearTimeout(previewDebounce);
  const run = () => {
    const d = draft;
    const img = document.getElementById('preview-gif') as HTMLImageElement | null;
    const box = document.getElementById('preview-widget');
    if (d === null || img === null || box === null) return;
    const seconds = previewSeconds(d);
    const style = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(d.style))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    img.src = `preview.gif?style=${style}&minutes=${String(Math.round(seconds / 60))}`;
    const state = {
      publicId: d.public_id ?? 'preview',
      style: d.style,
      status: 'running' as const,
      deadlineAt: Date.now() + seconds * 1000,
      serverNow: Date.now(),
      expiry: 'zeros' as const,
      redirectUrl: null,
    };
    if (previewTimer === null || !box.firstChild) {
      previewTimer?.stop();
      previewTimer = mountTimer(box, state);
    } else previewTimer.update(state);
  };
  if (now) run();
  else previewDebounce = setTimeout(run, 350);
}

/* ---------- data ---------- */

async function loadCampaigns(): Promise<void> {
  campaigns = (await api<{ data: CampaignView[] }>('api/campaigns')).data;
}

async function loadDeadlines(more = false): Promise<void> {
  if (draft?.id == null) return;
  const params = new URLSearchParams({ campaign: draft.id });
  if (query !== '') params.set('q', query);
  if (onlyContacts) params.set('contacts', 'true');
  if (more && nextBefore !== null) params.set('before', nextBefore);
  const answer = await api<{ data: DeadlineRow[]; next_before: string | null }>(`api/deadlines?${params.toString()}`);
  rows = more ? [...rows, ...answer.data] : answer.data;
  nextBefore = answer.next_before;
  if (!more) selected = new Set();
}

function updateDraft(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
  const d = draft;
  if (d === null || field.name === '') return false;
  const value = field.value;
  const isCheck = field instanceof HTMLInputElement && field.type === 'checkbox';
  const on = field instanceof HTMLInputElement && field.checked;
  if (field.name.startsWith('style.')) {
    const key = field.name.slice(6);
    const style = { ...d.style } as Record<string, unknown>;
    if (key === 'units') {
      const units = new Set<Unit>(d.style.units);
      if (on) units.add(value as Unit);
      else if (units.size > 1) units.delete(value as Unit);
      else (field as HTMLInputElement).checked = true;
      style['units'] = UNITS.filter((u) => units.has(u));
    } else if (key.startsWith('label_text.')) {
      style['label_text'] = { ...d.style.label_text, [key.slice(11)]: value };
    } else if (isCheck) style[key] = on;
    else if (key === 'radius') style[key] = Number(value);
    else style[key] = value;
    d.style = normalizeStyle(style);
    refreshPreview();
    return key === 'label_locale';
  }
  switch (field.name) {
    case 'name':
    case 'offer_url':
    case 'expired_url':
    case 'fixed_end_at':
    case 'hard_end_at':
      d[field.name] = value;
      break;
    case 'duration_value':
      d.duration_value = Math.max(1, Number(value) || 1);
      break;
    case 'duration_unit':
      d.duration_unit = value as Draft['duration_unit'];
      break;
    case 'expiry':
      d.expiry = value as Draft['expiry'];
      break;
    case 'mode':
      d.mode = value as Draft['mode'];
      return true;
    case 'start_on':
      d.start_on = on ? [...new Set([...d.start_on, value])] : d.start_on.filter((k) => k !== value);
      break;
    default:
      return false;
  }
  refreshPreview();
  return false;
}

async function save(): Promise<void> {
  const d = draft!;
  const saved = await api<CampaignView>('api/campaigns', { method: 'POST', body: payload(d) });
  draft = { ...draftOf(saved) };
  await loadCampaigns();
  bridge.toast(t.saved, 'success');
  render();
}

async function applyChange(): Promise<void> {
  const kind = (document.getElementById('change') as HTMLSelectElement).value;
  let change: Record<string, unknown> = { kind };
  if (kind === 'extend') {
    const value = Number((document.getElementById('extend-value') as HTMLInputElement).value);
    const unit = (document.getElementById('extend-unit') as HTMLSelectElement).value as 'minutes' | 'hours' | 'days';
    change = { kind, minutes: Math.round(value * { minutes: 1, hours: 60, days: 1440 }[unit]) };
  }
  if (kind === 'set') {
    const at = fromLocalInput((document.getElementById('set-value') as HTMLInputElement).value);
    if (at === null) return;
    change = { kind, deadline_at: at };
  }
  const target = selected.size === 0 ? { all: true } : { ids: [...selected] };
  const answer = await api<{ changed: number }>('api/deadlines', { method: 'POST', body: { campaign: draft!.id, ...target, change } });
  bridge.toast(t.changed(answer.changed), 'success');
  await loadDeadlines();
  render();
}

let contactSearch: ReturnType<typeof setTimeout> | null = null;
let listSearch: ReturnType<typeof setTimeout> | null = null;

root.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  if (target.id === 'q') {
    query = (target as HTMLInputElement).value.trim();
    if (listSearch !== null) clearTimeout(listSearch);
    listSearch = setTimeout(() => void loadDeadlines().then(render, fail).then(() => focusEnd('q')), 350);
    return;
  }
  if (target.id === 'start-q') {
    const q = (target as HTMLInputElement).value.trim();
    if (contactSearch !== null) clearTimeout(contactSearch);
    contactSearch = setTimeout(async () => {
      const select = document.getElementById('start-contact') as HTMLSelectElement | null;
      if (select === null) return;
      const found = q === '' ? { data: [] } : await api<{ data: Array<{ id: string; name: string }> }>(`api/contacts?q=${encodeURIComponent(q)}`).catch(() => ({ data: [] }));
      select.innerHTML = found.data.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    }, 300);
    return;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    if (target.type !== 'radio' && target.type !== 'checkbox' && !(target instanceof HTMLSelectElement)) updateDraft(target);
  }
});

function focusEnd(id: string): void {
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (input === null) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

root.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target.id === 'only') {
    onlyContacts = (target as HTMLInputElement).checked;
    void loadDeadlines().then(render, fail);
    return;
  }
  if (target.id === 'change') {
    const kind = (target as HTMLSelectElement).value;
    document.getElementById('extend-box')!.hidden = kind !== 'extend';
    document.getElementById('set-value')!.hidden = kind !== 'set';
    return;
  }
  if (target.id === 'select-all') {
    selected = (target as HTMLInputElement).checked ? new Set(rows.map((r) => r.id)) : new Set();
    render();
    return;
  }
  const select = target.dataset['select'];
  if (select !== undefined) {
    if ((target as HTMLInputElement).checked) selected.add(select);
    else selected.delete(select);
    render();
    return;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
    if (target.type === 'radio' || target.type === 'checkbox' || target instanceof HTMLSelectElement) {
      if (updateDraft(target)) render();
    }
  }
});

root.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action],[data-open],[data-tab],[data-preset],[data-copy],[data-contact]');
  if (target === null) return;
  const { action, open, preset, copy, contact } = target.dataset;
  const tabKey = target.dataset['tab'] as Tab | undefined;
  if (action !== armed) armed = null;
  if (open !== undefined) {
    const c = campaigns.find((x) => x.id === open);
    if (c !== undefined) {
      draft = draftOf(c);
      tab = 'setup';
      rows = [];
      render();
    }
    return;
  }
  if (tabKey !== undefined) {
    tab = tabKey;
    if (tab === 'contacts') void loadDeadlines().then(render, fail);
    render();
    return;
  }
  if (preset !== undefined && draft !== null) {
    draft.style = normalizeStyle({ ...draft.style, ...PRESET_PALETTES[preset as Preset], preset });
    render();
    return;
  }
  if (copy !== undefined) {
    const text = draft?.snippets?.[copy] ?? '';
    const done = () => bridge.toast(t.copied, 'success');
    navigator.clipboard?.writeText(text).then(done, () => {
      const area = document.querySelector<HTMLTextAreaElement>(`[data-snippet="${copy}"]`);
      area?.select();
      document.execCommand('copy');
      done();
    });
    return;
  }
  if (contact !== undefined) {
    event.preventDefault();
    bridge.openContact(contact);
    return;
  }
  switch (action) {
    case 'new':
      draft = newDraft();
      tab = 'setup';
      render();
      (document.querySelector('[name="name"]') as HTMLInputElement | null)?.focus();
      break;
    case 'back':
      draft = null;
      void loadCampaigns().then(render, fail);
      break;
    case 'save':
      void save().catch(fail);
      break;
    case 'delete':
      if (armed !== 'delete') {
        armed = 'delete';
        render();
        return;
      }
      armed = null;
      void api(`api/campaigns?id=${encodeURIComponent(draft!.id!)}`, { method: 'DELETE' })
        .then(async () => {
          draft = null;
          await loadCampaigns();
          render();
        })
        .catch(fail);
      break;
    case 'apply':
      // With nothing selected the change hits every deadline of the campaign: ask twice.
      if (selected.size === 0 && armed !== 'apply') {
        armed = 'apply';
        target.textContent = t.sure;
        return;
      }
      armed = null;
      void applyChange().catch(fail);
      break;
    case 'more':
      void loadDeadlines(true).then(render, fail);
      break;
    case 'start': {
      const contactId = (document.getElementById('start-contact') as HTMLSelectElement | null)?.value ?? '';
      if (contactId === '') return;
      void api('api/deadlines/start', { method: 'POST', body: { campaign: draft!.id, contact_id: contactId } })
        .then(() => loadDeadlines())
        .then(render, fail);
      break;
    }
  }
});

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  locale = context.locale;
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  render();
});

Promise.all([
  loadCampaigns(),
  api<typeof settings>('api/settings')
    .then((s) => {
      settings = s;
    })
    .catch(() => undefined),
])
  .then(render)
  .catch(fail);
