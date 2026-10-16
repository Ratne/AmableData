import { PageBody, usePageChrome } from '@amable/ui';
import { useI18n } from '../i18n';
import type { ModuleDef } from '../navigation';

/** Stand-in page for modules whose phase has not shipped yet. */
export function ModulePlaceholder({ module }: { module: ModuleDef }) {
  const { t } = useI18n();
  const title = t(module.labelKey);
  usePageChrome({ title });
  const Icon = module.icon;
  return (
    <PageBody className="flex min-h-full flex-col items-center justify-center gap-3 border-t border-(--obsidian-dashboard-shell-border) py-16 text-center">
      <span
        aria-hidden
        className="grid size-10 place-items-center rounded-xl bg-(--obsidian-dashboard-shell-muted) text-(--obsidian-dashboard-shell-icon) shadow-(--obsidian-dashboard-shell-control-shadow)"
      >
        <Icon className="size-5" />
      </span>
      <p className="text-sm font-medium">{t('page.placeholder.title', { module: title })}</p>
      <p className="max-w-sm text-xs text-(--obsidian-dashboard-shell-text-subtle)">
        {t('page.placeholder.body')}
      </p>
    </PageBody>
  );
}
