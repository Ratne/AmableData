import type { NodeStats } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { CircleAlert, Diamond, Flag, ListOrdered } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { filterSize } from '../lib/branch-filter';
import { DEFAULT_HANDLE, type AutomationFlowNode } from '../lib/flow-mapping';
import { statsKey, useCanvas } from './canvas-context';
import { GoalIcon, StepIcon } from './node-icons';
import { useStepSummary } from './step-forms';

/** Custom React Flow nodes: goal, sequence, decision diamond and sticky note. */

const handleClass = '!size-2.5 !border-2 !border-background !bg-muted-foreground';

function Counters({ stats, compact = false }: { stats: NodeStats | undefined; compact?: boolean }) {
  const { t } = useI18n();
  const values = stats ?? { entered: 0, active: 0, completed: 0, errors: 0 };
  const items: Array<[string, number, string]> = [
    [t('auto.report.entered'), values.entered, 'text-foreground'],
    [t('auto.report.active'), values.active, 'text-sky-600 dark:text-sky-400'],
    [t('auto.report.completed'), values.completed, 'text-emerald-600 dark:text-emerald-400'],
    [
      t('auto.report.errors'),
      values.errors,
      values.errors > 0 ? 'text-destructive' : 'text-muted-foreground',
    ],
  ];
  if (compact) {
    return (
      <span
        className="flex shrink-0 gap-1.5 font-mono text-[10px] tabular-nums"
        data-testid="step-counters"
      >
        {items.map(([label, value, tone]) => (
          <span key={label} className={tone} title={label}>
            {value}
          </span>
        ))}
      </span>
    );
  }
  return (
    <div className="grid grid-cols-4 gap-1 border-t px-2 py-1.5" data-testid="node-counters">
      {items.map(([label, value, tone]) => (
        <div key={label} className="grid text-center leading-tight">
          <span className={cn('font-mono text-sm font-semibold tabular-nums', tone)}>{value}</span>
          <span className="truncate text-[9px] uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

function Shell({
  id,
  selected,
  tone,
  icon,
  kind,
  title,
  children,
  className,
}: {
  id: string;
  selected: boolean;
  tone: string;
  icon: ReactNode;
  kind: string;
  title: string;
  children?: ReactNode;
  className?: string;
}) {
  const { stats, issues, openCounters } = useCanvas();
  const problems = issues.get(id);
  return (
    <div
      className={cn(
        'w-60 rounded-xl border bg-card text-card-foreground shadow-sm transition-shadow',
        selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
        problems !== undefined && problems.errors > 0 && 'border-destructive',
        className,
      )}
      data-testid={`node-${id}`}
    >
      <div className={cn('flex items-center gap-2 rounded-t-xl px-3 py-2', tone)}>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background/70">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium uppercase tracking-wide opacity-70">{kind}</p>
          <p className="truncate text-sm font-semibold">{title}</p>
        </div>
        {problems !== undefined && problems.errors + problems.warnings > 0 ? (
          <span
            className={cn(
              'flex items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold',
              problems.errors > 0 ? 'bg-destructive text-white' : 'bg-amber-500 text-white',
            )}
            title={problems.messages.map((m) => m.message).join('\n')}
            data-testid="node-issues"
          >
            <CircleAlert className="size-3" aria-hidden />
            {problems.errors + problems.warnings}
          </span>
        ) : null}
      </div>
      {children}
      {stats !== null ? (
        <button
          type="button"
          className="nodrag block w-full cursor-pointer rounded-b-xl text-left hover:bg-muted/40"
          onClick={(event) => {
            event.stopPropagation();
            openCounters(id);
          }}
        >
          <Counters stats={stats.get(statsKey(id))} />
        </button>
      ) : null}
    </div>
  );
}

export const GoalNodeView = memo(function GoalNodeView({
  id,
  data,
  selected,
}: NodeProps<AutomationFlowNode>) {
  const { t } = useI18n();
  const node = data.node;
  if (node.type !== 'goal') return null;
  const first = node.triggers[0];
  return (
    <>
      <Handle type="target" position={Position.Left} className={handleClass} />
      <Shell
        id={id}
        selected={selected}
        tone="bg-emerald-500/12 text-emerald-900 dark:text-emerald-100"
        icon={
          first ? (
            <GoalIcon type={first.type} className="size-3.5" />
          ) : (
            <Flag className="size-3.5" />
          )
        }
        kind={t('auto.node.goal')}
        title={node.label ?? (first ? t(`auto.goal.${first.type}`) : t('auto.node.goal'))}
      >
        {node.triggers.length > 1 ? (
          <p className="px-3 py-1 text-[11px] text-muted-foreground">
            {node.triggers
              .slice(1, 3)
              .map((tr) => t(`auto.goal.${tr.type}`))
              .join(' · ')}
            {node.triggers.length > 3
              ? ` ${t('auto.node.moreTriggers', { n: node.triggers.length - 3 })}`
              : ''}
          </p>
        ) : null}
      </Shell>
      <Handle type="source" position={Position.Right} className={handleClass} />
    </>
  );
});

export const SequenceNodeView = memo(function SequenceNodeView({
  id,
  data,
  selected,
}: NodeProps<AutomationFlowNode>) {
  const { t } = useI18n();
  const { stats, issues } = useCanvas();
  const summary = useStepSummary();
  const node = data.node;
  if (node.type !== 'sequence') return null;
  const stepIssues = issues.get(id)?.byStep;
  return (
    <>
      <Handle type="target" position={Position.Left} className={handleClass} />
      <Shell
        id={id}
        selected={selected}
        tone="bg-sky-500/12 text-sky-900 dark:text-sky-100"
        icon={<ListOrdered className="size-3.5" />}
        kind={t('auto.node.sequence')}
        title={node.label ?? t('auto.node.sequence')}
      >
        <ol className="grid gap-px py-1">
          {node.steps.length === 0 ? (
            <li className="px-3 py-1 text-xs text-muted-foreground italic">
              {t('auto.node.noSteps')}
            </li>
          ) : null}
          {node.steps.slice(0, 8).map((step) => (
            <li
              key={step.id}
              className={cn(
                'flex items-center gap-1.5 px-3 py-0.5 text-xs',
                stepIssues?.has(step.id) && 'text-destructive',
              )}
            >
              <StepIcon type={step.type} className="size-3 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">
                {step.label ?? t(`auto.step.${step.type}`)}
                <span className="ml-1 text-muted-foreground">{summary(step)}</span>
              </span>
              {stats !== null ? (
                <Counters compact stats={stats.get(statsKey(id, step.id))} />
              ) : null}
            </li>
          ))}
          {node.steps.length > 8 ? (
            <li className="px-3 text-[11px] text-muted-foreground">+{node.steps.length - 8}</li>
          ) : null}
        </ol>
      </Shell>
      <Handle type="source" position={Position.Right} className={handleClass} />
    </>
  );
});

export const DecisionNodeView = memo(function DecisionNodeView({
  id,
  data,
  selected,
}: NodeProps<AutomationFlowNode>) {
  const { t } = useI18n();
  const node = data.node;
  if (node.type !== 'decision') return null;
  const rows = [
    ...node.branches.map((b, i) => ({
      id: b.id,
      label: b.label ?? `#${String(i + 1)}`,
      detail:
        filterSize(b.filter) === 0
          ? t('auto.node.everyone')
          : t('auto.node.conditions', { n: filterSize(b.filter) }),
    })),
    { id: DEFAULT_HANDLE, label: t('auto.node.default'), detail: '' },
  ];
  return (
    <>
      <Handle type="target" position={Position.Left} className={handleClass} />
      <Shell
        id={id}
        selected={selected}
        tone="bg-amber-500/15 text-amber-900 dark:text-amber-100"
        icon={<Diamond className="size-3.5" />}
        kind={t('auto.node.decision')}
        title={node.label ?? t('auto.node.decision')}
      >
        <ul className="grid py-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="relative flex items-center gap-1.5 py-1 pr-4 pl-3 text-xs"
              data-testid="decision-row"
            >
              <span
                className={cn(
                  'truncate font-medium',
                  row.id === DEFAULT_HANDLE && 'text-muted-foreground',
                )}
              >
                {row.label}
              </span>
              {row.detail ? (
                <span className="truncate text-[11px] text-muted-foreground">{row.detail}</span>
              ) : null}
              <Handle
                id={row.id}
                type="source"
                position={Position.Right}
                className={cn(
                  handleClass,
                  row.id === DEFAULT_HANDLE ? '!bg-muted-foreground/60' : '!bg-amber-500',
                )}
                style={{ top: '50%' }}
              />
            </li>
          ))}
        </ul>
      </Shell>
    </>
  );
});

const NOTE_COLORS: Record<string, string> = {
  yellow:
    'bg-yellow-100 border-yellow-300 text-yellow-950 dark:bg-yellow-900/40 dark:border-yellow-700 dark:text-yellow-50',
  blue: 'bg-sky-100 border-sky-300 text-sky-950 dark:bg-sky-900/40 dark:border-sky-700 dark:text-sky-50',
  green:
    'bg-emerald-100 border-emerald-300 text-emerald-950 dark:bg-emerald-900/40 dark:border-emerald-700 dark:text-emerald-50',
  pink: 'bg-pink-100 border-pink-300 text-pink-950 dark:bg-pink-900/40 dark:border-pink-700 dark:text-pink-50',
};
export const NOTE_COLOR_NAMES = Object.keys(NOTE_COLORS);

export const NoteNodeView = memo(function NoteNodeView({
  data,
  selected,
}: NodeProps<AutomationFlowNode>) {
  const { t } = useI18n();
  const { readOnly, updateNode } = useCanvas();
  const node = data.node;
  if (node.type !== 'note') return null;
  return (
    <>
      <NodeResizer isVisible={selected && !readOnly} minWidth={140} minHeight={60} />
      <div
        className={cn(
          'h-full w-full rounded-lg border p-2 shadow-sm',
          NOTE_COLORS[node.color ?? 'yellow'] ?? NOTE_COLORS['yellow'],
        )}
        style={{ minWidth: 140, minHeight: 60 }}
      >
        <textarea
          className="nodrag nowheel h-full w-full resize-none bg-transparent text-xs leading-snug outline-none placeholder:opacity-60"
          value={node.text}
          readOnly={readOnly}
          placeholder={t('auto.node.notePlaceholder')}
          aria-label={t('auto.node.note')}
          onChange={(event) => updateNode({ ...node, text: event.target.value.slice(0, 5000) })}
        />
      </div>
    </>
  );
});

export const nodeTypes = {
  goal: GoalNodeView,
  sequence: SequenceNodeView,
  decision: DecisionNodeView,
  note: NoteNodeView,
};
