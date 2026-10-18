import type { FunnelNodeKind, PageType } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Files } from 'lucide-react';
import { useState, type DragEvent, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { Segmented } from '../components/ui';
import { KIND_META, PALETTE_KINDS } from './nodes/kind-meta';
import { usePageResources, type PageResource } from './resources';

export const PALETTE_MIME = 'application/x-amable-funnel-node';

/** What a palette tile creates: an empty node or a page group with an existing page. */
export type PaletteItem =
  | { readonly kind: FunnelNodeKind }
  | { readonly kind: 'page_group'; readonly resource: PageResource; readonly pageType: PageType };

function Tile({
  item,
  icon,
  label,
  tone,
  disabled,
  onAdd,
}: {
  item: PaletteItem;
  icon: ReactNode;
  label: string;
  tone: string;
  disabled?: boolean;
  onAdd: (item: PaletteItem) => void;
}) {
  return (
    <button
      type="button"
      draggable={!disabled}
      disabled={disabled}
      onDragStart={(event: DragEvent<HTMLButtonElement>) => {
        event.dataTransfer.setData(PALETTE_MIME, JSON.stringify(item));
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onAdd(item)}
      className="flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
      data-testid={`funnel-palette-${'resource' in item ? item.resource.id : item.kind}`}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded', tone)}>
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Left rail: node kinds and the AmableCRM pages, draggable onto the canvas or clickable. */
export function FunnelPalette({
  hasTraffic,
  onAdd,
}: {
  hasTraffic: boolean;
  onAdd: (item: PaletteItem) => void;
}) {
  const { t } = useI18n();
  const pages = usePageResources();
  const [type, setType] = useState<PageType>('lander');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = needle ? pages.filter((p) => p.name.toLowerCase().includes(needle)) : pages;
  const heading =
    'px-2 pt-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase';
  return (
    <aside
      className="flex w-52 shrink-0 flex-col border-r bg-background"
      aria-label={t('analytics.funnelBuilder.palette.hint')}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className={heading}>{t('analytics.funnelBuilder.palette.nodes')}</p>
        {PALETTE_KINDS.map((kind) => {
          const Icon = KIND_META[kind].icon;
          return (
            <Tile
              key={kind}
              item={{ kind }}
              icon={<Icon className="size-3" />}
              label={t(`analytics.funnelBuilder.kind.${kind}`)}
              tone={KIND_META[kind].tone}
              disabled={kind === 'traffic' && hasTraffic}
              onAdd={onAdd}
            />
          );
        })}
        <p className={cn(heading, 'pt-3')}>{t('analytics.funnelBuilder.palette.resources')}</p>
        <Segmented
          className="mx-2 mb-1"
          label={t('analytics.funnelBuilder.palette.resources')}
          options={[
            { value: 'lander', label: t('analytics.funnelBuilder.palette.landers') },
            { value: 'offer', label: t('analytics.funnelBuilder.palette.offers') },
          ]}
          value={type}
          onChange={setType}
        />
        {pages.length > 6 ? (
          <Input
            className="mx-2 mb-1 h-7 w-[calc(100%-1rem)] text-xs"
            placeholder={t('analytics.funnelBuilder.palette.search')}
            aria-label={t('analytics.funnelBuilder.palette.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        {pages.length === 0 ? (
          <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground">
            {t('analytics.funnelBuilder.palette.noPages')}
          </p>
        ) : null}
        {shown.map((resource) => (
          <Tile
            key={resource.id}
            item={{ kind: 'page_group', resource, pageType: type }}
            icon={<Files className="size-3" />}
            label={resource.name}
            tone={KIND_META.page_group.tone}
            onAdd={onAdd}
          />
        ))}
      </div>
      <p className="border-t p-2 text-[10px] leading-snug text-muted-foreground">
        {t('analytics.funnelBuilder.palette.hint')}
      </p>
    </aside>
  );
}
