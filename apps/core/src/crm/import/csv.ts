/**
 * Incremental RFC 4180 CSV parser: feed it chunks as they stream in, get back
 * the rows completed so far. Handles quoted fields, escaped quotes (""),
 * delimiters/newlines inside quotes, CRLF and a leading BOM; quotes or CRLF
 * split across chunk boundaries are handled by carrying state.
 */
export class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private quotePending = false;
  private fieldStarted = false;
  private atStart = true;

  constructor(
    private readonly delimiter = ',',
    private readonly limits = { maxFieldLength: 100_000, maxColumns: 500 },
  ) {}

  push(chunk: string): string[][] {
    const rows: string[][] = [];
    let text = chunk;
    if (this.atStart) {
      if (text.length === 0) return rows;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.atStart = false;
    }
    for (const char of text) {
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          if (char === '"') {
            this.append('"');
            continue;
          }
          this.inQuotes = false;
          // fall through: the char is processed as unquoted
        } else if (char === '"') {
          this.quotePending = true;
          continue;
        } else {
          this.append(char);
          continue;
        }
      }
      if (char === '"' && !this.fieldStarted) {
        this.inQuotes = true;
        this.fieldStarted = true;
      } else if (char === this.delimiter) {
        this.endField();
      } else if (char === '\n') {
        this.endRow(rows);
      } else if (char === '\r') {
        // CR of CRLF (or a lone CR) — ignored; LF ends the row.
      } else {
        this.append(char);
      }
    }
    return rows;
  }

  /** Flushes the last row when the stream ends. */
  finish(): string[][] {
    const rows: string[][] = [];
    if (this.quotePending) {
      this.quotePending = false;
      this.inQuotes = false;
    }
    if (this.fieldStarted || this.row.length > 0) this.endRow(rows);
    return rows;
  }

  private append(char: string): void {
    this.fieldStarted = true;
    if (this.field.length >= this.limits.maxFieldLength) {
      throw new Error(`CSV field longer than ${this.limits.maxFieldLength} characters`);
    }
    this.field += char;
  }

  private endField(): void {
    if (this.row.length >= this.limits.maxColumns) {
      throw new Error(`CSV row with more than ${this.limits.maxColumns} columns`);
    }
    this.row.push(this.field);
    this.field = '';
    this.fieldStarted = false;
  }

  private endRow(rows: string[][]): void {
    this.endField();
    const isBlank = this.row.length === 1 && this.row[0] === '';
    if (!isBlank) rows.push(this.row);
    this.row = [];
  }
}

/** Parses a whole CSV string (tests, small payloads). */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const parser = new CsvParser(delimiter);
  return [...parser.push(text), ...parser.finish()];
}

/** Picks `;` when the header line has more semicolons than commas (EU exports). */
export function detectDelimiter(firstLine: string): ',' | ';' | '\t' {
  const count = (c: string): number => firstLine.split(c).length - 1;
  const tabs = count('\t');
  const semis = count(';');
  const commas = count(',');
  if (tabs > commas && tabs > semis) return '\t';
  return semis > commas ? ';' : ',';
}
