import type { FunnelPage, LandingPage, TrafficSource } from '@amable/api-types';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

/** An AmableCRM page the palette and the page group panel can pick. */
export interface PageResource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export function pageResources(pages: readonly LandingPage[]): PageResource[] {
  return pages
    .filter((p) => p.deleted_at === null)
    .map((p) => ({ id: p.id, name: p.title || p.path, url: p.public_url }));
}

export function resourcePage(resource: PageResource, id: string): FunnelPage {
  return { id, name: resource.name, amable_page_id: resource.id, weight: 100, paused: false };
}

/** What the side panels pick from: AmableCRM pages, the site's traffic sources, the API scope. */
export interface BuilderResources {
  readonly tenant: string;
  readonly siteId: string;
  readonly pages: readonly PageResource[];
  readonly sources: readonly TrafficSource[];
}

const ResourcesContext = createContext<BuilderResources>({
  tenant: '',
  siteId: '',
  pages: [],
  sources: [],
});

export function BuilderResourcesProvider({
  tenant,
  siteId,
  pages,
  sources,
  children,
}: BuilderResources & { children: ReactNode }) {
  const value = useMemo(() => ({ tenant, siteId, pages, sources }), [tenant, siteId, pages, sources]);
  return <ResourcesContext.Provider value={value}>{children}</ResourcesContext.Provider>;
}

export function useBuilderResources(): BuilderResources {
  return useContext(ResourcesContext);
}

export function usePageResources(): readonly PageResource[] {
  return useContext(ResourcesContext).pages;
}
