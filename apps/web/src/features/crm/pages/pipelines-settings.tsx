import { STAGE_KINDS, type Pipeline, type Stage } from '@amable/api-types/crm';
import {
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  PageToolbar,
  usePageChrome,
} from '@amable/ui';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { crmKeys, useCrm, useCrmMutation, usePermissions, usePipelines } from '../api/hooks';
import { ChoiceSelect } from '../components/inputs';
import { PageState } from '../components/states';
import { reorder } from '../reorder';

function StageRow({
  pipeline,
  stage,
  index,
  canManage,
  onMove,
  onDelete,
}: {
  pipeline: Pipeline;
  stage: Stage;
  index: number;
  canManage: boolean;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const [name, setName] = useState(stage.name);
  const [probability, setProbability] = useState(String(stage.probability));
  const update = useCrmMutation({
    mutationFn: (input: { name?: string; probability?: number; kind?: Stage['kind'] }) =>
      api.pipelines.updateStage(pipeline.id, stage.id, input),
    invalidate: [crmKeys.pipelines(slug)],
  });
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      <Input
        value={name}
        disabled={!canManage}
        aria-label={t('crm.pipelines.stageName')}
        className="h-8 min-w-40 flex-1"
        onChange={(e) => setName(e.target.value)}
        onBlur={() =>
          name.trim() && name !== stage.name ? update.mutate({ name: name.trim() }) : undefined
        }
      />
      <div className="flex items-center gap-1">
        <Input
          value={probability}
          disabled={!canManage}
          inputMode="numeric"
          aria-label={t('crm.pipelines.probability')}
          className="h-8 w-16 text-right tabular-nums"
          onChange={(e) => setProbability(e.target.value)}
          onBlur={() => {
            const n = Number(probability);
            if (Number.isInteger(n) && n >= 0 && n <= 100 && n !== stage.probability)
              update.mutate({ probability: n });
            else setProbability(String(stage.probability));
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
      <ChoiceSelect
        value={stage.kind}
        allowEmpty={false}
        disabled={!canManage}
        ariaLabel={t('crm.pipelines.kind')}
        className="w-28 min-w-0"
        choices={STAGE_KINDS.map((kind) => ({
          value: kind,
          label: t(`crm.pipelines.kind.${kind}`),
        }))}
        onChange={(kind) => update.mutate({ kind: kind as Stage['kind'] })}
      />
      {canManage ? (
        <span className="flex">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={index === 0}
            aria-label={t('crm.common.moveUp')}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={index === pipeline.stages.length - 1}
            aria-label={t('crm.common.moveDown')}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('list.delete')}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </span>
      ) : null}
    </li>
  );
}

function PipelineCard({ pipeline, canManage }: { pipeline: Pipeline; canManage: boolean }) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const [name, setName] = useState(pipeline.name);
  const [newStage, setNewStage] = useState('');
  const [confirm, setConfirm] = useState<
    { kind: 'pipeline' } | { kind: 'stage'; stage: Stage } | null
  >(null);
  const invalidate = [crmKeys.pipelines(slug)];
  const run = useCrmMutation({
    mutationFn: (job: () => Promise<unknown>) => job(),
    invalidate,
    onSuccess: () => setConfirm(null),
  });
  const stages = [...pipeline.stages].sort((a, b) => a.position - b.position);
  return (
    <section className="rounded-xl border bg-card p-4" aria-label={pipeline.name}>
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <Input
          value={name}
          disabled={!canManage}
          aria-label={t('crm.pipelines.name')}
          className="h-8 max-w-xs font-semibold"
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name !== pipeline.name
              ? run.mutate(() => api.pipelines.update(pipeline.id, { name: name.trim() }))
              : undefined
          }
        />
        {pipeline.is_default ? (
          <Badge variant="secondary">
            <Star className="size-3" aria-hidden /> {t('crm.pipelines.default')}
          </Badge>
        ) : canManage ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              run.mutate(() => api.pipelines.update(pipeline.id, { is_default: true }))
            }
          >
            {t('crm.pipelines.makeDefault')}
          </Button>
        ) : null}
        {canManage ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setConfirm({ kind: 'pipeline' })}
          >
            <Trash2 className="size-3.5" aria-hidden /> {t('list.delete')}
          </Button>
        ) : null}
      </header>
      <ul className="divide-y">
        {stages.map((stage, index) => (
          <StageRow
            key={stage.id}
            pipeline={{ ...pipeline, stages }}
            stage={stage}
            index={index}
            canManage={canManage}
            onDelete={() => setConfirm({ kind: 'stage', stage })}
            onMove={(delta) =>
              run.mutate(() =>
                reorder(stages, index, delta, (item, position) =>
                  api.pipelines.updateStage(pipeline.id, item.id, { position }),
                ),
              )
            }
          />
        ))}
      </ul>
      {canManage ? (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newStage.trim()) return;
            run.mutate(async () => {
              await api.pipelines.addStage(pipeline.id, {
                name: newStage.trim(),
                position: stages.length,
              });
              setNewStage('');
            });
          }}
        >
          <Input
            value={newStage}
            placeholder={t('crm.pipelines.newStage')}
            aria-label={t('crm.pipelines.newStage')}
            className="h-8 max-w-xs"
            onChange={(e) => setNewStage(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!newStage.trim()}>
            <Plus className="size-3.5" aria-hidden /> {t('crm.common.add')}
          </Button>
        </form>
      ) : null}
      <DashboardConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => (open ? undefined : setConfirm(null))}
        title={
          confirm?.kind === 'stage'
            ? t('crm.pipelines.confirmDeleteStage', { name: confirm.stage.name })
            : t('crm.pipelines.confirmDelete', { name: pipeline.name })
        }
        description={t('crm.pipelines.confirmDeleteBody')}
        confirmLabel={t('list.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (confirm?.kind === 'stage')
            run.mutate(() => api.pipelines.removeStage(pipeline.id, confirm.stage.id));
          else if (confirm?.kind === 'pipeline')
            run.mutate(() => api.pipelines.remove(pipeline.id));
        }}
      />
    </section>
  );
}

export function PipelinesSettingsPage() {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const { can } = usePermissions();
  const pipelines = usePipelines();
  usePageChrome({ title: t('nav.pipelines') });
  const create = useCrmMutation({
    mutationFn: () => api.pipelines.create({ name: t('crm.pipelines.untitled') }),
    invalidate: [crmKeys.pipelines(slug)],
    success: t('crm.pipelines.created'),
  });
  const canManage = can('settings:manage');
  return (
    <PageState isPending={pipelines.isPending} error={pipelines.error}>
      {() => (
        <>
          <PageToolbar
            actions={
              canManage ? (
                <DashboardButton variant="primary" onClick={() => create.mutate(undefined)}>
                  <Plus aria-hidden /> {t('crm.pipelines.new')}
                </DashboardButton>
              ) : null
            }
          />
          <PageBody className="grid gap-4">
            {(pipelines.data ?? []).map((pipeline) => (
              <PipelineCard key={pipeline.id} pipeline={pipeline} canManage={canManage} />
            ))}
            {(pipelines.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('crm.pipelines.empty')}</p>
            ) : null}
          </PageBody>
        </>
      )}
    </PageState>
  );
}
