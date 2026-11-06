/** Browser downloads through a temporary link. */

export function downloadHref(href: string, filename: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Saves a blob; the object URL is released once the browser has started the download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  downloadHref(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Saves the body of a file response under the name of its `Content-Disposition`. */
export async function downloadResponse(response: Response, fallbackName: string): Promise<void> {
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  downloadBlob(await response.blob(), name);
}
