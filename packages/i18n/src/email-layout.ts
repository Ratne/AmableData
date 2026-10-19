/**
 * Shared HTML layout of every transactional email (installation system emails and
 * the cloud portal): the look of the app's sign-in card. Table based with inline
 * styles, since email clients ignore stylesheets; every block also has a plain-text
 * rendering so `html` and `text` always say the same thing.
 */

export type EmailBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'action'; readonly label: string; readonly url: string }
  | { readonly type: 'details'; readonly rows: readonly (readonly [string, string])[] }
  | { readonly type: 'notice'; readonly text: string };

export interface EmailLayoutInput {
  readonly lang: string;
  /** Heading of the card (usually the subject). */
  readonly title: string;
  /** Inbox preview line. */
  readonly preheader?: string;
  readonly blocks: readonly EmailBlock[];
  /** Small print under the card content. */
  readonly footer?: string;
  /** Absolute URL of the square logo; without it only the wordmark shows. */
  readonly logoUrl?: string;
}

export interface EmailLayoutOutput {
  readonly html: string;
  readonly text: string;
}

const COLORS = {
  page: '#f4f4f5',
  card: '#ffffff',
  border: '#e7e7e7',
  text: '#161616',
  muted: '#5c5c5c',
  brand: '#2563eb',
  brandText: '#f9fbff',
  subtle: '#f3f3f3',
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const multiline = (value: string) => escapeHtml(value).replace(/\n/g, '<br>');

function blockHtml(block: EmailBlock): string {
  switch (block.type) {
    case 'paragraph':
      return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${COLORS.text}">${multiline(block.text)}</p>`;
    case 'code':
      return `<p style="margin:0 0 16px;padding:14px 16px;background:${COLORS.subtle};border-radius:10px;font-family:${MONO};font-size:28px;line-height:34px;letter-spacing:6px;font-weight:700;color:${COLORS.text};text-align:center">${escapeHtml(block.value)}</p>`;
    case 'action':
      return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:10px;background:${COLORS.brand}"><a href="${escapeHtml(block.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;line-height:20px;color:${COLORS.brandText};text-decoration:none;border-radius:10px">${escapeHtml(block.label)}</a></td></tr></table>`;
    case 'details':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid ${COLORS.border};border-radius:10px;border-collapse:separate">${block.rows
        .map(
          ([label, value], i) =>
            `<tr><td style="padding:10px 14px;font-size:14px;color:${COLORS.muted};${i > 0 ? `border-top:1px solid ${COLORS.border};` : ''}">${escapeHtml(label)}</td><td align="right" style="padding:10px 14px;font-size:14px;font-weight:600;color:${COLORS.text};${i > 0 ? `border-top:1px solid ${COLORS.border};` : ''}">${multiline(value)}</td></tr>`,
        )
        .join('')}</table>`;
    case 'notice':
      return `<p style="margin:0 0 16px;padding:12px 14px;background:${COLORS.subtle};border-radius:10px;font-size:14px;line-height:21px;color:${COLORS.text}">${multiline(block.text)}</p>`;
  }
}

function blockText(block: EmailBlock): string {
  switch (block.type) {
    case 'paragraph':
    case 'notice':
      return block.text;
    case 'code':
      return block.value;
    case 'action':
      return `${block.label}: ${block.url}`;
    case 'details':
      return block.rows.map(([label, value]) => `${label}: ${value}`).join('\n');
  }
}

export function renderEmailLayout(input: EmailLayoutInput): EmailLayoutOutput {
  const logo =
    input.logoUrl === undefined
      ? ''
      : `<td style="padding-right:8px;vertical-align:middle"><img src="${escapeHtml(input.logoUrl)}" width="24" height="24" alt="" style="display:block;border:0;width:24px;height:24px"></td>`;
  const header = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>${logo}<td style="vertical-align:middle;font-size:12px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:${COLORS.muted}">amabledata</td></tr></table>`;
  const title = `<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:${COLORS.text}">${escapeHtml(input.title)}</h1>`;
  const footer =
    input.footer === undefined
      ? ''
      : `<p style="margin:8px 0 0;padding-top:16px;border-top:1px solid ${COLORS.border};font-size:12px;line-height:18px;color:${COLORS.muted}">${multiline(input.footer)}</p>`;
  const preheader =
    input.preheader === undefined
      ? ''
      : `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div>`;
  const html = `<!doctype html><html lang="${escapeHtml(input.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(input.title)}</title></head><body style="margin:0;padding:0;background:${COLORS.page};font-family:${FONT};color:${COLORS.text}">${preheader}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page}"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${COLORS.card};border:1px solid ${COLORS.border};border-radius:14px"><tr><td style="padding:32px">${header}${title}${input.blocks.map(blockHtml).join('')}${footer}</td></tr></table></td></tr></table></body></html>`;
  const text = [input.title, ...input.blocks.map(blockText), ...(input.footer === undefined ? [] : [input.footer])].join('\n\n');
  return { html, text: `${text}\n` };
}
