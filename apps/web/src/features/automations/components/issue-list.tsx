import { cn } from '@amable/ui';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import type { CanvasIssue } from '../lib/issues';

/** Inline list of problems (local shape errors and publish validation) for a node or step. */
export function IssueList({
  issues,
  className,
}: {
  issues: readonly CanvasIssue[];
  className?: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className={cn('grid gap-1', className)} data-testid="issue-list">
      {issues.map((issue, index) => (
        <li
          key={`${issue.path}-${String(index)}`}
          className={cn(
            'flex items-start gap-1.5 rounded-md px-2 py-1 text-xs',
            issue.severity === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
          )}
        >
          {issue.severity === 'error' ? (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          )}
          <span>
            {issue.message}
            {issue.path ? <span className="ml-1 font-mono opacity-60">{issue.path}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
