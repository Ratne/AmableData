import type { SequenceNode, Step, StepType } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@amable/ui/ui/dropdown-menu';
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { useI18n } from '../../../i18n';
import { clean } from '../lib/clean';
import { defaultStep, STEP_GROUPS } from '../lib/defaults';
import { uniqueId } from '../lib/ids';
import type { CanvasIssue } from '../lib/issues';
import { Field, SwitchRow } from './form-bits';
import { IssueList } from './issue-list';
import { StepIcon } from './node-icons';
import { StepForm, useStepSummary, type StepFormContext } from './step-forms';

export function AddStepMenu({ onAdd, label }: { onAdd: (type: StepType) => void; label: string }) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-7">
          <Plus className="size-3.5" aria-hidden /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-60 overflow-auto">
        {STEP_GROUPS.map((group, index) => (
          <Fragment key={group.id}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t(`auto.stepGroup.${group.id}`)}
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {group.types.map((type) => (
                <DropdownMenuItem key={type} onSelect={() => onAdd(type)}>
                  <StepIcon type={type} className="size-3.5" />
                  {t(`auto.step.${type}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Step list editor of a sequence: add (grouped menu), reorder, duplicate,
 * delete, and the configuration form of the selected step.
 */
export function SequencePanel({
  node,
  onChange,
  disabled,
  ctx,
  takenIds,
  issues,
  stepIssues,
  selectedStepId,
  onSelectStep,
}: {
  node: SequenceNode;
  onChange: (node: SequenceNode) => void;
  disabled: boolean;
  ctx: StepFormContext;
  takenIds: ReadonlySet<string>;
  issues: readonly CanvasIssue[];
  stepIssues: ReadonlyMap<string, readonly CanvasIssue[]>;
  selectedStepId: string | null;
  onSelectStep: (stepId: string | null) => void;
}) {
  const { t } = useI18n();
  const summary = useStepSummary();
  const [localTaken] = useState(() => new Set<string>());
  const freshId = () => {
    const id = uniqueId('st', new Set([...takenIds, ...localTaken]));
    localTaken.add(id);
    return id;
  };
  const setSteps = (steps: Step[]) => onChange({ ...node, steps });
  const selected = node.steps.find((s) => s.id === selectedStepId) ?? null;
  const nodeLevel = issues.filter((issue) => issue.stepId === null);

  const add = (type: StepType, at = node.steps.length) => {
    const step = defaultStep(type, freshId());
    const steps = [...node.steps];
    steps.splice(at, 0, step);
    setSteps(steps);
    onSelectStep(step.id);
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= node.steps.length) return;
    const steps = [...node.steps];
    const [moved] = steps.splice(index, 1);
    if (moved) steps.splice(target, 0, moved);
    setSteps(steps);
  };

  return (
    <div className="grid gap-4">
      <IssueList issues={nodeLevel} />
      <Field label={t('auto.seq.label')}>
        <Input
          value={node.label ?? ''}
          disabled={disabled}
          className="h-8"
          onChange={(e) => onChange(clean({ ...node, label: e.target.value || undefined }))}
        />
      </Field>
      <div className="grid gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t('auto.seq.steps')}</p>
        {node.steps.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            {t('auto.seq.empty')}
          </p>
        ) : null}
        <ol className="grid gap-1" data-testid="step-list">
          {node.steps.map((step, index) => {
            const problems = stepIssues.get(step.id) ?? [];
            return (
              <li key={step.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectStep(step.id === selectedStepId ? null : step.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSelectStep(step.id);
                  }}
                  className={cn(
                    'group flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    step.id === selectedStepId
                      ? 'border-primary bg-primary/5'
                      : 'bg-card hover:bg-muted/50',
                    problems.some((p) => p.severity === 'error') && 'border-destructive/60',
                  )}
                  data-testid="step-row"
                >
                  <span className="w-4 text-right text-[11px] text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <StepIcon type={step.type} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {step.label ?? t(`auto.step.${step.type}`)}
                    <span className="ml-1.5 text-xs text-muted-foreground">{summary(step)}</span>
                  </span>
                  {!disabled ? (
                    <span className="flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={t('auto.seq.moveUp')}
                        disabled={index === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(index, -1);
                        }}
                      >
                        <ArrowUp className="size-3" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={t('auto.seq.moveDown')}
                        disabled={index === node.steps.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(index, 1);
                        }}
                      >
                        <ArrowDown className="size-3" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={t('auto.duplicate')}
                        onClick={(e) => {
                          e.stopPropagation();
                          const copy = { ...step, id: freshId() };
                          const steps = [...node.steps];
                          steps.splice(index + 1, 0, copy);
                          setSteps(steps);
                        }}
                      >
                        <Copy className="size-3" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-destructive"
                        aria-label={t('auto.delete')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSteps(node.steps.filter((s) => s.id !== step.id));
                          if (selectedStepId === step.id) onSelectStep(null);
                        }}
                      >
                        <Trash2 className="size-3" aria-hidden />
                      </Button>
                    </span>
                  ) : null}
                </div>
                {step.id === selectedStepId && selected ? (
                  <div
                    className="mt-1 mb-2 grid gap-3 rounded-md border bg-muted/20 p-2.5"
                    data-testid="step-form"
                  >
                    <IssueList issues={problems} />
                    <StepForm
                      step={selected}
                      disabled={disabled}
                      ctx={ctx}
                      onChange={(next) =>
                        setSteps(node.steps.map((s) => (s.id === next.id ? next : s)))
                      }
                    />
                    <Field label={t('auto.seq.stepLabel')}>
                      <Input
                        value={selected.label ?? ''}
                        disabled={disabled}
                        className="h-8"
                        onChange={(e) =>
                          setSteps(
                            node.steps.map((s) =>
                              s.id === selected.id
                                ? clean({ ...s, label: e.target.value || undefined })
                                : s,
                            ),
                          )
                        }
                      />
                    </Field>
                    {selected.type !== 'end' ? (
                      <SwitchRow
                        label={t('auto.seq.continueOnError')}
                        checked={selected.continue_on_error === true}
                        disabled={disabled}
                        onChange={(on) =>
                          setSteps(
                            node.steps.map((s) =>
                              s.id === selected.id
                                ? clean({ ...s, continue_on_error: on || undefined })
                                : s,
                            ),
                          )
                        }
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
        {!disabled ? (
          <AddStepMenu label={t('auto.seq.addStep')} onAdd={(type) => add(type)} />
        ) : null}
      </div>
    </div>
  );
}
