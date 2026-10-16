import type { Funnel, FunnelStep } from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { analyticsApi, analyticsKeys, useAnalyticsMutation } from '../api';

const MIN_STEPS = 2;
const MAX_STEPS = 8;
const select =
  'h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

interface Draft {
  readonly key: number;
  type: FunnelStep['type'];
  value: string;
  match: FunnelStep['match'];
  label: string;
}

let nextKey = 1;
const blank = (type: FunnelStep['type'] = 'pageview'): Draft => ({
  key: nextKey++,
  type,
  value: '',
  match: 'exact',
  label: '',
});

export function FunnelEditor({
  tenant,
  siteId,
  funnel,
  onClose,
  onSaved,
}: {
  tenant: string;
  siteId: string;
  funnel: Funnel | null;
  onClose: () => void;
  onSaved: (funnel: Funnel) => void;
}) {
  const { t } = useI18n();
  const api = analyticsApi(tenant);
  const [name, setName] = useState(funnel?.name ?? '');
  const [steps, setSteps] = useState<Draft[]>(() =>
    funnel
      ? funnel.steps.map((step) => ({
          key: nextKey++,
          type: step.type,
          value: step.value,
          match: step.match,
          label: step.label ?? '',
        }))
      : [blank(), blank('goal')],
  );
  const save = useAnalyticsMutation(
    tenant,
    () => {
      const input = {
        name: name.trim(),
        steps: steps.map((step) => ({
          type: step.type,
          value: step.value.trim(),
          match: step.type === 'pageview' ? step.match : ('exact' as const),
          ...(step.label.trim() ? { label: step.label.trim() } : {}),
        })),
      };
      return funnel
        ? api.funnels.update(siteId, funnel.id, input)
        : api.funnels.create(siteId, input);
    },
    {
      invalidate: [analyticsKeys.site(tenant, siteId, 'funnels')],
      success: funnel ? 'analytics.funnels.updated' : 'analytics.funnels.created',
      onSuccess: (saved) => onSaved(saved),
    },
  );

  const patch = (key: number, change: Partial<Draft>) =>
    setSteps((current) =>
      current.map((step) => (step.key === key ? { ...step, ...change } : step)),
    );
  const move = (index: number, delta: number) =>
    setSteps((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return next;
    });
  const valid =
    name.trim().length > 0 &&
    steps.length >= MIN_STEPS &&
    steps.length <= MAX_STEPS &&
    steps.every(
      (step) =>
        step.value.trim().length > 0 &&
        (step.type === 'pageview' || /^[a-z0-9_]{1,64}$/.test(step.value.trim().toLowerCase())),
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {funnel ? t('analytics.funnels.editTitle') : t('analytics.funnels.newTitle')}
            </DialogTitle>
            <DialogDescription>{t('analytics.funnels.editorHint')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="amb-funnel-name">{t('analytics.common.name')}</Label>
            <Input
              id="amb-funnel-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('analytics.funnels.namePlaceholder')}
            />
          </div>
          <ol className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-1">
            {steps.map((step, index) => (
              <li key={step.key} className="flex flex-col gap-2 rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-medium text-primary">
                    {index + 1}
                  </span>
                  <select
                    className={select}
                    value={step.type}
                    aria-label={t('analytics.funnels.stepType')}
                    onChange={(event) =>
                      patch(step.key, { type: event.target.value === 'goal' ? 'goal' : 'pageview' })
                    }
                  >
                    <option value="pageview">{t('analytics.funnels.pageview')}</option>
                    <option value="goal">{t('analytics.funnels.goal')}</option>
                  </select>
                  {step.type === 'pageview' ? (
                    <select
                      className={select}
                      value={step.match}
                      aria-label={t('analytics.funnels.match')}
                      onChange={(event) =>
                        patch(step.key, {
                          match: event.target.value === 'contains' ? 'contains' : 'exact',
                        })
                      }
                    >
                      <option value="exact">{t('analytics.funnels.exact')}</option>
                      <option value="contains">{t('analytics.filter.contains')}</option>
                    </select>
                  ) : null}
                  <Input
                    className="h-8 flex-1 font-mono text-xs"
                    value={step.value}
                    maxLength={255}
                    aria-label={t('analytics.funnels.stepValue')}
                    placeholder={step.type === 'pageview' ? '/pricing' : 'signup'}
                    onChange={(event) => patch(step.key, { value: event.target.value })}
                  />
                  <div className="flex shrink-0 items-center">
                    <DashboardButton
                      variant="ghost"
                      size="icon"
                      aria-label={t('analytics.common.moveUp')}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp aria-hidden />
                    </DashboardButton>
                    <DashboardButton
                      variant="ghost"
                      size="icon"
                      aria-label={t('analytics.common.moveDown')}
                      disabled={index === steps.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown aria-hidden />
                    </DashboardButton>
                    <DashboardButton
                      variant="ghost"
                      size="icon"
                      aria-label={t('analytics.common.remove')}
                      disabled={steps.length <= MIN_STEPS}
                      onClick={() =>
                        setSteps((current) => current.filter((item) => item.key !== step.key))
                      }
                    >
                      <Trash2 aria-hidden />
                    </DashboardButton>
                  </div>
                </div>
                <Input
                  className="h-7 text-xs"
                  value={step.label}
                  maxLength={100}
                  placeholder={t('analytics.funnels.labelPlaceholder')}
                  aria-label={t('analytics.funnels.label')}
                  onChange={(event) => patch(step.key, { label: event.target.value })}
                />
              </li>
            ))}
          </ol>
          <DashboardButton
            variant="secondary"
            className="self-start"
            disabled={steps.length >= MAX_STEPS}
            onClick={() => setSteps((current) => [...current, blank()])}
          >
            <Plus aria-hidden />
            {t('analytics.funnels.addStep', { max: MAX_STEPS })}
          </DashboardButton>
          <DialogFooter>
            <DashboardButton variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </DashboardButton>
            <DashboardButton type="submit" variant="primary" disabled={!valid || save.isPending}>
              {t('common.save')}
            </DashboardButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
