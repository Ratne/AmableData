import { ESIGN_MAX_PAGES } from '@amable/api-types';
import { PDFDocument, type PDFPage } from 'pdf-lib';

/** Displayed box of a page: crop box clipped to the media box, rotation applied. */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export function pageBox(page: PDFPage): PageBox {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const x = Math.max(crop.x, media.x);
  const y = Math.max(crop.y, media.y);
  const width = Math.max(1, Math.min(crop.x + crop.width, media.x + media.width) - x);
  const height = Math.max(1, Math.min(crop.y + crop.height, media.y + media.height) - y);
  const angle = (((page.getRotation().angle % 360) + 360) % 360) as number;
  const rotation = (
    angle === 90 || angle === 180 || angle === 270 ? angle : 0
  ) as PageBox['rotation'];
  return { x, y, width, height, rotation };
}

/** Width / height as the reader sees the page. */
export function displayedSize(box: PageBox): { width: number; height: number } {
  return box.rotation === 90 || box.rotation === 270
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

export type PdfInspection =
  | { ok: true; pages: Array<{ index: number; width: number; height: number }> }
  | { ok: false; reason: 'encrypted' | 'invalid' | 'too_many_pages' | 'empty' };

const round = (n: number): number => Math.round(n * 100) / 100;

/** Validates an uploaded PDF and reads its page sizes (encrypted or unreadable files are refused). */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && /encrypt/i.test(error.message) ? 'encrypted' : 'invalid',
    };
  }
  if (doc.isEncrypted) return { ok: false, reason: 'encrypted' };
  const count = doc.getPageCount();
  if (count === 0) return { ok: false, reason: 'empty' };
  if (count > ESIGN_MAX_PAGES) return { ok: false, reason: 'too_many_pages' };
  return {
    ok: true,
    pages: doc.getPages().map((page, index) => {
      const size = displayedSize(pageBox(page));
      return { index, width: round(size.width), height: round(size.height) };
    }),
  };
}

export function isPdf(bytes: Uint8Array): boolean {
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
  return head.includes('%PDF-');
}
