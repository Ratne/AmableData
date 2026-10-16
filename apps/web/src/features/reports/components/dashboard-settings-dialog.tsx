import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { Field, SwitchRow } from '../../automations/components/form-bits';

export interface DashboardSettings {
  readonly name: string;
  readonly shared: boolean;
  readonly is_default: boolean;
}

export interface DashboardSettingsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly initial: DashboardSettings;
  /** Owner/admin only: making a dashboard the workspace home. */
  readonly canSetDefault: boolean;
  readonly pending: boolean;
  readonly onSubmit: (settings: DashboardSettings) => void;
}

function SettingsForm({
  initial,
  canSetDefault,
  pending,
  onSubmit,
  onCancel,
}: Omit<DashboardSettingsDialogProps, 'open' | 'onOpenChange' | 'title'> & {
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState(initial);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (state.name.trim() === '') return;
        // The home dashboard is always visible to the whole workspace.
        onSubmit({ ...state, name: state.name.trim(), shared: state.shared || state.is_default });
      }}
    >
      <Field label={t('rep.dash.name')}>
        <Input
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          maxLength={200}
          autoFocus
          data-testid="dashboard-name"
        />
      </Field>
      <div className="grid gap-1">
        <SwitchRow
          label={t('rep.dash.shared')}
          checked={state.shared || state.is_default}
          disabled={state.is_default}
          onChange={(shared) => setState((s) => ({ ...s, shared }))}
        />
        <p className="text-[11px] text-muted-foreground">{t('rep.dash.sharedHint')}</p>
      </div>
      {canSetDefault ? (
        <div className="grid gap-1">
          <SwitchRow
            label={t('rep.dash.default')}
            checked={state.is_default}
            onChange={(is_default) => setState((s) => ({ ...s, is_default }))}
          />
          <p className="text-[11px] text-muted-foreground">{t('rep.dash.defaultHint')}</p>
        </div>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('rep.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={pending || state.name.trim() === ''}
          data-testid="dashboard-submit"
        >
          {t('rep.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function DashboardSettingsDialog({
  open,
  onOpenChange,
  title,
  ...props
}: DashboardSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {open ? <SettingsForm {...props} onCancel={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
