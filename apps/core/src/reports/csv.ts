import type { MeasureKind, ReportResult } from '@amable/api-types/reports';

/**
 * CSV export of report results: RFC 4180 quoting, UTF-8 with BOM (spreadsheet
 * friendly), text cells that a spreadsheet would run as a formula are
 * prefixed with `'`. Money is written in major units with the currency in its
 * own column; ratios as decimals.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: ReadonlyArray<string | number | null>): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

const digitsCache = new Map<string, number>();

/** Minor-unit digits of an ISO currency (EUR 2, JPY 0, …). */
export function currencyDigits(currency: string): number {
  let digits = digitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits =
        new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
          .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    digitsCache.set(currency, digits);
  }
  return digits;
}

/** Integer minor units → decimal string in major units (exact, no float rounding). */
export function formatMinor(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (digits === 0) return String(minor);
  const negative = minor < 0;
  const abs = String(Math.abs(minor)).padStart(digits + 1, '0');
  const text = `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  return negative ? `-${text}` : text;
}

function measureCell(
  kind: MeasureKind,
  value: number | null | undefined,
  currency: string | null,
): string | number | null {
  if (value === null || value === undefined) return null;
  if (kind === 'money' && currency !== null) return formatMinor(value, currency);
  return value;
}

export function csvHeader(result: ReportResult): string[] {
  const header = [result.dimension ?? 'total'];
  for (const m of result.measures) header.push(m.key);
  if (result.compare !== null) for (const m of result.measures) header.push(`${m.key}_previous`);
  if (result.measures.some((m) => m.kind === 'money')) header.push('currency');
  return header;
}

/** Data lines of one result page (the header is written once by the caller). */
export function csvRows(
  result: ReportResult,
  includeTotals: boolean,
): Array<Array<string | number | null>> {
  const money = result.measures.some((m) => m.kind === 'money');
  const lines: Array<Array<string | number | null>> = [];
  const push = (
    label: string,
    values: ReportResult['totals'],
    previous: ReportResult['totals'] | undefined,
  ) => {
    const line: Array<string | number | null> = [label];
    for (const m of result.measures) line.push(measureCell(m.kind, values[m.key], result.currency));
    if (result.compare !== null) {
      for (const m of result.measures)
        line.push(measureCell(m.kind, previous?.[m.key], result.currency));
    }
    if (money) line.push(result.currency);
    lines.push(line);
  };
  result.rows.forEach((row, i) => push(row.label, row.values, result.compare?.rows[i]?.values));
  if (includeTotals) push('Total', result.totals, result.compare?.totals);
  return lines;
}

/**
 * Streams the header then every page produced by `pages` (pulled lazily, so a
 * large export never sits in memory and stops when the client disconnects).
 */
export function csvStream(
  header: readonly string[],
  pages: AsyncIterator<Array<Array<string | number | null>>>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let started = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(`\uFEFF${csvLine(header)}`));
          return;
        }
        try {
          const next = await pages.next();
          if (next.done === true) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(next.value.map(csvLine).join('')));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await pages.return?.();
      },
    },
    // Pull only when the consumer reads: no page is fetched ahead of the client.
    { highWaterMark: 0 },
  );
}
