import type { EmailSendRequest } from '@amable/core';
import type { EsignLocale } from '@amable/esign';
import { textToDoc } from '../booking/messages';
import type { EsignMail } from './due';

/**
 * Signer emails (invitation, reminder, completed, confirmation code) as inline
 * transactional `EmailSendRequest`s to the exact address the document was
 * sent to (`toEmail`). `{{ esign.* }}` variables are filled here; contact
 * Liquid (`{{ contact.first_name }}` …) is left to the email pipeline.
 */

type Kind = EsignMail['kind'] | 'otp';

const DEFAULTS: Record<EsignLocale, Record<Kind, { subject: string; body: string }>> = {
  en: {
    invite: {
      subject: '{{ esign.sender }} sent you "{{ esign.document }}" to sign',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\n{{ esign.sender }} asks you to sign "{{ esign.document }}" as {{ esign.party }}.\n\n{{ esign.message }}\n\nReview and sign: {{ esign.url }}\n\n{{ esign.deadline }}',
    },
    reminder: {
      subject: 'Reminder: "{{ esign.document }}" is waiting for your signature',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\n"{{ esign.document }}" from {{ esign.sender }} is still waiting for your signature.\n\nReview and sign: {{ esign.url }}\n\n{{ esign.deadline }}',
    },
    completed: {
      subject: 'Signed: "{{ esign.document }}"',
      body: 'Hi {{ contact.first_name | default: "there" }},\n\nevery party signed "{{ esign.document }}". Download your copy of the signed document, with its audit trail, here: {{ esign.url }}',
    },
    otp: {
      subject: '{{ esign.code }} is your code to sign "{{ esign.document }}"',
      body: 'Your confirmation code is {{ esign.code }}.\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.',
    },
  },
  it: {
    invite: {
      subject: '{{ esign.sender }} ti ha inviato "{{ esign.document }}" da firmare',
      body: 'Ciao{{ esign.greeting_name }},\n\n{{ esign.sender }} ti chiede di firmare "{{ esign.document }}" come {{ esign.party }}.\n\n{{ esign.message }}\n\nVisualizza e firma: {{ esign.url }}\n\n{{ esign.deadline }}',
    },
    reminder: {
      subject: 'Promemoria: "{{ esign.document }}" attende la tua firma',
      body: 'Ciao{{ esign.greeting_name }},\n\n"{{ esign.document }}" di {{ esign.sender }} attende ancora la tua firma.\n\nVisualizza e firma: {{ esign.url }}\n\n{{ esign.deadline }}',
    },
    completed: {
      subject: 'Firmato: "{{ esign.document }}"',
      body: 'Ciao{{ esign.greeting_name }},\n\ntutte le parti hanno firmato "{{ esign.document }}". Scarica qui la tua copia del documento firmato, con la traccia di audit: {{ esign.url }}',
    },
    otp: {
      subject: '{{ esign.code }} è il codice per firmare "{{ esign.document }}"',
      body: 'Il tuo codice di conferma è {{ esign.code }}.\n\nScade tra 10 minuti. Se non l’hai richiesto, ignora questa email.',
    },
  },
};

const DEADLINE: Record<EsignLocale, string> = {
  en: 'Please sign before {date}.',
  it: 'Firma entro il {date}.',
};

export function fillEsignVars(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(
    /\{\{\s*esign\.([a-z_]+)\s*\}\}/g,
    (_match, key: string) => values[key] ?? '',
  );
}

function formatDeadline(locale: EsignLocale, expiresAt: number, timeZone: string): string {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(expiresAt);
}

/** Deadline in the signer's (else the workspace's) time zone, with the hour: near midnight the day alone misleads. */
function deadline(locale: EsignLocale, expiresAt: number | null, timeZone: string): string {
  if (expiresAt === null) return '';
  let date: string;
  try {
    date = formatDeadline(locale, expiresAt, timeZone);
  } catch {
    date = formatDeadline(locale, expiresAt, 'UTC');
  }
  return DEADLINE[locale].replace('{date}', date);
}

/** Collapses the blank paragraphs left by empty variables (no message, no deadline). */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export interface EsignEmailInput {
  id: string;
  tenantId: string;
  senderName: string;
  kind: Kind;
  mail: Pick<
    EsignMail,
    | 'contactId'
    | 'email'
    | 'partyName'
    | 'requestName'
    | 'message'
    | 'subject'
    | 'locale'
    | 'expiresAt'
    | 'requestId'
  > & { timeZone?: string | null; firstName?: string | null };
  /** Workspace time zone, used when the signer's contact has none. */
  tenantTimeZone?: string;
  url: string;
  code?: string;
  now: number;
}

export function esignEmail(
  input: EsignEmailInput & { mail: { contactId: string } },
): EmailSendRequest {
  const template = DEFAULTS[input.mail.locale][input.kind];
  const values: Record<string, string> = {
    sender: input.senderName,
    document: input.mail.requestName,
    party: input.mail.partyName,
    url: input.url,
    deadline: deadline(
      input.mail.locale,
      input.mail.expiresAt,
      input.mail.timeZone ?? input.tenantTimeZone ?? 'UTC',
    ),
    code: input.code ?? '',
    // Braces would turn the name into Liquid once the body reaches the email pipeline.
    greeting_name:
      input.mail.firstName == null ? '' : ` ${input.mail.firstName.replace(/[{}%]/g, '')}`,
  };
  values['message'] = fillEsignVars(input.mail.message, values);
  const subject =
    input.kind === 'invite' && input.mail.subject.trim() !== ''
      ? input.mail.subject
      : template.subject;
  return {
    kind: 'email.send',
    version: 1,
    id: input.id,
    tenantId: input.tenantId,
    contactId: input.mail.contactId,
    toEmail: input.mail.email,
    content: {
      templateId: null,
      subject: fillEsignVars(subject, values).slice(0, 300),
      preheader: null,
      body: textToDoc(tidy(fillEsignVars(template.body, values))),
      fromName: null,
      replyTo: null,
    },
    source: {
      type: 'transactional',
      purpose: 'esign',
      referenceId: input.mail.requestId,
      userId: null,
    },
    requestedAt: new Date(input.now).toISOString(),
    // Codes expire after 10 minutes: a late email is useless.
    notAfter: input.kind === 'otp' ? new Date(input.now + 10 * 60_000).toISOString() : null,
  };
}
