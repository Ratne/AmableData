import type { Locale } from './index';

/**
 * System (transactional) email templates in English and Italian.
 *
 * Every template yields subject + HTML + plain text. Variables are HTML-escaped
 * in the HTML part. The layout is intentionally minimal; when
 * packages/email-render ships, `renderSystemEmail` keeps its signature and
 * swaps the layout.
 */

export interface SystemEmailVars {
  magic_link: { url: string; minutes: number };
  email_code: { code: string; minutes: number };
  password_reset: { url: string };
  password_changed: Record<string, never>;
  new_device: { device: string; location: string; time: string };
  mfa_changed: { method: string };
  otp_failed: { device: string; time: string };
  account_locked: { until: string };
  invite: { tenant: string; inviter: string; role: string; url: string; days: number };
  role_changed: { tenant: string; role: string };
  email_change_verify: { url: string };
  email_changed: { newEmail: string };
  support_access_started: { tenant: string; staff: string; until: string };
}

export type SystemEmailKind = keyof SystemEmailVars;

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface TemplateCopy {
  subject: string;
  /** Paragraphs; `{var}` placeholders. */
  body: string[];
  /** Optional call to action. */
  action?: { label: string; urlVar: string };
  /** Highlighted value (e.g. the OTP code). */
  highlightVar?: string;
  footer?: string;
}

type Templates = { [K in SystemEmailKind]: TemplateCopy };

const securityFooterEn = 'If this was not you, reset your password and contact your administrator.';
const securityFooterIt = "Se non sei stato tu, reimposta la password e contatta l'amministratore.";

const templates: Record<Locale, Templates> = {
  en: {
    magic_link: {
      subject: 'Your sign-in link',
      body: ['Use the button below to sign in. The link works once and expires in {minutes} minutes.'],
      action: { label: 'Sign in', urlVar: 'url' },
      footer: 'If you did not request this, you can ignore this email.',
    },
    email_code: {
      subject: 'Your verification code: {code}',
      body: ['Your verification code is below. It expires in {minutes} minutes.'],
      highlightVar: 'code',
      footer: 'Never share this code. We will never ask for it.',
    },
    password_reset: {
      subject: 'Reset your password',
      body: ['Someone asked to reset the password of your account. The link expires in 1 hour and works once.'],
      action: { label: 'Choose a new password', urlVar: 'url' },
      footer: 'If you did not request this, ignore this email: your password stays the same.',
    },
    password_changed: {
      subject: 'Your password was changed',
      body: ['The password of your account was just changed and every other session was signed out.'],
      footer: securityFooterEn,
    },
    new_device: {
      subject: 'New sign-in to your account',
      body: ['We noticed a new sign-in: {device}, {location}, at {time}.'],
      footer: securityFooterEn,
    },
    mfa_changed: {
      subject: 'Two-factor authentication updated',
      body: ['Your two-factor authentication settings changed (method: {method}).'],
      footer: securityFooterEn,
    },
    otp_failed: {
      subject: 'Failed sign-in attempt',
      body: [
        'A sign-in to your account was cancelled after 3 wrong verification codes ({device}, {time}).',
        'Your password was entered correctly: consider changing it.',
      ],
      footer: securityFooterEn,
    },
    account_locked: {
      subject: 'Your account is temporarily locked',
      body: ['After repeated failed verifications your account is locked until {until}.'],
      footer: securityFooterEn,
    },
    invite: {
      subject: '{inviter} invited you to {tenant}',
      body: ['{inviter} invited you to join {tenant} as {role}. The invitation is valid for {days} days.'],
      action: { label: 'Accept invitation', urlVar: 'url' },
    },
    role_changed: {
      subject: 'Your role in {tenant} changed',
      body: ['Your role in {tenant} is now {role}.'],
    },
    email_change_verify: {
      subject: 'Confirm your new email address',
      body: ['Confirm this address to make it the sign-in email of your account. The link expires in 1 hour.'],
      action: { label: 'Confirm email', urlVar: 'url' },
    },
    email_changed: {
      subject: 'Your sign-in email was changed',
      body: ['The sign-in email of your account was changed to {newEmail}.'],
      footer: securityFooterEn,
    },
    support_access_started: {
      subject: 'Support is now accessing {tenant}',
      body: [
        '{staff} from amabledata support just entered {tenant} through the assisted access you granted.',
        'Access ends at {until} at the latest. You can revoke it at any time from the Support page.',
      ],
      footer: 'If nobody in your team asked for support, revoke the access now.',
    },
  },
  it: {
    magic_link: {
      subject: 'Il tuo link di accesso',
      body: ['Usa il pulsante qui sotto per accedere. Il link vale una sola volta e scade tra {minutes} minuti.'],
      action: { label: 'Accedi', urlVar: 'url' },
      footer: 'Se non hai richiesto tu questo link, ignora questa email.',
    },
    email_code: {
      subject: 'Il tuo codice di verifica: {code}',
      body: ['Ecco il tuo codice di verifica. Scade tra {minutes} minuti.'],
      highlightVar: 'code',
      footer: 'Non condividere mai questo codice. Non te lo chiederemo mai.',
    },
    password_reset: {
      subject: 'Reimposta la password',
      body: ["È stato chiesto il reset della password del tuo account. Il link scade dopo 1 ora e vale una sola volta."],
      action: { label: 'Scegli una nuova password', urlVar: 'url' },
      footer: 'Se non sei stato tu, ignora questa email: la password resta invariata.',
    },
    password_changed: {
      subject: 'La tua password è stata cambiata',
      body: ['La password del tuo account è appena stata cambiata e tutte le altre sessioni sono state chiuse.'],
      footer: securityFooterIt,
    },
    new_device: {
      subject: 'Nuovo accesso al tuo account',
      body: ['Abbiamo rilevato un nuovo accesso: {device}, {location}, alle {time}.'],
      footer: securityFooterIt,
    },
    mfa_changed: {
      subject: 'Verifica in due passaggi aggiornata',
      body: ['Le impostazioni della verifica in due passaggi sono cambiate (metodo: {method}).'],
      footer: securityFooterIt,
    },
    otp_failed: {
      subject: 'Tentativo di accesso fallito',
      body: [
        "Un accesso al tuo account è stato annullato dopo 3 codici di verifica errati ({device}, {time}).",
        'La password era corretta: valuta di cambiarla.',
      ],
      footer: securityFooterIt,
    },
    account_locked: {
      subject: 'Il tuo account è temporaneamente bloccato',
      body: ['Dopo ripetute verifiche fallite il tuo account è bloccato fino alle {until}.'],
      footer: securityFooterIt,
    },
    invite: {
      subject: '{inviter} ti ha invitato in {tenant}',
      body: ["{inviter} ti ha invitato in {tenant} con il ruolo {role}. L'invito è valido {days} giorni."],
      action: { label: 'Accetta invito', urlVar: 'url' },
    },
    role_changed: {
      subject: 'Il tuo ruolo in {tenant} è cambiato',
      body: ['Il tuo ruolo in {tenant} ora è {role}.'],
    },
    email_change_verify: {
      subject: 'Conferma il nuovo indirizzo email',
      body: ["Conferma questo indirizzo per usarlo come email di accesso. Il link scade dopo 1 ora."],
      action: { label: 'Conferma email', urlVar: 'url' },
    },
    email_changed: {
      subject: "L'email di accesso è stata cambiata",
      body: ["L'email di accesso del tuo account è stata cambiata in {newEmail}."],
      footer: securityFooterIt,
    },
    support_access_started: {
      subject: 'Il supporto sta accedendo a {tenant}',
      body: [
        "{staff} del supporto amabledata è appena entrato in {tenant} con l'accesso assistito che hai concesso.",
        "L'accesso termina al più tardi alle {until}. Puoi revocarlo in qualsiasi momento dalla pagina Supporto.",
      ],
      footer: "Se nessuno del tuo team ha chiesto supporto, revoca subito l'accesso.",
    },
  },
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fill(template: string, vars: Record<string, string | number>, html: boolean): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) return match;
    return html ? escapeHtml(String(value)) : String(value);
  });
}

export function renderSystemEmail<K extends SystemEmailKind>(
  kind: K,
  locale: Locale,
  vars: SystemEmailVars[K],
): RenderedEmail {
  const copy = templates[locale][kind];
  const values = vars as Record<string, string | number>;
  const subject = fill(copy.subject, values, false);

  const textParts = copy.body.map((p) => fill(p, values, false));
  const htmlParts = copy.body.map(
    (p) => `<p style="margin:0 0 16px;font-size:15px;line-height:22px">${fill(p, values, true)}</p>`,
  );
  if (copy.highlightVar !== undefined) {
    const value = String(values[copy.highlightVar] ?? '');
    textParts.push(value);
    htmlParts.push(
      `<p style="margin:0 0 16px;font-size:28px;letter-spacing:6px;font-weight:700;font-family:monospace">${escapeHtml(value)}</p>`,
    );
  }
  if (copy.action !== undefined) {
    const url = String(values[copy.action.urlVar] ?? '');
    textParts.push(`${copy.action.label}: ${url}`);
    htmlParts.push(
      `<p style="margin:0 0 16px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(copy.action.label)}</a></p>`,
    );
  }
  if (copy.footer !== undefined) {
    textParts.push(copy.footer);
    htmlParts.push(
      `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${escapeHtml(copy.footer)}</p>`,
    );
  }

  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:32px"><tr><td><p style="margin:0 0 24px;font-weight:700">amabledata</p>${htmlParts.join('')}</td></tr></table></td></tr></table></body></html>`;

  return { subject, html, text: `${textParts.join('\n\n')}\n` };
}
