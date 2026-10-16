import { toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Copy } from 'lucide-react';
import { useI18n } from '../../../i18n';

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  return (
    <div className="relative">
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/50 p-2.5 pr-10 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-1 right-1 size-7"
        aria-label={label ?? t('auto.copy')}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => toast.success(t('auto.copied')));
        }}
      >
        <Copy className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/** curl example of `POST /automationGoals/{call_name}/trigger` for an API goal. */
export function ApiTriggerSnippet({ slug, callName }: { slug: string; callName: string }) {
  const { t } = useI18n();
  const origin = typeof window === 'undefined' ? 'https://crm.example.com' : window.location.origin;
  const url = `${origin}/api/v2/t/${encodeURIComponent(slug)}/automationGoals/${encodeURIComponent(callName || 'my.goal')}/trigger`;
  const snippet = [
    `curl -X POST '${url}' \\`,
    `  -H 'Authorization: Bearer amb_live_…' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '{"contact_id":"<CONTACT_ID>","event_id":"<optional-dedupe-key>"}'`,
  ].join('\n');
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{t('auto.goal.snippet')}</p>
      <CopyBlock text={snippet} />
      <p className="text-[11px] leading-snug text-muted-foreground">{t('auto.goal.snippetHint')}</p>
    </div>
  );
}
