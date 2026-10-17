import type { MessageKey } from '@amable/i18n';
import { Badge } from '@amable/ui/ui/badge';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Pill, type Tone } from '../developers/components';
import type { AppManifestView, InstallStatus } from './api';

const KNOWN_REASONS = new Set(['paused_by_admin', 'webhook_endpoint_disabled']);

/** Labels for values coming from the server; the sets mirror the core enums. */
export function useAppLabels() {
  const { t } = useI18n();
  return {
    status: (status: InstallStatus) => t(`apps.status.${status}` as MessageKey),
    category: (category: string) => t(`apps.cat.${category}` as MessageKey),
    pricing: (model: AppManifestView['pricing']['model']) => t(`apps.pricing.${model}` as MessageKey),
    metric: (kind: string) => t(`apps.health.kind.${kind}` as MessageKey),
    reason: (reason: string) => (KNOWN_REASONS.has(reason) ? t(`apps.reason.${reason}` as MessageKey) : reason),
  };
}

const STATUS_TONE: Record<InstallStatus, Tone> = {
  active: 'success',
  pending: 'neutral',
  paused: 'warning',
  uninstalling: 'warning',
  uninstalled: 'neutral',
  revoked: 'danger',
};

export function StatusPill({ status }: { status: InstallStatus }) {
  const labels = useAppLabels();
  return <Pill tone={STATUS_TONE[status]}>{labels.status(status)}</Pill>;
}

export function AppIcon({ manifest, size = 40 }: { manifest: Pick<AppManifestView, 'icon_url' | 'name'>; size?: number }) {
  return (
    <img
      src={manifest.icon_url}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-lg border border-border bg-white object-contain"
      style={{ width: size, height: size }}
    />
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  const { t } = useI18n();
  return verified ? (
    <Badge variant="secondary" className="gap-1">
      <ShieldCheck className="size-3" />
      {t('apps.verified')}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-300">
      <ShieldAlert className="size-3" />
      {t('apps.unverified')}
    </Badge>
  );
}

/** What an app may do, one line per permission; sensitive ones are flagged. */
export function ScopeList({ scopes, sensitive }: { scopes: readonly string[]; sensitive: readonly string[] }) {
  const { t } = useI18n();
  const flagged = new Set(sensitive);
  return (
    <ul className="grid gap-1.5 text-sm">
      {scopes.map((scope) => {
        const [area = scope, level = ''] = scope.split(':');
        return (
          <li key={scope} className="flex items-start gap-2">
            {flagged.has(scope) ? (
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-label={t('apps.scope.sensitive')} />
            ) : (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-(--obsidian-dashboard-shell-text-subtle)" />
            )}
            <span>
              <span className="font-medium">{t('apps.scope.line', { area: area.replace(/_/g, ' '), level: level.replace(/_/g, ' ') })}</span>{' '}
              <code className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{scope}</code>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Extension points an app adds, for the detail page. */
export function ExtensionList({ manifest, locale }: { manifest: AppManifestView; locale: string }) {
  const { t } = useI18n();
  const items: string[] = [];
  const ext = manifest.extensions;
  if (ext.contact_validate !== undefined) items.push(t('apps.ext.validate', { fields: ext.contact_validate.fields.join(', ') }));
  for (const a of ext.automation_actions ?? []) items.push(t('apps.ext.action', { name: locale.startsWith('it') ? (a.name.it ?? a.name.en) : a.name.en }));
  for (const a of ext.automation_triggers ?? []) items.push(t('apps.ext.trigger', { name: locale.startsWith('it') ? (a.name.it ?? a.name.en) : a.name.en }));
  for (const u of ext.ui ?? []) items.push(t('apps.ext.ui', { title: locale.startsWith('it') ? (u.title.it ?? u.title.en) : u.title.en }));
  for (const f of ext.form_connectors ?? []) items.push(t('apps.ext.connector', { name: locale.startsWith('it') ? (f.name.it ?? f.name.en) : f.name.en }));
  for (const c of ext.channels ?? []) items.push(t('apps.ext.channel', { name: locale.startsWith('it') ? (c.name.it ?? c.name.en) : c.name.en }));
  for (const f of manifest.custom_fields) items.push(t('apps.ext.field', { name: locale.startsWith('it') ? (f.label.it ?? f.label.en) : f.label.en }));
  if (items.length === 0) return null;
  return (
    <ul className="grid list-disc gap-1 pl-5 text-sm">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
