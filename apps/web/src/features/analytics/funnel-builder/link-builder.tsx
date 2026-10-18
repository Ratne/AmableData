import type { FunnelGraph, Site } from '@amable/api-types';
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
import { Link } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { useFunnelLinks, useTrafficSources, type FunnelLinksParams } from '../api-funnels';
import { useTrackingDomains } from '../api-tracking-domains';
import { CodeBlock, CopyButton } from '../components/copy';
import { ErrorState, ListSkeleton } from '../components/ui';
import { Field, selectClass, SwitchRow } from './panels/form-bits';
import { liveNodes } from './state';

/** Entrance cost as accepted by the links API: `0.25`, `cpm_12.34` or a platform macro. */
export const LINK_COST_RE = /^[A-Za-z0-9_.{}[\]-]{1,64}$/;

const DEFAULT_DOMAIN = 'default';

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return current;
}

function UrlRow({ label, hint, value }: { label: string; hint?: ReactNode; value: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex min-w-0 items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-foreground/[0.04] px-2.5 py-1.5 font-mono text-[11.5px]"
          title={value}
        >
          {value}
        </code>
        <CopyButton text={value} />
      </div>
    </Field>
  );
}

/**
 * Tracking links of the saved funnel for one traffic source: entrance
 * (redirect) URL, direct-link suffix, action URLs and the universal snippet.
 * Links are derived server-side and never stored: regenerate at will.
 */
export function LinkBuilderDialog({
  tenant,
  site,
  graph,
  dirty,
  initialNodeId,
  onClose,
}: {
  tenant: string;
  site: Site;
  /** Saved graph: links only know what is stored. */
  graph: FunnelGraph;
  dirty: boolean;
  initialNodeId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const sources = useTrafficSources(tenant, site.id, 'active');
  const domains = useTrackingDomains(tenant, site.id);
  const nodes = useMemo(
    () => liveNodes(graph).filter((n) => n.kind !== 'external_url'),
    [graph],
  );
  const traffic = nodes.find((n) => n.kind === 'traffic');
  const [nodeId, setNodeId] = useState(
    nodes.some((n) => n.id === initialNodeId) ? initialNodeId! : (traffic?.id ?? nodes[0]?.id ?? ''),
  );
  const [pageId, setPageId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [cost, setCost] = useState('');
  const [domain, setDomain] = useState(DEFAULT_DOMAIN);
  const [wordpress, setWordpress] = useState(false);

  const node = nodes.find((n) => n.id === nodeId);
  const pages = node?.kind === 'page_group' ? node.config.pages : [];
  const activeDomains = (domains.data?.data ?? []).filter((d) => d.status === 'active');
  const sourceList = sources.data ?? [];
  const source = sourceId || sourceList[0]?.id || '';
  const costText = useDebounced(cost.trim(), 300);
  const costValid = costText === '' || LINK_COST_RE.test(costText);

  const params: FunnelLinksParams | null =
    source && costValid && node
      ? {
          source,
          ...(node.kind === 'traffic' ? {} : { node: node.id }),
          ...(pageId && pages.some((p) => p.id === pageId) ? { page: pageId } : {}),
          ...(domain !== DEFAULT_DOMAIN ? { domain } : {}),
          ...(costText ? { cost: costText } : {}),
          ...(wordpress ? { wordpress: true } : {}),
        }
      : null;
  const links = useFunnelLinks(tenant, site.id, graph.id, graph.version, params);
  const nodeLabel = (n: (typeof nodes)[number]) =>
    `${n.label || t(`analytics.funnelBuilder.kind.${n.kind}`)} · ${n.id}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('analytics.funnelBuilder.links.title')}</DialogTitle>
          <DialogDescription>{t('analytics.funnelBuilder.links.hint')}</DialogDescription>
        </DialogHeader>
        {dirty ? (
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t('analytics.funnelBuilder.links.unsaved')}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('analytics.funnelBuilder.links.source')}>
            {sources.isPending ? (
              <ListSkeleton rows={1} />
            ) : sourceList.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('analytics.funnelBuilder.links.noSources')}{' '}
                <Link
                  to="/t/$tenant/analytics/sources"
                  params={{ tenant }}
                  search={{ site: site.id }}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  {t('analytics.funnelBuilder.links.createSource')}
                </Link>
              </p>
            ) : (
              <select
                className={selectClass}
                value={source}
                onChange={(e) => setSourceId(e.target.value)}
              >
                {sourceList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('analytics.funnelBuilder.links.node')}>
            <select
              className={selectClass}
              value={nodeId}
              onChange={(e) => {
                setNodeId(e.target.value);
                setPageId('');
              }}
            >
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {nodeLabel(n)}
                </option>
              ))}
            </select>
          </Field>
          {pages.length > 0 ? (
            <Field label={t('analytics.funnelBuilder.links.page')}>
              <select
                className={selectClass}
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
              >
                <option value="">{t('analytics.funnelBuilder.links.pageRotate')}</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label={t('analytics.funnelBuilder.links.domain')}>
            <select
              className={selectClass}
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              <option value={DEFAULT_DOMAIN}>{t('analytics.funnelBuilder.links.domainDefault')}</option>
              {activeDomains.map((d) => (
                <option key={d.id} value={d.hostname}>
                  {d.hostname}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('analytics.funnelBuilder.links.cost')}
            hint={
              cost.trim() !== '' && !LINK_COST_RE.test(cost.trim()) ? (
                <span className="text-destructive">
                  {t('analytics.funnelBuilder.links.costInvalid')}
                </span>
              ) : (
                t('analytics.funnelBuilder.links.costHint')
              )
            }
          >
            <Input
              className="h-8"
              value={cost}
              placeholder="0.25"
              maxLength={64}
              aria-invalid={cost.trim() !== '' && !LINK_COST_RE.test(cost.trim())}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
          <div className="self-end pb-1">
            <SwitchRow
              label={t('analytics.funnelBuilder.links.wordpress')}
              hint={t('analytics.funnelBuilder.links.wordpressHint')}
              checked={wordpress}
              onChange={setWordpress}
            />
          </div>
        </div>

        {params === null ? null : links.error ? (
          <ErrorState error={links.error} compact />
        ) : !links.data ? (
          <ListSkeleton rows={3} />
        ) : (
          <div className="grid gap-3 border-t pt-3">
            <UrlRow
              label={t('analytics.funnelBuilder.links.entrance')}
              hint={t('analytics.funnelBuilder.links.entranceHint')}
              value={links.data.entrance_url}
            />
            {links.data.direct_suffix ? (
              <UrlRow
                label={t('analytics.funnelBuilder.links.directSuffix')}
                hint={t('analytics.funnelBuilder.links.directSuffixHint')}
                value={links.data.direct_suffix}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('analytics.funnelBuilder.links.noDirect')}
              </p>
            )}
            {links.data.direct_url ? (
              <UrlRow
                label={t('analytics.funnelBuilder.links.directUrl')}
                value={links.data.direct_url}
              />
            ) : null}
            {links.data.action_urls.length > 0 ? (
              <Field label={t('analytics.funnelBuilder.links.actions')}>
                <ul className="grid gap-1.5">
                  {links.data.action_urls.map((a) => (
                    <li key={a.action} className="grid gap-1">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {t('analytics.funnelBuilder.links.action', { n: a.action })}
                      </span>
                      <div className="flex min-w-0 items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/[0.04] px-2.5 py-1 font-mono text-[11.5px]">
                          {a.url}
                        </code>
                        <CopyButton text={a.url} />
                      </div>
                      <div className="flex min-w-0 items-center gap-2">
                        <code
                          className="min-w-0 flex-1 truncate px-2.5 font-mono text-[11px] text-muted-foreground"
                          title={t('analytics.funnelBuilder.links.actionDefaultHint')}
                        >
                          {a.default_url}
                        </code>
                        <CopyButton
                          text={a.default_url}
                          label={t('analytics.funnelBuilder.links.copyFallback')}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </Field>
            ) : null}
            <Field
              label={t('analytics.funnelBuilder.links.snippet')}
              hint={t('analytics.funnelBuilder.links.snippetHint')}
            >
              <CodeBlock code={links.data.snippet} />
            </Field>
          </div>
        )}
        <DialogFooter>
          <DashboardButton variant="secondary" onClick={onClose}>
            {t('analytics.funnelBuilder.links.close')}
          </DashboardButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
