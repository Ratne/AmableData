import { createAppBridge } from '@amable/app-bridge';

const TEXT = {
  en: {
    intro:
      'Templates are the only messages WhatsApp lets you send when the contact has not written in the last 24 hours. Meta reviews each one before it can be used.',
    name: 'Name',
    language: 'Language',
    category: 'Category',
    state: 'Status',
    text: 'Text',
    create: 'New template',
    utility: 'Utility (orders, appointments, account)',
    marketing: 'Marketing (offers, news)',
    authentication: 'Authentication (one-time codes)',
    header: 'Header (optional, up to 60 characters)',
    body: 'Text',
    paramsHint:
      'Parameters are names in double braces, such as {{first_name}}. Meta wants an example for each.',
    footer: 'Footer (optional)',
    buttons: 'Buttons (optional)',
    addButton: 'Add a button',
    authHint:
      'Meta writes the text of authentication templates: you send the code as the parameter {{1}}.',
    security: 'Add "do not share this code"',
    expiry: 'Code expires after (minutes, optional)',
    submit: 'Submit to Meta for review',
    example: (p: string) => `Example for {{${p}}}`,
    quickReply: 'Quick reply',
    link: 'Link',
    call: 'Call',
    buttonText: 'Label',
    buttonUrl: 'https://… (end with {{1}} for a dynamic part)',
    buttonExample: 'Example of the dynamic part',
    buttonPhone: '+393331234567',
    removeButton: 'Remove',
    delete: 'Delete',
    confirmDelete: (n: string) =>
      `Delete "${n}" in every language? Meta does not let you reuse the name for 30 days.`,
    translate: 'Add a language',
    submitted: 'Submitted: Meta usually answers within minutes, sometimes up to 24 hours.',
    deleted: 'Template deleted',
    failed: 'Something went wrong',
    notConnected: 'Connect a WhatsApp number in the Kapso app settings first.',
    sandbox: 'The connected number is a Kapso sandbox: templates need a production number.',
    empty: 'No templates yet.',
    count: (n: number, approved: number) => `${String(n)} templates, ${String(approved)} approved.`,
    rejected: 'Rejected',
  },
  it: {
    intro:
      'I template sono gli unici messaggi che WhatsApp permette di inviare quando il contatto non scrive da più di 24 ore. Meta li approva uno per uno prima che si possano usare.',
    name: 'Nome',
    language: 'Lingua',
    category: 'Categoria',
    state: 'Stato',
    text: 'Testo',
    create: 'Nuovo template',
    utility: 'Utility (ordini, appuntamenti, account)',
    marketing: 'Marketing (offerte, novità)',
    authentication: 'Autenticazione (codici monouso)',
    header: 'Intestazione (facoltativa, fino a 60 caratteri)',
    body: 'Testo',
    paramsHint:
      'I parametri sono nomi tra doppie graffe, come {{first_name}}. Meta vuole un esempio per ognuno.',
    footer: 'Piè di pagina (facoltativo)',
    buttons: 'Pulsanti (facoltativi)',
    addButton: 'Aggiungi un pulsante',
    authHint:
      'Il testo dei template di autenticazione lo scrive Meta: tu invii il codice come parametro {{1}}.',
    security: 'Aggiungi "non condividere questo codice"',
    expiry: 'Il codice scade dopo (minuti, facoltativo)',
    submit: 'Invia a Meta per la revisione',
    example: (p: string) => `Esempio per {{${p}}}`,
    quickReply: 'Risposta rapida',
    link: 'Link',
    call: 'Chiamata',
    buttonText: 'Etichetta',
    buttonUrl: 'https://… (finisci con {{1}} per una parte variabile)',
    buttonExample: 'Esempio della parte variabile',
    buttonPhone: '+393331234567',
    removeButton: 'Rimuovi',
    delete: 'Elimina',
    confirmDelete: (n: string) =>
      `Eliminare "${n}" in tutte le lingue? Meta non permette di riusare il nome per 30 giorni.`,
    translate: 'Aggiungi una lingua',
    submitted: 'Inviato: di solito Meta risponde in pochi minuti, a volte fino a 24 ore.',
    deleted: 'Template eliminato',
    failed: 'Qualcosa è andato storto',
    notConnected: "Collega prima un numero WhatsApp dalle impostazioni dell'app Kapso.",
    sandbox:
      'Il numero collegato è una sandbox di Kapso: i template richiedono un numero di produzione.',
    empty: 'Nessun template.',
    count: (n: number, approved: number) => `${String(n)} template, ${String(approved)} approvati.`,
    rejected: 'Rifiutato',
  },
};

interface Template {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejected_reason: string | null;
  text: string;
}

const bridge = createAppBridge();
bridge.autoResize();
let t = TEXT.en;

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}
const form = $<HTMLFormElement>('#create');
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  query = '',
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`api/templates${query}`, {
    method,
    headers: {
      authorization: `Bearer ${await bridge.sessionToken()}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function renderList(body: Record<string, unknown>): void {
  const templates = (body['templates'] ?? []) as Template[];
  const status = $('#status');
  $('#create-section').hidden = body['number'] === null || body['sandbox'] === true;
  if (body['number'] === null) status.textContent = t.notConnected;
  else if (body['sandbox'] === true) status.textContent = t.sandbox;
  else
    status.textContent =
      templates.length === 0
        ? t.empty
        : t.count(templates.length, templates.filter((x) => x.status === 'APPROVED').length);
  $('#templates').replaceChildren(
    ...templates.map((template) =>
      el(
        'tr',
        {},
        el('td', {}, template.name),
        el('td', {}, template.language),
        el('td', {}, template.category.toLowerCase()),
        el(
          'td',
          {},
          el(
            'span',
            { className: `badge ${template.status}` },
            template.status === 'REJECTED' ? t.rejected : template.status.toLowerCase(),
          ),
          ...(template.rejected_reason === null || template.rejected_reason === 'NONE'
            ? []
            : [el('div', { className: 'muted' }, template.rejected_reason)]),
        ),
        el('td', { className: 'pre' }, template.text),
        el(
          'td',
          {},
          el('button', {
            type: 'button',
            className: 'ghost',
            textContent: t.translate,
            onclick: () => translate(template),
          }),
          el('button', {
            type: 'button',
            className: 'ghost',
            textContent: t.delete,
            onclick: () => void remove(template.name),
          }),
        ),
      ),
    ),
  );
}

async function load(): Promise<void> {
  try {
    renderList((await call('GET')).body);
  } catch {
    $('#status').textContent = t.failed;
  }
}

function translate(template: Template): void {
  field('name').value = template.name;
  (form.elements.namedItem('category') as HTMLSelectElement).value = template.category;
  syncCategory();
  form.scrollIntoView({ behavior: 'smooth' });
  (form.elements.namedItem('language') as HTMLSelectElement).focus();
}

async function remove(name: string): Promise<void> {
  if (!window.confirm(t.confirmDelete(name))) return;
  const result = await call('DELETE', `?${new URLSearchParams({ name }).toString()}`);
  if (result.status >= 400) return bridge.toast(String(result.body['error'] ?? t.failed), 'error');
  bridge.toast(t.deleted, 'success');
  await load();
}

/** One example input per {{parameter}} of the header and body. */
function syncExamples(): void {
  const text = `${field('header').value} ${(form.elements.namedItem('body') as HTMLTextAreaElement).value}`;
  const params = [
    ...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!)),
  ];
  const box = $('#examples');
  const current = new Map(
    [...box.querySelectorAll<HTMLInputElement>('input')].map((input) => [
      input.dataset['param']!,
      input.value,
    ]),
  );
  box.replaceChildren(
    ...params.map((param) => {
      const input = el('input', { value: current.get(param) ?? '', required: true });
      input.dataset['param'] = param;
      return el('label', {}, el('span', {}, t.example(param)), input);
    }),
  );
}

function addButton(): void {
  const type = el(
    'select',
    {},
    el('option', { value: 'QUICK_REPLY' }, t.quickReply),
    el('option', { value: 'URL' }, t.link),
    el('option', { value: 'PHONE_NUMBER' }, t.call),
  );
  const text = el('input', { placeholder: t.buttonText, maxLength: 25, required: true });
  const target = el('input', { placeholder: t.buttonUrl, hidden: true });
  const example = el('input', { placeholder: t.buttonExample, hidden: true });
  const row = el('div', { className: 'row button-row' }, type, text, target, example);
  const sync = () => {
    target.hidden = type.value === 'QUICK_REPLY';
    target.placeholder = type.value === 'URL' ? t.buttonUrl : t.buttonPhone;
    example.hidden = !(type.value === 'URL' && /\{\{1\}\}$/.test(target.value));
  };
  type.addEventListener('change', sync);
  target.addEventListener('input', sync);
  row.append(
    el('button', {
      type: 'button',
      className: 'ghost',
      textContent: t.removeButton,
      onclick: () => row.remove(),
    }),
  );
  $('#buttons').append(row);
}

function syncCategory(): void {
  const auth =
    (form.elements.namedItem('category') as HTMLSelectElement).value === 'AUTHENTICATION';
  $('#content-fields').hidden = auth;
  $('#auth-fields').hidden = !auth;
  (form.elements.namedItem('body') as HTMLTextAreaElement).required = !auth;
}

bridge.onContext((context) => {
  document.body.classList.toggle('dark', context.theme === 'dark');
  t = context.locale.startsWith('it') ? TEXT.it : TEXT.en;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const value = t[node.dataset['i18n'] as keyof typeof t];
    if (typeof value === 'string') node.textContent = value;
  }
  void load();
});

form.addEventListener('input', (event) => {
  if ((event.target as HTMLElement).matches('[name="header"], [name="body"]')) syncExamples();
});
(form.elements.namedItem('category') as HTMLSelectElement).addEventListener('change', syncCategory);
$('#add-button').addEventListener('click', addButton);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const examples = Object.fromEntries(
    [...$('#examples').querySelectorAll<HTMLInputElement>('input')].map((i) => [
      i.dataset['param']!,
      i.value.trim(),
    ]),
  );
  const buttons = [...$('#buttons').querySelectorAll<HTMLElement>('.button-row')].map((row) => {
    const [type, text, target, example] = [
      ...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, input'),
    ];
    return {
      type: type!.value,
      text: text!.value.trim(),
      ...(type!.value === 'URL'
        ? { url: target!.value.trim(), example: example!.value.trim() }
        : {}),
      ...(type!.value === 'PHONE_NUMBER' ? { phone_number: target!.value.trim() } : {}),
    };
  });
  const minutes = field('code_expiration_minutes').value;
  const draft = {
    name: field('name').value.trim(),
    language: (form.elements.namedItem('language') as HTMLSelectElement).value,
    category: (form.elements.namedItem('category') as HTMLSelectElement).value,
    header: field('header').value,
    body: (form.elements.namedItem('body') as HTMLTextAreaElement).value,
    footer: field('footer').value,
    examples,
    buttons,
    security_recommendation: field('security_recommendation').checked,
    ...(minutes === '' ? {} : { code_expiration_minutes: Number(minutes) }),
  };
  void call('POST', '', draft)
    .then(async (result) => {
      if (result.status >= 400)
        return bridge.toast(String(result.body['error'] ?? t.failed), 'error');
      bridge.toast(t.submitted, 'success');
      form.reset();
      $('#examples').replaceChildren();
      $('#buttons').replaceChildren();
      syncCategory();
      await load();
    })
    .catch(() => bridge.toast(t.failed, 'error'));
});
syncCategory();
