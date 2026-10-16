import { ROLE_PERMISSIONS, type Permission } from '@amable/core';
import { REPORT_SOURCE_SPECS } from '@amable/api-types/reports';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { reportsEn } from '../../../../packages/i18n/src/catalogs/reports-en';
import { reportsIt } from '../../../../packages/i18n/src/catalogs/reports-it';
import { CsvExportButton } from '../../src/features/reports/components/csv-export-button';
import { canExportReports, exportCsvUrl } from '../../src/features/reports/lib/export';

const canOf = (permissions: readonly Permission[]) => (p: Permission) => permissions.includes(p);

function render(canExport: boolean, href: string | null = '/x.csv'): string {
  return renderToStaticMarkup(
    createElement(CsvExportButton, { canExport, href, label: 'Export CSV' }),
  );
}

describe('CSV export button permission gating', () => {
  it('renders nothing without reports:export', () => {
    expect(render(false)).toBe('');
    expect(render(true, null)).toBe('');
  });

  it('renders a download link with reports:export', () => {
    const html = render(true, '/api/v2/t/demo/reports/sales_monthly/export.csv');
    expect(html).toContain('href="/api/v2/t/demo/reports/sales_monthly/export.csv"');
    expect(html).toContain('download');
    expect(html).toContain('Export CSV');
  });

  it('follows the role map: analysts export, viewers do not', () => {
    expect(canExportReports(canOf(ROLE_PERMISSIONS.analyst))).toBe(true);
    expect(canExportReports(canOf(ROLE_PERMISSIONS.viewer))).toBe(false);
    expect(render(canExportReports(canOf(ROLE_PERMISSIONS.viewer)))).toBe('');
  });

  it('encodes the toolbar overrides in the export URL', () => {
    expect(exportCsvUrl('demo', 'sales_monthly', {})).toBe(
      '/api/v2/t/demo/reports/sales_monthly/export.csv',
    );
    const url = new URL(
      exportCsvUrl('my shop', 'cr 1', {
        compare: 'previous_year',
        date_range: { preset: 'this_year' },
      }),
      'http://localhost',
    );
    expect(url.pathname).toBe('/api/v2/t/my%20shop/reports/cr%201/export.csv');
    expect(JSON.parse(url.searchParams.get('overrides') ?? '')).toEqual({
      compare: 'previous_year',
      date_range: { preset: 'this_year' },
    });
  });
});

describe('report labels', () => {
  it('has en/it labels for every source, measure and dimension of the source specs', () => {
    const keys = new Set<string>();
    for (const [source, spec] of Object.entries(REPORT_SOURCE_SPECS)) {
      keys.add(`rep.source.${source}`);
      for (const m of Object.keys(spec.measures)) keys.add(`rep.measure.${m}`);
      for (const d of spec.dimensions) keys.add(`rep.dimension.${d}`);
      for (const p of spec.params ?? []) keys.add(`rep.param.${p}`);
    }
    const missing = [...keys].filter((k) => !(k in reportsEn) || !(k in reportsIt));
    expect(missing).toEqual([]);
  });
});
