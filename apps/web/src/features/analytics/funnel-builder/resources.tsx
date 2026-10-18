import type { FunnelPage, LandingPage } from '@amable/api-types';
import { createContext, useContext, type ReactNode } from 'react';

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

const PagesContext = createContext<readonly PageResource[]>([]);

export function BuilderResourcesProvider({
  pages,
  children,
}: {
  pages: readonly PageResource[];
  children: ReactNode;
}) {
  return <PagesContext.Provider value={pages}>{children}</PagesContext.Provider>;
}

export function usePageResources(): readonly PageResource[] {
  return useContext(PagesContext);
}
