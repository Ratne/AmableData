import { PAGE_TYPES, type FunnelNodeOf, type FunnelPage, type PageType } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Pause, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { Segmented } from '../../components/ui';
import { usePageResources } from '../resources';
import { nextId } from '../state';
import { Field, KeyValueEditor, NumberInput, selectClass, SwitchRow } from './form-bits';

type Node = FunnelNodeOf<'page_group'>;

function PageRow({
  page,
  share,
  onChange,
  onRemove,
}: {
  page: FunnelPage;
  share: number;
  onChange: (page: FunnelPage) => void;
  onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const resources = usePageResources();
  const source = page.amable_page_id !== undefined ? 'amable' : 'url';
  const known = resources.some((r) => r.id === page.amable_page_id);
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return (
    <li className={cn('grid gap-2 rounded-lg border p-2', page.paused && 'opacity-60')}>
      <div className="flex items-center gap-1.5">
        <Input
          className="h-8 flex-1"
          aria-label={t('analytics.funnelBuilder.panel.pageName')}
          placeholder={t('analytics.funnelBuilder.panel.pageName')}
          value={page.name}
          onChange={(e) => onChange({ ...page, name: e.target.value })}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t('analytics.funnelBuilder.panel.removePage')}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>
      <Segmented
        label={t('analytics.funnelBuilder.panel.source.url')}
        options={[
          { value: 'url', label: t('analytics.funnelBuilder.panel.source.url') },
          { value: 'amable', label: t('analytics.funnelBuilder.panel.source.amable') },
        ]}
        value={source}
        onChange={(next) => {
          const { url: _url, amable_page_id: _page, ...rest } = page;
          onChange(next === 'url' ? { ...rest, url: '' } : { ...rest, amable_page_id: '' });
        }}
      />
      {source === 'url' ? (
        <Input
          className="h-8"
          placeholder="https://"
          aria-label={t('analytics.funnelBuilder.panel.url')}
          value={page.url ?? ''}
          onChange={(e) => onChange({ ...page, url: e.target.value })}
        />
      ) : resources.length === 0 ? (
        <Input
          className="h-8"
          placeholder={t('analytics.funnelBuilder.panel.pageId')}
          aria-label={t('analytics.funnelBuilder.panel.pageId')}
          value={page.amable_page_id ?? ''}
          onChange={(e) => onChange({ ...page, amable_page_id: e.target.value.trim() })}
        />
      ) : (
        <select
          className={selectClass}
          aria-label={t('analytics.funnelBuilder.panel.pickPage')}
          value={page.amable_page_id ?? ''}
          onChange={(e) => {
            const picked = resources.find((r) => r.id === e.target.value);
            onChange({
              ...page,
              amable_page_id: e.target.value,
              ...(picked && !page.name ? { name: picked.name } : {}),
            });
          }}
        >
          <option value="">{t('analytics.funnelBuilder.panel.pickPage')}</option>
          {!known && page.amable_page_id ? (
            <option value={page.amable_page_id}>{page.amable_page_id}</option>
          ) : null}
          {resources.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('analytics.funnelBuilder.panel.weight')}</span>
        <NumberInput
          className="w-20"
          ariaLabel={t('analytics.funnelBuilder.panel.weight')}
          value={page.weight}
          min={0.01}
          max={10_000}
          onChange={(weight) => onChange({ ...page, weight })}
        />
        <span className="flex-1 text-muted-foreground tabular-nums">
          {t('analytics.funnelBuilder.panel.share', { pct: pct.format(share) })}
        </span>
        <label className="flex items-center gap-1.5">
          <Pause className="size-3 text-muted-foreground" aria-hidden />
          <span className="sr-only">{t('analytics.funnelBuilder.panel.paused')}</span>
          <Switch
            checked={page.paused}
            onCheckedChange={(paused) => onChange({ ...page, paused })}
          />
        </label>
      </div>
    </li>
  );
}

export function PageGroupPanel({ node, onChange }: { node: Node; onChange: (node: Node) => void }) {
  const { t } = useI18n();
  const config = node.config;
  const set = (patch: Partial<Node['config']>) =>
    onChange({ ...node, config: { ...config, ...patch } });
  const active = config.pages.filter((p) => !p.paused);
  const total = active.reduce((sum, p) => sum + p.weight, 0);
  const setPages = (pages: FunnelPage[]) => set({ pages });

  return (
    <>
      <Field label={t('analytics.funnelBuilder.panel.pageType')}>
        <Segmented
          label={t('analytics.funnelBuilder.panel.pageType')}
          options={PAGE_TYPES.map((p) => ({
            value: p,
            label: t(`analytics.funnelBuilder.panel.pageType.${p}`),
          }))}
          value={config.page_type}
          onChange={(page_type: PageType) => set({ page_type })}
        />
      </Field>
      <Field label={t('analytics.funnelBuilder.panel.pages')}>
        <ul className="grid gap-2">
          {config.pages.map((page, i) => (
            <PageRow
              key={page.id}
              page={page}
              share={
                page.paused || total === 0 || config.map_action_to_page ? 0 : page.weight / total
              }
              onChange={(next) => setPages(config.pages.map((p, j) => (j === i ? next : p)))}
              onRemove={() => setPages(config.pages.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="h-7 justify-self-start text-xs"
          disabled={config.pages.length >= 50}
          onClick={() =>
            setPages([
              ...config.pages,
              {
                id: nextId(
                  'p',
                  config.pages.map((p) => p.id),
                ),
                name: '',
                url: '',
                weight: 100,
                paused: false,
              },
            ])
          }
        >
          <Plus className="size-3.5" aria-hidden />
          {t('analytics.funnelBuilder.panel.addPage')}
        </Button>
      </Field>
      <SwitchRow
        label={t('analytics.funnelBuilder.panel.mapAction')}
        hint={t('analytics.funnelBuilder.panel.mapActionHint')}
        checked={config.map_action_to_page}
        onChange={(map_action_to_page) => set({ map_action_to_page })}
      />
      <Field label={t('analytics.funnelBuilder.panel.dataParams')}>
        <KeyValueEditor
          value={config.data_params}
          addLabel={t('analytics.funnelBuilder.panel.addParam')}
          onChange={(data_params) => {
            const { data_params: _drop, ...rest } = config;
            onChange({ ...node, config: data_params ? { ...rest, data_params } : rest });
          }}
        />
      </Field>
    </>
  );
}
