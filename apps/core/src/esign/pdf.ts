import type { EsignEvent, EsignField } from '@amable/api-types';
import {
  degrees,
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { displayedSize, pageBox, type PageBox } from './pdf-inspect';
import {
  fieldsOf,
  isImageValue,
  partiesOf,
  valuesOf,
  type FieldValue,
  type RequestRow,
  type SignerRow,
  type TenantFacts,
} from './model';

/**
 * Seals a completed request: every value drawn on the original pages
 * (signatures and pictures as images, text with Helvetica), then the
 * signature certificate appended: document hashes, signers with their
 * consent, IP, browser and confirmation, and the full event log.
 */

type Locale = 'en' | 'it';

const EN_LABELS = {
  title: 'Signature certificate',
  document: 'Document',
  request: 'Request ID',
  sender: 'Sent by',
  originalHash: 'Original document SHA-256',
  created: 'Sent',
  completed: 'Completed',
  pages: 'Pages',
  signers: 'Signers',
  party: 'Party',
  email: 'Email',
  signedAt: 'Signed',
  ip: 'IP address',
  country: 'Country',
  userAgent: 'Browser',
  device: 'Device',
  timeZone: 'Time zone',
  emailCheck: 'Email confirmed with code',
  linkOnly: 'Signing link sent to the email address',
  consent: 'Consent',
  events: 'Event log (UTC)',
  note: 'Times are UTC. The SHA-256 of this sealed file is recorded in the request audit trail; any change to the file changes it.',
  signature: 'Signature',
};
type Labels = Record<keyof typeof EN_LABELS, string>;
const IT_LABELS: Labels = {
  title: 'Certificato di firma',
  document: 'Documento',
  request: 'ID richiesta',
  sender: 'Inviato da',
  originalHash: 'SHA-256 del documento originale',
  created: 'Inviato',
  completed: 'Completato',
  pages: 'Pagine',
  signers: 'Firmatari',
  party: 'Parte',
  email: 'Email',
  signedAt: 'Firmato',
  ip: 'Indirizzo IP',
  country: 'Paese',
  userAgent: 'Browser',
  device: 'Dispositivo',
  timeZone: 'Fuso orario',
  emailCheck: 'Email confermata con codice',
  linkOnly: 'Link di firma inviato all’indirizzo email',
  consent: 'Consenso',
  events: 'Registro eventi (UTC)',
  note: 'Orari in UTC. Lo SHA-256 di questo file sigillato è registrato nella traccia di audit della richiesta; qualsiasi modifica al file lo cambia.',
  signature: 'Firma',
};
const LABELS: Record<Locale, Labels> = { en: EN_LABELS, it: IT_LABELS };

const EVENT_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    created: 'Request created',
    sent: 'Invitation emailed',
    reminder_requested: 'Reminder requested',
    reminder_sent: 'Reminder emailed',
    notify_failed: 'Email not sent',
    link_copied: 'Link copied by sender',
    opened: 'Document opened',
    otp_sent: 'Code emailed',
    otp_failed: 'Wrong code',
    otp_verified: 'Email confirmed',
    consent_given: 'Consent given',
    signed: 'Signed',
    declined: 'Declined',
    completed: 'Completed',
    document_sealed: 'Document sealed',
    voided: 'Voided',
    expired: 'Expired',
    downloaded: 'Downloaded',
    link_rotated: 'Link renewed',
  },
  it: {
    created: 'Richiesta creata',
    sent: 'Invito inviato via email',
    reminder_requested: 'Promemoria richiesto',
    reminder_sent: 'Promemoria inviato via email',
    notify_failed: 'Email non inviata',
    link_copied: 'Link copiato dal mittente',
    opened: 'Documento aperto',
    otp_sent: 'Codice inviato via email',
    otp_failed: 'Codice errato',
    otp_verified: 'Email confermata',
    consent_given: 'Consenso dato',
    signed: 'Firmato',
    declined: 'Rifiutato',
    completed: 'Completato',
    document_sealed: 'Documento sigillato',
    voided: 'Annullato',
    expired: 'Scaduto',
    downloaded: 'Scaricato',
    link_rotated: 'Link rinnovato',
  },
};

export type ImageLoader = (key: string) => Promise<Uint8Array | null>;

// ------------------------------------------------------------ text helpers

/** Helvetica only encodes WinAnsi: other characters become `?`. */
function encoder(font: PDFFont): (text: string) => string {
  const cache = new Map<string, string>();
  return (text) =>
    Array.from(text.replace(/[\r\n\t]+/g, ' '))
      .map((ch) => {
        let out = cache.get(ch);
        if (out === undefined) {
          try {
            font.encodeText(ch);
            out = ch;
          } catch {
            out = '?';
          }
          cache.set(ch, out);
        }
        return out;
      })
      .join('');
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

function formatDate(value: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return value;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(ms);
}

const utc = (iso: string | number | null): string => {
  if (iso === null) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? String(iso)
    : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

// ----------------------------------------------------------- field drawing

/** Displayed (top-left origin) point of a page → PDF user space. */
function toUser(box: PageBox, u: number, v: number): { x: number; y: number } {
  const { width: dw, height: dh } = displayedSize(box);
  switch (box.rotation) {
    case 90:
      return { x: box.x + v, y: box.y + u };
    case 180:
      return { x: box.x + (dw - u), y: box.y + v };
    case 270:
      return { x: box.x + box.width - v, y: box.y + box.height - u };
    default:
      return { x: box.x + u, y: box.y + (dh - v) };
  }
}

interface Rect {
  u: number;
  v: number;
  w: number;
  h: number;
}

function rectOf(box: PageBox, field: EsignField): Rect {
  const size = displayedSize(box);
  return {
    u: field.x * size.width,
    v: field.y * size.height,
    w: field.w * size.width,
    h: field.h * size.height,
  };
}

function drawImageIn(page: PDFPage, box: PageBox, rect: Rect, image: PDFImage): void {
  const scale = Math.min(rect.w / image.width, rect.h / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  const u = rect.u + (rect.w - w) / 2;
  const v = rect.v + (rect.h - h) / 2;
  const anchor = toUser(box, u, v + h);
  page.drawImage(image, {
    x: anchor.x,
    y: anchor.y,
    width: w,
    height: h,
    rotate: degrees(box.rotation),
  });
}

function drawTextIn(
  page: PDFPage,
  box: PageBox,
  rect: Rect,
  text: string,
  font: PDFFont,
  center = false,
): void {
  if (text === '') return;
  const pad = Math.min(2, rect.w * 0.05);
  let size = Math.max(6, Math.min(rect.h * 0.7, 12));
  while (size > 6 && font.widthOfTextAtSize(text, size) > rect.w - pad * 2) size -= 0.5;
  let shown = text;
  while (shown.length > 1 && font.widthOfTextAtSize(shown, size) > rect.w - pad * 2)
    shown = `${shown.slice(0, -2)}…`;
  const width = font.widthOfTextAtSize(shown, size);
  const u = center ? rect.u + (rect.w - width) / 2 : rect.u + pad;
  const baseline = rect.v + rect.h / 2 + size * 0.35;
  const anchor = toUser(box, u, baseline);
  page.drawText(shown, {
    x: anchor.x,
    y: anchor.y,
    size,
    font,
    color: rgb(0.05, 0.05, 0.2),
    rotate: degrees(box.rotation),
  });
}

function textValue(field: EsignField, value: FieldValue, locale: Locale): string | null {
  if (isImageValue(value)) return null;
  if (field.type === 'checkbox') return value === true ? 'X' : null;
  if (typeof value !== 'string') return null;
  if (field.type === 'date' || field.type === 'signed_date') return formatDate(value, locale);
  return value;
}

async function embed(doc: PDFDocument, bytes: Uint8Array, type: string): Promise<PDFImage> {
  return type === 'image/jpeg' ? doc.embedJpg(bytes) : doc.embedPng(bytes);
}

// --------------------------------------------------------- certificate

class Writer {
  private page!: PDFPage;
  private y = 0;
  private readonly margin = 48;
  private readonly width = 595.28;
  private readonly height = 841.89;
  readonly safe: (text: string) => string;

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    private readonly header: string,
  ) {
    this.safe = encoder(font);
    this.newPage();
  }

  private newPage(): void {
    this.page = this.doc.addPage([this.width, this.height]);
    this.y = this.height - this.margin;
    this.page.drawText(this.safe(this.header), {
      x: this.margin,
      y: this.y,
      size: 9,
      font: this.font,
      color: rgb(0.45, 0.45, 0.5),
    });
    this.y -= 18;
  }

  private ensure(space: number): void {
    if (this.y - space < this.margin) this.newPage();
  }

  get contentWidth(): number {
    return this.width - this.margin * 2;
  }

  title(text: string): void {
    this.ensure(30);
    this.page.drawText(this.safe(text), {
      x: this.margin,
      y: this.y - 16,
      size: 18,
      font: this.bold,
    });
    this.y -= 30;
  }

  heading(text: string): void {
    this.ensure(28);
    this.y -= 6;
    this.page.drawText(this.safe(text), {
      x: this.margin,
      y: this.y - 11,
      size: 12,
      font: this.bold,
    });
    this.y -= 16;
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.width - this.margin, y: this.y },
      thickness: 0.5,
      color: rgb(0.8, 0.8, 0.85),
    });
    this.y -= 6;
  }

  row(label: string, value: string, options: { size?: number; mono?: boolean } = {}): void {
    const size = options.size ?? 9;
    const labelWidth = 150;
    const lines = wrap(this.safe(value), this.font, size, this.contentWidth - labelWidth);
    this.ensure(lines.length * (size + 3) + 2);
    this.page.drawText(this.safe(label), {
      x: this.margin,
      y: this.y - size,
      size,
      font: this.bold,
      color: rgb(0.3, 0.3, 0.35),
    });
    for (const line of lines) {
      this.page.drawText(line, {
        x: this.margin + labelWidth,
        y: this.y - size,
        size,
        font: this.font,
      });
      this.y -= size + 3;
    }
    this.y -= 2;
  }

  paragraph(text: string, size = 8, color = rgb(0.3, 0.3, 0.35)): void {
    const lines = wrap(this.safe(text), this.font, size, this.contentWidth);
    for (const line of lines) {
      this.ensure(size + 3);
      this.page.drawText(line, { x: this.margin, y: this.y - size, size, font: this.font, color });
      this.y -= size + 3;
    }
    this.y -= 2;
  }

  image(image: PDFImage, maxWidth: number, maxHeight: number): void {
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
    const h = image.height * scale;
    this.ensure(h + 6);
    this.page.drawRectangle({
      x: this.margin + 150,
      y: this.y - h - 4,
      width: image.width * scale + 8,
      height: h + 8,
      borderColor: rgb(0.85, 0.85, 0.9),
      borderWidth: 0.5,
    });
    this.page.drawImage(image, {
      x: this.margin + 154,
      y: this.y - h,
      width: image.width * scale,
      height: h,
    });
    this.y -= h + 12;
  }

  event(cells: [string, string, string, string]): void {
    const size = 7.5;
    const columns = [0, 105, 230, 330];
    const widths = [100, 120, 95, this.contentWidth - 330];
    const wrapped = cells.map((cell, i) => wrap(this.safe(cell), this.font, size, widths[i]!));
    const lines = Math.max(...wrapped.map((w) => w.length));
    this.ensure(lines * (size + 2) + 3);
    wrapped.forEach((cellLines, i) => {
      cellLines.forEach((line, j) => {
        this.page.drawText(line, {
          x: this.margin + columns[i]!,
          y: this.y - size - j * (size + 2),
          size,
          font: this.font,
        });
      });
    });
    this.y -= lines * (size + 2) + 3;
  }
}

function deviceOf(meta: Record<string, unknown>): string {
  const parts = [
    meta['platform'],
    meta['screen'] === undefined ? undefined : `screen ${String(meta['screen'])}`,
    meta['pixel_ratio'] === undefined ? undefined : `@${String(meta['pixel_ratio'])}x`,
    meta['touch_points'] !== undefined && Number(meta['touch_points']) > 0 ? 'touch' : undefined,
  ];
  return (
    parts
      .filter((p) => p !== undefined && p !== '')
      .map(String)
      .join(', ') || '—'
  );
}

export interface SealInput {
  request: RequestRow;
  signers: SignerRow[];
  events: EsignEvent[];
  tenant: TenantFacts | null;
  source: Uint8Array;
  loadImage: ImageLoader;
  now: number;
}

/**
 * Language of the audit pages: the request's, or with `auto` the one most
 * signers saw when they gave consent (ties: the first to sign).
 */
export function certificateLocale(request: RequestRow, events: readonly EsignEvent[]): Locale {
  if (request.locale === 'it' || request.locale === 'en') return request.locale;
  const seen = events
    .filter((e) => e.type === 'consent_given')
    .map((e) => e.meta['locale'])
    .filter((l): l is Locale => l === 'it' || l === 'en');
  if (seen.length === 0) return 'en';
  const it = seen.filter((l) => l === 'it').length;
  const en = seen.length - it;
  return it === en ? seen[0]! : it > en ? 'it' : 'en';
}

export async function sealDocument(input: SealInput): Promise<Uint8Array> {
  const { request } = input;
  const locale = certificateLocale(request, input.events);
  const L = LABELS[locale];
  const doc = await PDFDocument.load(input.source, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const safe = encoder(font);
  const fields = fieldsOf(request.fields);
  const parties = partiesOf(request.parties);
  const pages = doc.getPages();
  const originalPages = pages.length;
  const images = new Map<string, PDFImage>();

  const imageOf = async (key: string, type: string): Promise<PDFImage | null> => {
    const cached = images.get(key);
    if (cached !== undefined) return cached;
    const bytes = await input.loadImage(key);
    if (bytes === null) return null;
    const image = await embed(doc, bytes, type);
    images.set(key, image);
    return image;
  };

  for (const signer of input.signers) {
    if (signer.status !== 'completed') continue;
    const values = valuesOf(signer.field_values);
    for (const field of fields.filter((f) => f.party_id === signer.party_id)) {
      const value = values[field.id];
      const page = pages[field.page];
      if (value === undefined || page === undefined) continue;
      const box = pageBox(page);
      const rect = rectOf(box, field);
      if (isImageValue(value)) {
        const image = await imageOf(value.key, value.content_type);
        if (image !== null) drawImageIn(page, box, rect, image);
        continue;
      }
      const text = textValue(field, value, locale);
      if (text !== null) drawTextIn(page, box, rect, safe(text), font, field.type === 'checkbox');
    }
  }

  // Signature certificate
  const sender = input.tenant?.name ?? '';
  const w = new Writer(doc, font, bold, `${L.title} · ${request.name} · ${request.id}`);
  w.title(L.title);
  w.row(L.document, request.name);
  w.row(L.request, request.id);
  if (sender !== '') w.row(L.sender, sender);
  w.row(L.originalHash, request.source_sha256);
  w.row(L.pages, String(originalPages));
  w.row(L.created, utc(request.created_at));
  w.row(L.completed, utc(request.completed_at));

  w.heading(L.signers);
  for (const signer of input.signers) {
    const events = input.events.filter((e) => e.signer_id === signer.id);
    const signed = events.find((e) => e.type === 'signed');
    const consent = events.find((e) => e.type === 'consent_given');
    const party = parties.find((p) => p.id === signer.party_id)?.name ?? signer.party_name;
    w.row(signer.name === '' ? signer.email : signer.name, '');
    w.row(L.party, party);
    w.row(L.email, signer.email);
    w.row(L.signedAt, utc(signer.completed_at));
    if (signed !== undefined) {
      w.row(L.ip, signed.ip ?? '—');
      w.row(L.country, signed.country ?? '—');
      w.row(L.userAgent, signed.user_agent ?? '—');
      w.row(L.device, deviceOf(signed.meta));
      w.row(
        L.timeZone,
        typeof signed.meta['time_zone'] === 'string' ? signed.meta['time_zone'] : '—',
      );
    }
    w.row(L.emailCheck, signer.otp_verified_at === null ? L.linkOnly : utc(signer.otp_verified_at));
    if (consent !== undefined) {
      const text = typeof consent.meta['text'] === 'string' ? consent.meta['text'] : '';
      w.row(
        L.consent,
        `${utc(consent.occurred_at)} · v${String(consent.meta['version'] ?? '')} · ${text}`,
      );
    }
    // The signature itself, else the initials: never a picture uploaded in an image field.
    const values = valuesOf(signer.field_values);
    const own = fields.filter((f) => f.party_id === signer.party_id);
    const signature = (['signature', 'initials'] as const)
      .flatMap((type) => own.filter((f) => f.type === type).map((f) => values[f.id]))
      .find((v) => isImageValue(v));
    if (signature !== undefined && isImageValue(signature)) {
      const image = await imageOf(signature.key, signature.content_type);
      if (image !== null) {
        w.row(L.signature, `SHA-256 ${signature.sha256} (${signature.method})`);
        w.image(image, 200, 60);
      }
    }
    w.paragraph('');
  }

  w.heading(L.events);
  const names = new Map(input.signers.map((s) => [s.id, s.name === '' ? s.email : s.name]));
  for (const event of input.events) {
    const who =
      event.signer_id === null
        ? event.actor.type === 'system'
          ? 'system'
          : event.actor.type
        : (names.get(event.signer_id) ?? '');
    const where = [event.ip, event.country].filter((p) => p !== null && p !== '').join(' · ');
    w.event([
      utc(event.occurred_at),
      EVENT_LABELS[locale][event.type] ?? event.type,
      who,
      [where, event.user_agent ?? ''].filter((p) => p !== '').join(' — '),
    ]);
  }
  w.paragraph('');
  w.paragraph(L.note);

  doc.setTitle(request.name);
  doc.setSubject(`${L.title} ${request.id}`);
  doc.setProducer('amabledata');
  doc.setCreator('amabledata e-signature');
  doc.setModificationDate(new Date(input.now));
  return doc.save({ useObjectStreams: false });
}
