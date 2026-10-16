import { builderLabel } from '@amable/builder';
import { useCallback } from 'react';
import { useI18n } from '../../../i18n';

/** Catalog labels (widget titles, sections, controls, options) in the UI locale. */
export function useBuilderLabel(): (label: string | undefined) => string {
  const { locale } = useI18n();
  return useCallback((label) => (label ? builderLabel(label, locale) : ''), [locale]);
}
