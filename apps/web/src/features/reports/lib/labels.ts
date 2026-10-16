import type { MessageKey } from '@amable/i18n';
import type { ReportCatalogEntry } from '@amable/api-types/reports';

type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

/**
 * Translation of a key built at runtime (measure, dimension, source, built-in
 * report): the catalog returns nothing for unknown keys, so fall back to the
 * server-provided text or the raw key.
 */
export function dynamicLabel(t: Translate, key: string, fallback: string): string {
  const text: string | undefined = t(key as MessageKey);
  return typeof text === 'string' && text !== '' ? text : fallback;
}

export function measureLabel(t: Translate, measure: string): string {
  return dynamicLabel(t, `rep.measure.${measure}`, measure);
}

export function dimensionLabel(t: Translate, dimension: string): string {
  return dynamicLabel(t, `rep.dimension.${dimension}`, dimension);
}

export function sourceLabel(t: Translate, source: string): string {
  return dynamicLabel(t, `rep.source.${source}`, source);
}

export function paramLabel(t: Translate, param: string): string {
  return dynamicLabel(t, `rep.param.${param}`, param);
}

/** Choice label of a source parameter (attribution models are translated, sites keep their name). */
export function optionLabel(t: Translate, param: string, value: string, label: string): string {
  return param === 'model' ? dynamicLabel(t, `rep.model.${value}`, label) : label;
}

export function reportName(
  t: Translate,
  entry: Pick<ReportCatalogEntry, 'id' | 'kind' | 'name'>,
): string {
  return entry.kind === 'builtin'
    ? dynamicLabel(t, `rep.builtin.${entry.id}`, entry.name)
    : entry.name;
}

export function reportDescription(
  t: Translate,
  entry: Pick<ReportCatalogEntry, 'id' | 'kind' | 'description'>,
): string {
  return entry.kind === 'builtin'
    ? dynamicLabel(t, `rep.builtin.${entry.id}.desc`, entry.description)
    : entry.description;
}
