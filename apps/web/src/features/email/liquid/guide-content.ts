import type { Locale } from '@amable/i18n';

/**
 * In-app guide to Dynamic Content and Liquid. Text supports `inline code`.
 * `fields`, `filters` and `limits` blocks are filled from the live context
 * schema (GET /liquid/schema), so they always match what the sandbox accepts.
 */

export type GuideBlock =
  | { readonly type: 'p'; readonly text: string }
  | { readonly type: 'list'; readonly items: readonly string[] }
  | { readonly type: 'code'; readonly code: string; readonly note?: string }
  | { readonly type: 'fields' }
  | { readonly type: 'filters' }
  | { readonly type: 'limits' };

export interface GuideSection {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly GuideBlock[];
}

const en: readonly GuideSection[] = [
  {
    id: 'what',
    title: 'What Dynamic Content is',
    blocks: [
      {
        type: 'p',
        text: 'Dynamic Content snippets are reusable pieces of text with Liquid logic — a greeting, a VIP offer, a signature, a legal notice. You write them once and use them in any email template, broadcast or automation email; each recipient gets the version computed from their own data.',
      },
      {
        type: 'p',
        text: 'Liquid is a small template language: `{{ … }}` prints a value, `{% … %}` runs logic (conditions, loops, variables). Emails can use Liquid directly too, without a snippet: field chips, condition blocks and raw Liquid blocks in the editor.',
      },
      {
        type: 'list',
        items: [
          'Use a snippet when the same text appears in several emails, or when non-technical colleagues should not touch the logic.',
          'Use Liquid inside the email when the logic belongs to that email only.',
          'Open the Liquid helper (`{{ }} Liquid helper` in the editor toolbar, or the right panel of the snippet editor) to pick fields, build conditions and see the result for a real contact.',
        ],
      },
    ],
  },
  {
    id: 'create',
    title: 'Create and edit a snippet',
    blocks: [
      {
        type: 'list',
        items: [
          'Templates → Dynamic Content → New snippet.',
          'Name: what colleagues see in the field picker.',
          'Key: lowercase letters, digits and `_` (e.g. `vip_offer`). It becomes `{{ snippets.vip_offer }}` and cannot be changed later.',
          'Content: text and Liquid. The editor numbers lines, highlights Liquid and flags syntax errors while you type; the panel on the right previews it for any contact.',
        ],
      },
      {
        type: 'p',
        text: 'Changes are live: every email that references the snippet uses the new content from its next send — including scheduled broadcasts that have not gone out yet. There is no version history. To change a snippet safely, create a new key (e.g. `vip_offer_v2`), test it, then switch the emails over and delete the old one.',
      },
    ],
  },
  {
    id: 'insert',
    title: 'Insert a snippet in an email',
    blocks: [
      {
        type: 'list',
        items: [
          'In the email editor type `{{` and pick the snippet from the Dynamic Content group, or click it in the Liquid helper (Fields tab).',
          'The snippet is referenced as a variable: `{{ snippets.<key> }}`. Liquid `{% render %}` and `{% include %}` are not available — the sandbox has no files.',
          'A snippet is rendered for the recipient first, then placed in the email as text: HTML tags written in a snippet are shown literally, not interpreted. Use the email editor for formatting.',
          'Snippets cannot reference other snippets, and a snippet that fails at send time renders empty: always check it in the preview.',
        ],
      },
      { type: 'code', code: '{{ snippets.vip_offer }}' },
    ],
  },
  {
    id: 'fields',
    title: 'Merge fields',
    blocks: [
      {
        type: 'p',
        text: 'These variables exist when an email is rendered. The list comes from the render context of this workspace, including your contact custom fields and snippets. Custom fields are under `contact.custom.<key>`; a field with no value for a contact is missing (use a fallback).',
      },
      { type: 'fields' },
      {
        type: 'p',
        text: 'Lists such as `contact.tags` support `size`, `first`, `last` and loops. The current date is not a variable: write the literal `"now"` with the `date` filter, e.g. `{{ "now" | date: "%Y" }}`.',
      },
    ],
  },
  {
    id: 'filters',
    title: 'Filters',
    blocks: [
      {
        type: 'p',
        text: 'Filters transform a value: `{{ value | filter: argument }}`, and they can be chained. Only the filters below exist; an unknown filter is a syntax error.',
      },
      {
        type: 'code',
        code: '{{ contact.first_name | default: "there" }}\n{{ contact.first_name | capitalize }}\n{{ contact.city | upcase }}  {{ contact.email | downcase }}\n{{ contact.custom.bio | truncate: 80 }}\n{{ contact.custom.bio | truncatewords: 12, "…" }}\n{{ contact.tags | join: ", " }}  {{ contact.tags | size }}\n{{ contact.custom.price | times: 0.9 | round: 2 }}\n{{ "now" | date: "%d/%m/%Y" }}',
      },
      { type: 'filters' },
    ],
  },
  {
    id: 'dates',
    title: 'Dates and time zones',
    blocks: [
      {
        type: 'p',
        text: '`date` takes a strftime format and, optionally, a time zone. Without one, dates use the workspace timezone set in Settings › Email sending, in the preview exactly as in the sent email. Pass `contact.time_zone` to show the time in the recipient’s zone (contacts without a zone fall back to the workspace timezone), or a fixed IANA zone such as `"Europe/Rome"`. Dates without a time, like DATE fields, are never shifted by a zone.',
      },
      {
        type: 'code',
        code: '{{ contact.custom.renewal_date | date: "%d/%m/%Y" }}\n{{ contact.custom.webinar_at | date: "%A %-d %B, %H:%M", contact.time_zone }}\n{{ "now" | date: "%Y" }}',
      },
      {
        type: 'list',
        items: [
          '`%d` day (01–31), `%-d` day without zero, `%m` month, `%B` month name, `%b` short month, `%A` weekday, `%Y` year, `%H:%M` time, `%I %p` 12-hour time, `%s` Unix seconds.',
          'Month and weekday names are in English: for Italian names use a `case` on `date: "%m"`.',
        ],
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Conditions',
    blocks: [
      {
        type: 'code',
        code: '{% if contact.score > 80 %}\n  You are one of our best customers.\n{% elsif contact.tags contains "Trial" %}\n  Your trial is running.\n{% else %}\n  Welcome!\n{% endif %}',
      },
      {
        type: 'list',
        items: [
          'Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains` (text or list), `and`, `or`.',
          'There are no parentheses and `and`/`or` are evaluated right to left: split complex logic into nested `if`s.',
          'Empty text is “true” in Liquid. To test that a field has a value write `{% if contact.first_name != blank %}`, not `{% if contact.first_name %}`.',
          '`unless` is the opposite of `if`: `{% unless contact.tags contains "VIP" %}…{% endunless %}`.',
          '`case` compares one value with several: `{% case contact.country %}{% when "IT", "SM" %}Ciao{% when "FR" %}Bonjour{% else %}Hello{% endcase %}`.',
        ],
      },
    ],
  },
  {
    id: 'loops',
    title: 'Loops',
    blocks: [
      {
        type: 'code',
        code: '{% for tag in contact.tags limit: 3 %}\n  {{ tag }}{% unless forloop.last %}, {% endunless %}\n{% else %}\n  No interests yet.\n{% endfor %}',
      },
      {
        type: 'list',
        items: [
          '`limit:` and `offset:` keep loops short; `{% else %}` runs when the list is empty.',
          'Inside the loop: `forloop.index` (from 1), `forloop.first`, `forloop.last`, `{% break %}`, `{% continue %}`.',
          'Ranges: `{% for i in (1..3) %}`. Every render has a time and memory budget (see Sandbox limits): very large loops stop with an error.',
        ],
      },
    ],
  },
  {
    id: 'whitespace',
    title: 'Variables and whitespace',
    blocks: [
      {
        type: 'code',
        code: '{%- assign name = contact.first_name | default: "there" -%}\n{%- capture greeting -%}Hi {{ name }}{%- endcapture -%}\n{{ greeting }}',
      },
      {
        type: 'p',
        text: '`assign` stores a value, `capture` stores rendered text. A dash inside the delimiters (`{%-`, `-%}`, `{{-`, `-}}`) removes the spaces and line breaks around the tag, so logic on its own lines does not leave blank lines in the email.',
      },
    ],
  },
  {
    id: 'fallbacks',
    title: 'Fallbacks for missing values',
    blocks: [
      {
        type: 'p',
        text: '`default` replaces a missing, empty or false value. Field chips in the editor have a fallback setting (click the chip); the Fallback builder generates it for you. The live preview lists the variables that are empty for the selected contact.',
      },
      { type: 'code', code: 'Hi {{ contact.first_name | default: "there" }},' },
    ],
  },
  {
    id: 'recipes',
    title: 'Recipes',
    blocks: [
      { type: 'p', text: 'Greeting with fallback:' },
      { type: 'code', code: 'Hi {{ contact.first_name | default: "there" }},' },
      {
        type: 'p',
        text: 'Text by language or gender — these are not standard fields: store them in a custom field (e.g. `language`, `gender`) and branch on it:',
      },
      {
        type: 'code',
        code: '{% case contact.custom.language %}\n{% when "it" %}Ciao {{ contact.first_name }}!\n{% when "fr" %}Bonjour {{ contact.first_name }} !\n{% else %}Hello {{ contact.first_name }}!\n{% endcase %}',
      },
      { type: 'p', text: 'Show a block only to contacts with a tag:' },
      { type: 'code', code: '{% if contact.tags contains "Webinar 2026" %}\nYour recording is ready.\n{% endif %}' },
      { type: 'p', text: 'VIP pricing from a custom field:' },
      {
        type: 'code',
        code: '{% if contact.custom.vip_level == "gold" %}\n  Your price: {{ 100 | times: 0.8 }} €\n{% elsif contact.custom.vip_level != blank %}\n  Your price: {{ 100 | times: 0.9 }} €\n{% else %}\n  Price: 100 €\n{% endif %}',
      },
      { type: 'p', text: 'Countdown to a date, and the date in the contact’s time zone:' },
      {
        type: 'code',
        code: '{%- assign now_s = "now" | date: "%s" | plus: 0 -%}\n{%- assign end_s = contact.custom.renewal_date | date: "%s" | plus: 0 -%}\n{%- assign days = end_s | minus: now_s | divided_by: 86400 -%}\n{% if days > 0 %}Your plan renews in {{ days }} days, on {{ contact.custom.renewal_date | date: "%d/%m/%Y", contact.time_zone }}.{% endif %}',
      },
      {
        type: 'p',
        text: 'Call to action by lifecycle stage — use the tag or custom field where you keep the stage:',
      },
      {
        type: 'code',
        code: '{% case contact.custom.lifecycle_stage %}\n{% when "lead", "subscriber" %}Start your free trial: https://example.com/trial\n{% when "customer" %}Upgrade your plan: https://example.com/upgrade\n{% else %}Talk to us: https://example.com/contact\n{% endcase %}',
        note: 'In an email, links and buttons are better added with the editor (button block) inside a condition block; in a snippet, HTML is shown as text.',
      },
    ],
  },
  {
    id: 'sandbox',
    title: 'Sandbox limits and security',
    blocks: [
      {
        type: 'list',
        items: [
          'No files and no network: `include`, `render` and `layout` find nothing.',
          'Only the data listed in Merge fields is readable; object internals (`constructor`, `__proto__`) are invisible.',
          'Unknown filters are errors. Every output is HTML-escaped in the HTML part of an email (subject and plain text are not), so contact data can never inject markup.',
          'Liquid typed as plain text in the email editor stays literal: insert it with a field chip, a condition block, a raw Liquid block or the helper.',
          'The preview masks sensitive custom fields for roles that cannot read them. Real sends use the real value: avoid sensitive fields in emails.',
          'The preview renders with the same sandbox and the same context as sending (with an example unsubscribe link); nothing is stored or sent.',
        ],
      },
      { type: 'limits' },
    ],
  },
];

const it: readonly GuideSection[] = [
  {
    id: 'what',
    title: 'Cosa sono i contenuti dinamici',
    blocks: [
      {
        type: 'p',
        text: 'Gli snippet di contenuto dinamico sono pezzi di testo riutilizzabili con logica Liquid — un saluto, un’offerta VIP, una firma, una nota legale. Li scrivi una volta e li usi in qualsiasi template, broadcast o email di automazione; ogni destinatario riceve la versione calcolata sui propri dati.',
      },
      {
        type: 'p',
        text: 'Liquid è un piccolo linguaggio di template: `{{ … }}` stampa un valore, `{% … %}` esegue logica (condizioni, cicli, variabili). Anche le email possono usare Liquid direttamente, senza snippet: chip dei campi, blocchi condizione e blocchi Liquid grezzo nell’editor.',
      },
      {
        type: 'list',
        items: [
          'Usa uno snippet quando lo stesso testo compare in più email, o quando i colleghi non tecnici non devono toccare la logica.',
          'Usa Liquid dentro l’email quando la logica riguarda solo quell’email.',
          'Apri l’assistente Liquid (`{{ }} Assistente Liquid` nella barra dell’editor, o il pannello a destra dell’editor snippet) per scegliere i campi, costruire condizioni e vedere il risultato per un contatto reale.',
        ],
      },
    ],
  },
  {
    id: 'create',
    title: 'Creare e modificare uno snippet',
    blocks: [
      {
        type: 'list',
        items: [
          'Template → Contenuti dinamici → Nuovo snippet.',
          'Nome: quello che i colleghi vedono nel selettore dei campi.',
          'Chiave: lettere minuscole, cifre e `_` (es. `offerta_vip`). Diventa `{{ snippets.offerta_vip }}` e non si può cambiare dopo.',
          'Contenuto: testo e Liquid. L’editor numera le righe, evidenzia il Liquid e segnala gli errori di sintassi mentre scrivi; il pannello a destra lo mostra in anteprima per qualsiasi contatto.',
        ],
      },
      {
        type: 'p',
        text: 'Le modifiche sono immediate: ogni email che usa lo snippet prende il nuovo contenuto dal prossimo invio — anche i broadcast programmati non ancora partiti. Non c’è storico delle versioni. Per cambiare uno snippet in sicurezza crea una nuova chiave (es. `offerta_vip_v2`), provala, poi aggiorna le email ed elimina la vecchia.',
      },
    ],
  },
  {
    id: 'insert',
    title: 'Inserire uno snippet in un’email',
    blocks: [
      {
        type: 'list',
        items: [
          'Nell’editor email digita `{{` e scegli lo snippet dal gruppo Contenuti dinamici, oppure cliccalo nell’assistente Liquid (scheda Campi).',
          'Lo snippet si richiama come variabile: `{{ snippets.<chiave> }}`. `{% render %}` e `{% include %}` non sono disponibili — il sandbox non ha file.',
          'Lo snippet viene prima calcolato per il destinatario e poi messo nell’email come testo: i tag HTML scritti in uno snippet si vedono così come sono, non vengono interpretati. Per la formattazione usa l’editor email.',
          'Uno snippet non può richiamarne altri, e uno snippet che fallisce all’invio diventa vuoto: controllalo sempre nell’anteprima.',
        ],
      },
      { type: 'code', code: '{{ snippets.offerta_vip }}' },
    ],
  },
  {
    id: 'fields',
    title: 'Campi disponibili',
    blocks: [
      {
        type: 'p',
        text: 'Queste variabili esistono quando un’email viene generata. L’elenco arriva dal contesto di rendering di questo workspace, compresi i tuoi custom field dei contatti e gli snippet. I custom field sono in `contact.custom.<chiave>`; un campo senza valore per un contatto è mancante (usa un valore di riserva).',
      },
      { type: 'fields' },
      {
        type: 'p',
        text: 'Le liste come `contact.tags` supportano `size`, `first`, `last` e i cicli. La data corrente non è una variabile: scrivi il letterale `"now"` con il filtro `date`, es. `{{ "now" | date: "%Y" }}`.',
      },
    ],
  },
  {
    id: 'filters',
    title: 'Filtri',
    blocks: [
      {
        type: 'p',
        text: 'I filtri trasformano un valore: `{{ valore | filtro: argomento }}`, e si possono concatenare. Esistono solo i filtri qui sotto; un filtro sconosciuto è un errore di sintassi.',
      },
      {
        type: 'code',
        code: '{{ contact.first_name | default: "ciao" }}\n{{ contact.first_name | capitalize }}\n{{ contact.city | upcase }}  {{ contact.email | downcase }}\n{{ contact.custom.bio | truncate: 80 }}\n{{ contact.custom.bio | truncatewords: 12, "…" }}\n{{ contact.tags | join: ", " }}  {{ contact.tags | size }}\n{{ contact.custom.prezzo | times: 0.9 | round: 2 }}\n{{ "now" | date: "%d/%m/%Y" }}',
      },
      { type: 'filters' },
    ],
  },
  {
    id: 'dates',
    title: 'Date e fusi orari',
    blocks: [
      {
        type: 'p',
        text: '`date` accetta un formato strftime e, opzionalmente, un fuso orario. Senza fuso le date usano il fuso orario dello spazio impostato in Impostazioni › Invio email, nell’anteprima esattamente come nell’email inviata. Passa `contact.time_zone` per mostrare l’ora nel fuso del destinatario (i contatti senza fuso usano quello dello spazio), oppure un fuso IANA fisso come `"Europe/Rome"`. Le date senza ora, come i campi di tipo data, non vengono mai spostate da un fuso.',
      },
      {
        type: 'code',
        code: '{{ contact.custom.data_rinnovo | date: "%d/%m/%Y" }}\n{{ contact.custom.webinar_alle | date: "%d/%m %H:%M", contact.time_zone }}\n{{ "now" | date: "%Y" }}',
      },
      {
        type: 'list',
        items: [
          '`%d` giorno (01–31), `%-d` giorno senza zero, `%m` mese, `%B` nome del mese, `%b` mese breve, `%A` giorno della settimana, `%Y` anno, `%H:%M` ora, `%s` secondi Unix.',
          'I nomi di mesi e giorni sono in inglese: per i nomi italiani usa un `case` su `date: "%m"`.',
        ],
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Condizioni',
    blocks: [
      {
        type: 'code',
        code: '{% if contact.score > 80 %}\n  Sei tra i nostri clienti migliori.\n{% elsif contact.tags contains "Prova" %}\n  La tua prova è attiva.\n{% else %}\n  Benvenuto!\n{% endif %}',
      },
      {
        type: 'list',
        items: [
          'Operatori: `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains` (testo o lista), `and`, `or`.',
          'Non ci sono parentesi e `and`/`or` si valutano da destra a sinistra: spezza la logica complessa in `if` annidati.',
          'In Liquid un testo vuoto è “vero”. Per controllare che un campo abbia un valore scrivi `{% if contact.first_name != blank %}`, non `{% if contact.first_name %}`.',
          '`unless` è il contrario di `if`: `{% unless contact.tags contains "VIP" %}…{% endunless %}`.',
          '`case` confronta un valore con più alternative: `{% case contact.country %}{% when "IT", "SM" %}Ciao{% when "FR" %}Bonjour{% else %}Hello{% endcase %}`.',
        ],
      },
    ],
  },
  {
    id: 'loops',
    title: 'Cicli',
    blocks: [
      {
        type: 'code',
        code: '{% for tag in contact.tags limit: 3 %}\n  {{ tag }}{% unless forloop.last %}, {% endunless %}\n{% else %}\n  Ancora nessun interesse.\n{% endfor %}',
      },
      {
        type: 'list',
        items: [
          '`limit:` e `offset:` tengono i cicli corti; `{% else %}` viene eseguito quando la lista è vuota.',
          'Dentro il ciclo: `forloop.index` (da 1), `forloop.first`, `forloop.last`, `{% break %}`, `{% continue %}`.',
          'Intervalli: `{% for i in (1..3) %}`. Ogni rendering ha un budget di tempo e memoria (vedi Limiti del sandbox): cicli enormi si fermano con un errore.',
        ],
      },
    ],
  },
  {
    id: 'whitespace',
    title: 'Variabili e spazi',
    blocks: [
      {
        type: 'code',
        code: '{%- assign nome = contact.first_name | default: "ciao" -%}\n{%- capture saluto -%}Ciao {{ nome }}{%- endcapture -%}\n{{ saluto }}',
      },
      {
        type: 'p',
        text: '`assign` salva un valore, `capture` salva del testo generato. Un trattino dentro i delimitatori (`{%-`, `-%}`, `{{-`, `-}}`) toglie spazi e a capo intorno al tag, così la logica su righe proprie non lascia righe vuote nell’email.',
      },
    ],
  },
  {
    id: 'fallbacks',
    title: 'Valori di riserva',
    blocks: [
      {
        type: 'p',
        text: '`default` sostituisce un valore mancante, vuoto o falso. I chip dei campi nell’editor hanno un valore di riserva (clic sul chip); il costruttore “Valore di riserva” lo genera per te. L’anteprima dal vivo elenca le variabili vuote per il contatto scelto.',
      },
      { type: 'code', code: 'Ciao {{ contact.first_name | default: "a te" }},' },
    ],
  },
  {
    id: 'recipes',
    title: 'Ricette',
    blocks: [
      { type: 'p', text: 'Saluto con valore di riserva:' },
      { type: 'code', code: 'Ciao {{ contact.first_name | default: "a te" }},' },
      {
        type: 'p',
        text: 'Testo per lingua o genere — non sono campi standard: salvali in un custom field (es. `lingua`, `genere`) e usa una condizione:',
      },
      {
        type: 'code',
        code: '{% case contact.custom.lingua %}\n{% when "it" %}Ciao {{ contact.first_name }}!\n{% when "fr" %}Bonjour {{ contact.first_name }} !\n{% else %}Hello {{ contact.first_name }}!\n{% endcase %}',
      },
      { type: 'p', text: 'Mostrare un blocco solo ai contatti con un tag:' },
      { type: 'code', code: '{% if contact.tags contains "Webinar 2026" %}\nLa registrazione è pronta.\n{% endif %}' },
      { type: 'p', text: 'Prezzo VIP da un custom field:' },
      {
        type: 'code',
        code: '{% if contact.custom.livello_vip == "gold" %}\n  Il tuo prezzo: {{ 100 | times: 0.8 }} €\n{% elsif contact.custom.livello_vip != blank %}\n  Il tuo prezzo: {{ 100 | times: 0.9 }} €\n{% else %}\n  Prezzo: 100 €\n{% endif %}',
      },
      { type: 'p', text: 'Conto alla rovescia verso una data, e la data nel fuso del contatto:' },
      {
        type: 'code',
        code: '{%- assign now_s = "now" | date: "%s" | plus: 0 -%}\n{%- assign end_s = contact.custom.data_rinnovo | date: "%s" | plus: 0 -%}\n{%- assign giorni = end_s | minus: now_s | divided_by: 86400 -%}\n{% if giorni > 0 %}Il piano si rinnova tra {{ giorni }} giorni, il {{ contact.custom.data_rinnovo | date: "%d/%m/%Y", contact.time_zone }}.{% endif %}',
      },
      {
        type: 'p',
        text: 'Invito all’azione in base alla fase del ciclo di vita — usa il tag o il custom field dove tieni la fase:',
      },
      {
        type: 'code',
        code: '{% case contact.custom.fase %}\n{% when "lead", "iscritto" %}Inizia la prova gratuita: https://example.com/prova\n{% when "cliente" %}Passa al piano superiore: https://example.com/upgrade\n{% else %}Parla con noi: https://example.com/contatti\n{% endcase %}',
        note: 'In un’email link e bottoni si aggiungono meglio con l’editor (blocco bottone) dentro un blocco condizione; in uno snippet l’HTML viene mostrato come testo.',
      },
    ],
  },
  {
    id: 'sandbox',
    title: 'Limiti del sandbox e sicurezza',
    blocks: [
      {
        type: 'list',
        items: [
          'Niente file e niente rete: `include`, `render` e `layout` non trovano nulla.',
          'Si leggono solo i dati elencati in Campi disponibili; gli interni degli oggetti (`constructor`, `__proto__`) sono invisibili.',
          'I filtri sconosciuti sono errori. Ogni output viene escapato nella parte HTML dell’email (oggetto e testo semplice no), quindi i dati dei contatti non possono mai iniettare markup.',
          'Il Liquid scritto come testo normale nell’editor email resta letterale: inseriscilo con un chip, un blocco condizione, un blocco Liquid grezzo o l’assistente.',
          'L’anteprima maschera i custom field sensibili per i ruoli che non possono leggerli. Gli invii reali usano il valore vero: evita i campi sensibili nelle email.',
          'L’anteprima usa lo stesso sandbox e lo stesso contesto dell’invio (con un link di disiscrizione di esempio); non salva né invia nulla.',
        ],
      },
      { type: 'limits' },
    ],
  },
];

export const LIQUID_GUIDE: Readonly<Record<Locale, readonly GuideSection[]>> = { en, it };
