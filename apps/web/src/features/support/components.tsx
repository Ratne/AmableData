import { PageBody } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { ExternalLink, LifeBuoy } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { COMMUNITY_URL } from './api';

export { Pill, type Tone } from '../../components/feature-kit';

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Open source installation: no managed support, point to the community. */
export function UnavailableNotice() {
  const { t } = useI18n();
  return (
    <PageBody className="pt-4">
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-lg border border-border bg-card p-8 text-center">
        <LifeBuoy className="size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold">{t('sup.unavailable.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('sup.unavailable.body')}</p>
        <Button asChild variant="outline" size="sm">
          <a href={COMMUNITY_URL} target="_blank" rel="noreferrer">
            {t('sup.unavailable.link')}
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Button>
      </div>
    </PageBody>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}
