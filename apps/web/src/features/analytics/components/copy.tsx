import { cn } from '@amable/ui';
import { KeyRound, TriangleAlert } from 'lucide-react';
import { CopyButton } from '../../../components/feature-kit';
import { useI18n } from '../../../i18n';

export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('group relative', className)}>
      <pre className="max-h-80 overflow-auto rounded-lg bg-foreground/[0.04] p-3 pr-24 font-mono text-[11.5px] leading-relaxed text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_6%,transparent)]">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} className="absolute right-2 top-2" />
    </div>
  );
}

/** A secret returned once by the API: copy it now, it will not be shown again. */
export function SecretReveal({ secret, title }: { secret: string; title?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/[0.07] p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium text-warning">
        <TriangleAlert className="size-3.5" aria-hidden />
        {title ?? t('analytics.secret.once')}
      </span>
      <div className="flex items-center gap-2">
        <code className="flex min-w-0 flex-1 items-center gap-2 truncate rounded-md bg-background px-2.5 py-1.5 font-mono text-xs">
          <KeyRound className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{secret}</span>
        </code>
        <CopyButton text={secret} />
      </div>
    </div>
  );
}
