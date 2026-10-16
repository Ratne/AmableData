import type { BuilderDocument } from "./document";

/** A published page as the core gateway hands it to the edge for SSR. */
export interface PublishedPage {
  page: { id: string; title: string; path: string; host: string | null };
  version: { id: string; version: number; published_at: number };
  document: BuilderDocument;
  seo: {
    title: string | null;
    description: string | null;
    og_image: string | null;
    canonical: string | null;
    noindex: boolean;
  };
  settings: { analytics_site_id: string | null; favicon: string | null; lang: string | null };
}

/**
 * Edge ↔ core gateway ops of the landing pages (see @amable/api-types
 * edge-gateway). `host` null addresses the `/p/<slug>/…` URLs.
 * Raw op `pages.media` ({ file }) streams a media file from R2.
 */
export interface PagesGatewayOps {
  "pages.resolve": { input: { host: string | null; path: string }; output: PublishedPage };
  "pages.sitemap": {
    input: { host: string | null };
    output: { data: Array<{ path: string; published_at: number }> };
  };
  [op: string]: { input: unknown; output: unknown };
}
