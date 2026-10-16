import { googleSheetsConfigSchema, type GoogleSheetsConfig } from '@amable/api-types';
import { safeFetch } from '@amable/auth/security';
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
 * Appends one row per submission. The access token comes from the
 * installation's OAuth service; the dev stub token is never sent to Google
 * (the delivery is recorded as skipped).
 */
export const googleSheetsConnector: Connector<GoogleSheetsConfig> = {
  type: 'google_sheets',
  secret: 'none',
  oauthProvider: 'google',
  available: (runtime) => runtime.oauth.available,
  parseConfig: zodConfig(googleSheetsConfigSchema),
  async run(ctx) {
    const config = ctx.connection.config;
    const token = await ctx.runtime.oauth.getAccessToken({
      tenantId: ctx.tenantId,
      provider: 'google',
      accountId: config.account_id,
    });
    const range = encodeURIComponent(`'${config.sheet_name.replace(/'/g, "''")}'!A1`);
    const url = `${SHEETS_API}/${encodeURIComponent(config.spreadsheet_id)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const request = `POST ${SHEETS_API}/${config.spreadsheet_id}/values:append (${config.sheet_name})`;
    if (token === null) return failure('Google account not connected', false, request);
    if (token.stub) {
      return {
        status: 'skipped',
        retryable: false,
        statusCode: null,
        request,
        response: 'skipped (dev stub): the development OAuth token is never sent to Google',
      };
    }
    try {
      const response = await safeFetch(
        url,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ values: [sheetRow(ctx)] }),
        },
        { fetchFn: (input, init) => ctx.runtime.fetch(input, init), timeoutMs: 10_000, maxBytes: 64 * 1024 },
      );
      return httpResult(response.status, request, new TextDecoder().decode(response.body));
    } catch (error) {
      return failure(`request failed: ${error instanceof Error ? error.message : String(error)}`, true, request);
    }
  },
};
