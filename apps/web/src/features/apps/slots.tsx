import { DashboardButton, PageBody, usePageChrome } from '@amable/ui';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { useParams } from '@tanstack/react-router';
import { Blocks } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../i18n';
import { text, useAppScreens, useInstalledExtensions, type AppUiExtension, type InstalledExtensions } from './api';
import { AppFrame } from './frame';

/** Where installed apps show their screens: contact page, dashboard, app pages. */

/** `contact.actions`: one button per screen; the screen opens in a dialog. */
export function ContactAppActions({ contactId }: { contactId: string }) {
  const { locale } = useI18n();
  const screens = useAppScreens('contact.actions');
  const [open, setOpen] = useState<{ app: InstalledExtensions; ui: AppUiExtension } | null>(null);
  if (screens.length === 0) return null;
  return (
    <>
      {screens.map(({ app, ui }) => (
        <DashboardButton key={`${app.app_id}:${ui.key}`} variant="ghost" onClick={() => setOpen({ app, ui })}>
          <Blocks aria-hidden /> {text(ui.title, locale)}
        </DashboardButton>
      ))}
      <Dialog open={open !== null} onOpenChange={(next) => (next ? undefined : setOpen(null))}>
        <DialogContent className="sm:max-w-2xl">
          {open !== null ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {text(open.ui.title, locale)} · {open.app.name}
                </DialogTitle>
              </DialogHeader>
              <AppFrame
                appId={open.app.app_id}
                uiKey={open.ui.key}
                title={text(open.ui.title, locale)}
                contactId={contactId}
                defaultHeight={open.ui.height ?? 420}
                onClose={() => setOpen(null)}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScreenCard({ app, ui, contactId = null }: { app: InstalledExtensions; ui: AppUiExtension; contactId?: string | null }) {
  const { locale } = useI18n();
  const title = text(ui.title, locale);
  return (
    <Card className="gap-2 py-3">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          {app.icon_url ? <img src={app.icon_url} alt="" className="size-4 rounded" /> : <Blocks className="size-4" aria-hidden />}
          {title}
          <span className="font-normal text-muted-foreground">· {app.name}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        <AppFrame appId={app.app_id} uiKey={ui.key} title={title} contactId={contactId} defaultHeight={ui.height ?? 200} />
      </CardContent>
    </Card>
  );
}

/** `contact.sidebar`: cards on the contact page. */
export function ContactAppCards({ contactId }: { contactId: string }) {
  const screens = useAppScreens('contact.sidebar');
  if (screens.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {screens.map(({ app, ui }) => (
        <ScreenCard key={`${app.app_id}:${ui.key}`} app={app} ui={ui} contactId={contactId} />
      ))}
    </div>
  );
}

/** `dashboard.widget`: cards on the workspace dashboard. */
export function DashboardAppWidgets() {
  const screens = useAppScreens('dashboard.widget');
  if (screens.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {screens.map(({ app, ui }) => (
        <ScreenCard key={`${app.app_id}:${ui.key}`} app={app} ui={ui} />
      ))}
    </div>
  );
}

/** `app.page` and `app.settings`: a full page of the app inside the workspace. */
export function AppScreenPage() {
  const { t, locale } = useI18n();
  const { appId, screenKey } = useParams({ strict: false }) as { appId: string; screenKey: string };
  const installed = useInstalledExtensions();
  const app = installed.data?.data.find((candidate) => candidate.app_id === appId);
  const ui = app?.extensions.ui?.find((candidate) => candidate.key === screenKey && (candidate.slot === 'app.page' || candidate.slot === 'app.settings'));
  const title = ui === undefined ? t('nav.apps') : text(ui.title, locale);
  usePageChrome({ title: app === undefined ? title : `${title} · ${app.name}` });
  if (installed.isPending) return null;
  if (app === undefined || ui === undefined || app.status !== 'active') {
    return (
      <PageBody className="pt-6">
        <p className="text-sm text-muted-foreground">{t('apps.frame.unavailable')}</p>
      </PageBody>
    );
  }
  return (
    <PageBody className="pt-4">
      <AppFrame appId={app.app_id} uiKey={ui.key} title={title} defaultHeight={ui.height ?? 640} className="w-full rounded-lg border bg-card" />
    </PageBody>
  );
}
