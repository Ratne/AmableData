import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/**
 * Renders every page of a PDF to an image in the browser, so neither the
 * editor nor the signing page has to parse PDFs: the server stores the
 * images next to the document and serves them as they are. Pages are drawn
 * with their crop box and rotation, the same geometry the server measures.
 */

const TARGET_WIDTH = 1400;
const MAX_SCALE = 3;
const QUALITY = 0.85;

export interface RenderedPage {
  readonly index: number;
  readonly image: Blob;
}

async function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const attempt = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, QUALITY));
  // Browsers without a WebP encoder silently return PNG; JPEG keeps uploads small then.
  const webp = await attempt('image/webp');
  if (webp !== null && webp.type === 'image/webp') return webp;
  const jpeg = await attempt('image/jpeg');
  if (jpeg !== null) return jpeg;
  throw new Error('canvas_encoding_failed');
}

export async function renderPdfPages(
  data: ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<RenderedPage[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  try {
    const doc = await task.promise;
    const pages: RenderedPage[] = [];
    for (let index = 0; index < doc.numPages; index += 1) {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(MAX_SCALE, TARGET_WIDTH / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('canvas_unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pages.push({ index, image: await toBlob(canvas) });
      page.cleanup();
      onProgress?.(index + 1, doc.numPages);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
