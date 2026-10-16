import type { DecisionNode } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useFieldCatalog } from '../../crm/field-catalog';
import { QueryBuilder } from '../../search/query-builder';
import {
  branchesToUi,
  moveBranch,
  newBranch,
  uiToBranches,
  type UiBranch,
} from '../lib/branch-filter';
import { clean } from '../lib/clean';
import type { CanvasIssue } from '../lib/issues';
import { Field } from './form-bits';
import { IssueList } from './issue-list';

/**
 * Branch editor of a decision diamond. Each branch filter is edited with the
 * CRM advanced-search builder (same JSON the engine evaluates on the contact).
 * The editable tree lives here while the panel is open; every change is
 * serialized into the graph node.
 */
export function DecisionPanel({
  node,
  onChange,
  disabled,
  takenIds,
  issues,
}: {
  node: DecisionNode;
  onChange: (node: DecisionNode) => void;
  disabled: boolean;
  takenIds: ReadonlySet<string>;
  issues: readonly CanvasIssue[];
}) {
  const { t } = useI18n();
  const catalog = useFieldCatalog('contact');
  const [branches, setBranches] = useState<UiBranch[]>(() => branchesToUi(node.branches));
  const nodeRef = useRef(node);
  nodeRef.current = node;

  // A different decision (or an external change such as undo) replaces the editable tree.
  const lastSerialized = useRef<string>(JSON.stringify(node.branches));
  useEffect(() => {
    const incoming = JSON.stringify(node.branches);
    if (incoming !== lastSerialized.current) {
      lastSerialized.current = incoming;
      setBranches(branchesToUi(node.branches));
    }
  }, [node.branches]);

  const commit = (next: UiBranch[]) => {
    setBranches(next);
    if (catalog.isPending) return;
    const serialized = uiToBranches(next, catalog.kinds);
    lastSerialized.current = JSON.stringify(serialized);
    onChange({ ...nodeRef.current, branches: serialized });
  };

  return (
    <div className="grid gap-4">
      <IssueList issues={issues} />
      <Field label={t('auto.dec.label')}>
        <Input
          value={node.label ?? ''}
          disabled={disabled}
          className="h-8"
          onChange={(e) => onChange(clean({ ...node, label: e.target.value || undefined }))}
        />
      </Field>
      <div className="grid gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t('auto.dec.branches')}</p>
        {catalog.isPending ? (
          <p className="text-xs text-muted-foreground">{t('auto.dec.loadingFields')}</p>
        ) : null}
        {branches.map((branch, index) => (
          <div
            key={branch.id}
            className="grid gap-2 rounded-lg border bg-card p-2.5"
            data-testid="decision-branch"
          >
            <div className="flex items-center gap-1.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {index + 1}
              </span>
              <Input
                value={branch.label}
                placeholder={t('auto.dec.branchLabel')}
                disabled={disabled}
                className="h-8"
                onChange={(e) =>
                  commit(
                    branches.map((b) => (b.id === branch.id ? { ...b, label: e.target.value } : b)),
                  )
                }
              />
              {!disabled ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t('auto.seq.moveUp')}
                    disabled={index === 0}
                    onClick={() => commit(moveBranch(branches, index, -1))}
                  >
                    <ArrowUp className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t('auto.seq.moveDown')}
                    disabled={index === branches.length - 1}
                    onClick={() => commit(moveBranch(branches, index, 1))}
                  >
                    <ArrowDown className="size-3.5" aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-destructive"
                    aria-label={t('auto.dec.removeBranch')}
                    disabled={branches.length <= 1}
                    onClick={() => commit(branches.filter((b) => b.id !== branch.id))}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </>
              ) : null}
            </div>
            <fieldset disabled={disabled} className="min-w-0">
              <QueryBuilder
                root={branch.root}
                fields={catalog.fields}
                allowTags
                onChange={(root) =>
                  commit(branches.map((b) => (b.id === branch.id ? { ...b, root } : b)))
                }
              />
            </fieldset>
          </div>
        ))}
        {!disabled && branches.length < 10 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 justify-self-start"
            onClick={() =>
              commit([...branches, newBranch(new Set([...takenIds, ...branches.map((b) => b.id)]))])
            }
          >
            <Plus className="size-3.5" aria-hidden /> {t('auto.dec.addBranch')}
          </Button>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t('auto.dec.defaultHint')}</p>
      </div>
    </div>
  );
}
