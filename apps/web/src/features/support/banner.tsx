import { ShieldAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import { ShellLink } from '../../shell/shell-link';
import { useAssistStatus, useDate } from './api';

/** Shown in the workspace layout while a support session is active (or when the viewer is support). */
export function SupportSessionBanner({ tenant }: { tenant: string }) {
  const { t } = useI18n();
  const date = useDate();
  const status = useAssistStatus(tenant);
  const data = status.data;
  if (!data || (!data.supportSession && data.sessions.length === 0)) return null;
  const names = [...new Set(data.sessions.map((s) => s.staffName))].join(', ');
  const until = Math.max(...data.sessions.map((s) => s.expiresAt), 0);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-200"
    >
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {data.supportSession ? t('sup.banner.self') : t('sup.banner.active', { names })}
        {until > 0 ? ` · ${t('sup.assist.until', { date: date(until) })}` : null}
      </span>
      {data.canManage ? (
        <ShellLink href={`/t/${tenant}/support`} className="font-medium underline underline-offset-2">
          {t('sup.banner.manage')}
        </ShellLink>
      ) : null}
    </div>
  );
}
