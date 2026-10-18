import type { AutomationDetail, AutomationSettings, GraphNode } from '@amable/api-types';
import { DashboardConfirmDialog } from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Kbd } from '@amable/ui/ui/kbd';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useDirectory } from '../../crm/api/hooks';
import { ChoiceSelect } from '../../crm/components/inputs';
import {
  automationKeys,
  useAutomationApi,
  useAutomationMutation,
  useAutomationPermissions,
} from '../api/hooks';
import { clean } from '../lib/clean';
import { Field, SendWindowEditor, SwitchRow, TimeZoneSelect } from './form-bits';

export function SettingsDialog({
  automation,
  open,
  onOpenChange,
  disabled,
}: {
  automation: AutomationDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const [name, setName] = useState(automation.name);
  const [description, setDescription] = useState(automation.description ?? '');
  const [settings, setSettings] = useState<AutomationSettings>(automation.settings);
  const save = useAutomationMutation({
    mutationFn: () =>
      api.update(automation.id, {
        name: name.trim() || automation.name,
        description: description.trim() || null,
        settings: clean(settings),
      }),
    invalidate: [automationKeys.root(slug)],
    success: t('auto.settings.saved'),
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('auto.settings.title')}</DialogTitle>
          <DialogDescription>{t('auto.settings.publishHint')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t('auto.name')}>
            <Input value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('auto.description')}>
            <Input
              value={description}
              disabled={disabled}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label={t('auto.settings.reentry')}>
            <ChoiceSelect
              value={settings.reentry ?? 'once'}
              allowEmpty={false}
              disabled={disabled}
              className="w-full"
              choices={[
                { value: 'once', label: t('auto.settings.reentry.once') },
                { value: 'multiple', label: t('auto.settings.reentry.multiple') },
              ]}
              onChange={(reentry) =>
                setSettings({ ...settings, reentry: reentry as 'once' | 'multiple' })
              }
            />
          </Field>
          <div className="grid gap-2">
            <SwitchRow
              label={t('auto.settings.sendWindow')}
              checked={settings.send_window !== undefined}
              disabled={disabled}
              onChange={(on) =>
                setSettings(
                  clean({
                    ...settings,
                    send_window: on
                      ? { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }
                      : undefined,
                  }),
                )
              }
            />
            {settings.send_window ? (
              <SendWindowEditor
                value={settings.send_window}
                disabled={disabled}
                onChange={(send_window) => setSettings({ ...settings, send_window })}
              />
            ) : null}
          </div>
          <Field label={t('auto.settings.timeZone')}>
            <TimeZoneSelect
              value={settings.time_zone}
              emptyLabel={t('auto.goal.tenantZone')}
              disabled={disabled}
              onChange={(time_zone) => setSettings(clean({ ...settings, time_zone }))}
            />
          </Field>
          <WorkspaceTimeZone open={open} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('auto.cancel')}
          </Button>
          {!disabled ? (
            <Button disabled={save.isPending} onClick={() => save.mutate(undefined)}>
              {t('auto.save')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Tenant-wide fallback zone (`/automationSettings`), shared by every automation. */
function WorkspaceTimeZone({ open }: { open: boolean }) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const { canManageSettings } = useAutomationPermissions();
  const current = useQuery({
    queryKey: automationKeys.engineSettings(slug),
    queryFn: () => api.engineSettings(),
    enabled: open,
  });
  const [zone, setZone] = useState<string | undefined>(undefined);
  const save = useAutomationMutation({
    mutationFn: (time_zone: string) => api.updateEngineSettings({ time_zone }),
    invalidate: [automationKeys.engineSettings(slug)],
    success: t('auto.settings.workspaceZoneSaved'),
    onSuccess: () => setZone(undefined),
  });
  const saved = current.data?.time_zone;
  const value = zone ?? saved;
  return (
    <Field label={t('auto.goal.tenantZone')} hint={t('auto.settings.workspaceZoneHint')}>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <TimeZoneSelect
            value={value}
            emptyLabel={saved ?? 'UTC'}
            disabled={!canManageSettings || current.isPending}
            allowTenant={false}
            onChange={setZone}
          />
        </div>
        {canManageSettings ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            disabled={save.isPending || value === undefined || value === saved}
            onClick={() => {
              if (value !== undefined) save.mutate(value);
            }}
          >
            {t('auto.save')}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

export function VersionsDialog({
  automation,
  open,
  onOpenChange,
  canRestore,
  onRestored,
}: {
  automation: AutomationDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean;
  onRestored: (detail: AutomationDetail) => void;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useAutomationApi();
  const { nameOf } = useDirectory();
  const [confirm, setConfirm] = useState<{ id: string; number: number } | null>(null);
  const versions = useQuery({
    queryKey: automationKeys.versions(slug, automation.id),
    queryFn: async () => (await api.versions(automation.id)).data,
    enabled: open,
  });
  const restore = useAutomationMutation({
    mutationFn: async (version: { id: string; number: number }) => ({
      detail: await api.restoreVersion(automation.id, version.id),
      number: version.number,
    }),
    invalidate: [automationKeys.list(slug, 'all')],
    success: (result) => t('auto.versions.restored', { n: result.number }),
    onSuccess: (result) => {
      onRestored(result.detail);
      onOpenChange(false);
    },
  });
  const format = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('auto.versions.title')}</DialogTitle>
          </DialogHeader>
          {versions.data?.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('auto.versions.empty')}</p>
          ) : null}
          <ul className="grid max-h-[60vh] gap-1.5 overflow-auto" data-testid="versions-list">
            {(versions.data ?? []).map((version) => (
              <li key={version.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                <span className="font-mono text-sm font-semibold">v{version.number}</span>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {format(version.published_at)}
                  {version.published_by ? ` · ${nameOf(version.published_by)}` : ''}
                </span>
                {automation.published_version?.id === version.id &&
                automation.status === 'active' ? (
                  <Badge variant="secondary">{t('auto.versions.live')}</Badge>
                ) : null}
                {canRestore ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => setConfirm({ id: version.id, number: version.number })}
                  >
                    {t('auto.versions.restore')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      <DashboardConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next) setConfirm(null);
        }}
        title={t('auto.versions.restore')}
        description={t('auto.versions.restoreConfirm', { n: confirm?.number ?? 0 })}
        confirmLabel={t('auto.versions.restore')}
        cancelLabel={t('auto.cancel')}
        onConfirm={() => {
          if (confirm !== null) restore.mutate(confirm);
          setConfirm(null);
        }}
      />
    </>
  );
}

export function EnrollDialog({
  automationId,
  nodes,
  open,
  onOpenChange,
}: {
  automationId: string;
  nodes: readonly GraphNode[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const [q, setQ] = useState('');
  const [contactId, setContactId] = useState('');
  const [nodeId, setNodeId] = useState('');
  const contacts = useQuery({
    queryKey: ['crm', slug, 'contacts', 'enroll-search', q],
    queryFn: async () => (await api.contacts(q)).data,
    enabled: open,
  });
  const enroll = useAutomationMutation({
    mutationFn: () =>
      api.enroll(automationId, { contact_id: contactId, ...(nodeId ? { node_id: nodeId } : {}) }),
    success: t('auto.enroll.done'),
    onSuccess: () => onOpenChange(false),
  });
  const startNodes = nodes.filter((n) => n.type === 'goal' || n.type === 'sequence');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('auto.enroll.title')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            autoFocus
            value={q}
            placeholder={t('auto.enroll.search')}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="grid max-h-56 gap-1 overflow-auto" data-testid="enroll-contacts">
            {(contacts.data ?? []).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setContactId(c.id)}
                  className={`flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left text-sm ${
                    contactId === c.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                  }`}
                >
                  <span className="truncate">
                    {[c.given_name, c.family_name].filter(Boolean).join(' ') || c.id}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {(c.emails.find((e) => e.is_primary) ?? c.emails[0])?.email}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Field label={t('auto.enroll.node')}>
            <ChoiceSelect
              value={nodeId}
              placeholder={t('auto.enroll.firstGoal')}
              className="w-full"
              choices={startNodes.map((n) => ({
                value: n.id,
                label: `${n.type === 'goal' ? t('auto.node.goal') : t('auto.node.sequence')}: ${('label' in n ? n.label : undefined) ?? n.id}`,
              }))}
              onChange={setNodeId}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('auto.cancel')}
          </Button>
          <Button
            disabled={contactId === '' || enroll.isPending}
            onClick={() => enroll.mutate(undefined)}
          >
            {t('auto.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConflictDialog({
  open,
  onReload,
  onKeep,
  busy,
}: {
  open: boolean;
  onReload: () => void;
  onKeep: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="conflict-dialog">
        <DialogHeader>
          <DialogTitle>{t('auto.conflict.title')}</DialogTitle>
          <DialogDescription>{t('auto.conflict.body')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onKeep}>
            {t('auto.conflict.keep')}
          </Button>
          <Button disabled={busy} onClick={onReload}>
            {t('auto.conflict.reload')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MOD =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const rows: Array<[string[], string]> = [
    [[MOD, 'S'], t('auto.keys.save')],
    [[MOD, 'Z'], t('auto.keys.undo')],
    [[MOD, '⇧', 'Z'], t('auto.keys.redo')],
    [[MOD, 'D'], t('auto.keys.duplicate')],
    [['⌫'], t('auto.keys.delete')],
    [['1', '2', '3', '4'], t('auto.keys.add')],
    [['R'], t('auto.keys.reporting')],
    [['F'], t('auto.keys.fit')],
    [['L'], t('auto.keys.tidy')],
    [['Esc'], t('auto.keys.close')],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('auto.keys.title')}</DialogTitle>
        </DialogHeader>
        <ul className="grid gap-2">
          {rows.map(([keys, label]) => (
            <li key={label} className="flex items-center justify-between gap-3 text-sm">
              <span>{label}</span>
              <span className="flex gap-1">
                {keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
