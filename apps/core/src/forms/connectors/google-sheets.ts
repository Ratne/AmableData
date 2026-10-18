import { googleSheetsConfigSchema, type GoogleSheetsConfig } from '@amable/api-types';
import { safeFetch } from '@amable/auth/security';
import { parseServiceAccountKey, serviceAccountToken } from './google-service-account';
import { mergeContext, valueFields, zodConfig } from './merge';
import { failure, httpResult, type Connector, type ConnectorContext } from './types';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** "A" → 0, "AB" → 27. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Spreadsheet formula injection: values starting with = + - @ are stored as text. */
export function sheetCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function sheetRow(ctx: ConnectorContext<GoogleSheetsConfig>): string[] {
  const context = mergeContext(ctx);
  const config = ctx.connection.config;
  if (config.columns.length === 0) {
    return [
      context['submitted_at'] ?? '',
      ...valueFields(ctx.form.fields, ctx.submission.values).map((f) => context[f.key] ?? ''),
    ].map(sheetCell);
  }
  const width = Math.max(...config.columns.map((c) => columnIndex(c.column))) + 1;
  const row = Array.from({ length: width }, () => '');
  for (const column of config.columns) row[columnIndex(column.column)] = sheetCell(context[column.source] ?? '');
  return row;
}

/**
 * Appends one row per submission as a Google service account: the workspace
 * uploads the account's JSON key (stored encrypted as the connection secret)
 * and shares the spreadsheet with the account's email as Editor.
 */
export const googleSheetsConnector: Connector<GoogleSheetsConfig> = {
  type: 'google_sheets',
  secret: 'api_key',
  oauthProvider: null,
  available: () => true,
  checkSecret(secret) {
    const parsed = parseServiceAccountKey(secret);
    return parsed.ok ? { ok: true, hint: parsed.key.clientEmail } : parsed;
  },
  parseConfig: zodConfig(googleSheetsConfigSchema),
  async run(ctx) {
    const config = ctx.connection.config;
    const request = `POST ${SHEETS_API}/${config.spreadsheet_id}/values:append (${config.sheet_name})`;
    const parsed = ctx.connection.secret === null ? null : parseServiceAccountKey(ctx.connection.secret);
    if (parsed === null) return failure('add the service account key in the connection', false, request);
    if (!parsed.ok) return failure(parsed.message, false, request);
    const fetchFn = (input: string, init?: RequestInit) => ctx.runtime.fetch(input, init);
    const token = await serviceAccountToken(parsed.key, { fetch: fetchFn, nowMs: Date.now() });
    if (!token.ok) return failure(token.message, token.retryable, request);
    const range = encodeURIComponent(`'${config.sheet_name.replace(/'/g, "''")}'!A1`);
    const url = `${SHEETS_API}/${encodeURIComponent(config.spreadsheet_id)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    try {
      const response = await safeFetch(
        url,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ values: [sheetRow(ctx)] }),
        },
        { fetchFn, timeoutMs: 10_000, maxBytes: 64 * 1024 },
      );
      const body = new TextDecoder().decode(response.body);
      if (response.status === 403) {
        return failure(`share the spreadsheet with ${parsed.key.clientEmail} as Editor (Google answered 403)`, false, request);
      }
      if (response.status === 404) {
        return failure('spreadsheet not found: check its id (Google answered 404)', false, request);
      }
      if (response.status === 400 && body.includes('Unable to parse range')) {
        return failure(`no sheet named "${config.sheet_name}" in the spreadsheet`, false, request);
      }
      return httpResult(response.status, request, body);
    } catch (error) {
      return failure(`request failed: ${error instanceof Error ? error.message : String(error)}`, true, request);
    }
  },
};
