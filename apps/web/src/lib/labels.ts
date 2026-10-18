import type { EditorLabels } from '@amable/editor';
import type { MessageKey } from '@amable/i18n';
import type { ListTableLabels } from '@amable/ui';

type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

/** Translated strings for `<ListTable labels={…}>`. */
export function listTableLabels(t: Translate): ListTableLabels {
  return {
    selectAll: t('list.selectAll'),
    selectRow: (name) => t('list.selectRow', { name }),
    rowActions: (name) => t('list.rowActions', { name }),
    selectedCount: (count) => t('list.selectedCount', { count }),
    clearSelection: t('list.clearSelection'),
    delete: t('list.delete'),
    undo: t('list.undo'),
    cancel: t('list.cancel'),
    deleted: (count, name) =>
      count === 1 ? t('list.deletedOne', { name }) : t('list.deletedMany', { count }),
    deleteFailed: t('list.deleteFailed'),
    confirmDeleteTitle: (count, name) =>
      count === 1 ? t('list.confirmDeleteOne', { name }) : t('list.confirmDeleteMany', { count }),
    confirmDeleteDescription: (_count, undoable) =>
      t(undoable ? 'list.confirmDeleteBody' : 'list.confirmDeleteBodyFinal'),
    empty: t('list.empty'),
    loading: t('common.loading'),
  };
}

/** Translated strings for `<AmableEditor labels={…}>`. */
export function editorLabels(t: Translate): EditorLabels {
  return {
    insert: t('editor.insert'),
    insertField: t('editor.insertField'),
    button: t('editor.button'),
    buttonLabel: t('editor.buttonLabel'),
    buttonLink: t('editor.buttonLink'),
    align: t('editor.align'),
    alignLeft: t('editor.alignLeft'),
    alignCenter: t('editor.alignCenter'),
    alignRight: t('editor.alignRight'),
    color: t('editor.color'),
    textColor: t('editor.textColor'),
    divider: t('editor.divider'),
    spacer: t('editor.spacer'),
    height: t('editor.height'),
    columns2: t('editor.columns2'),
    columns3: t('editor.columns3'),
    header: t('editor.header'),
    footer: t('editor.footer'),
    unsubscribeLabel: t('editor.unsubscribeLabel'),
    unsubscribeNote: t('editor.unsubscribeNote'),
    preheader: t('editor.preheader'),
    preheaderPlaceholder: t('editor.preheaderPlaceholder'),
    condition: t('editor.condition'),
    conditionIf: t('editor.conditionIf'),
    conditionTag: t('editor.conditionTag'),
    conditionField: t('editor.conditionField'),
    conditionExpression: t('editor.conditionExpression'),
    conditionHasTag: t('editor.conditionHasTag'),
    conditionHasNotTag: t('editor.conditionHasNotTag'),
    conditionOtherwise: t('editor.conditionOtherwise'),
    conditionAddOtherwise: t('editor.conditionAddOtherwise'),
    conditionRemoveOtherwise: t('editor.conditionRemoveOtherwise'),
    operators: {
      equals: t('editor.op.equals'),
      not_equals: t('editor.op.notEquals'),
      contains: t('editor.op.contains'),
      greater_than: t('editor.op.greaterThan'),
      less_than: t('editor.op.lessThan'),
      is_blank: t('editor.op.isBlank'),
      is_present: t('editor.op.isPresent'),
    },
    value: t('editor.value'),
    rawLiquid: t('editor.rawLiquid'),
    rawLiquidHint: t('editor.rawLiquidHint'),
    fallback: t('editor.fallback'),
    fallbackPlaceholder: t('editor.fallbackPlaceholder'),
    noFields: t('editor.noFields'),
    imageLink: t('editor.imageLink'),
    image: t('editor.image'),
    remove: t('editor.remove'),
  };
}
