import type {
  LandingPage as ApiLandingPage,
  LandingPageDetail,
  SavedSection as ApiSavedSection,
} from '@amable/api-types';
import type { BuilderDocument, ElementNode, HtmlDocument, PageDocument } from '@amable/builder';

export type {
  CreatePageInput,
  MediaFile,
  PageSeo,
  PageSettings,
  PageStatus,
  PageVersion,
  UpdatePageInput,
} from '@amable/api-types';

export type LandingPage = ApiLandingPage;

/** Page detail with the draft typed as a page document (the server validates it). */
export type LandingPageWithDraft = Omit<LandingPageDetail, 'draft'> & { readonly draft: PageDocument };

/** Page detail of a canvas page (what the visual editor opens). */
export type CanvasPageWithDraft = Omit<LandingPageDetail, 'draft'> & { readonly draft: BuilderDocument };

/** Page detail of a raw HTML page (opened in the source editor). */
export type HtmlPageWithDraft = Omit<LandingPageDetail, 'draft'> & { readonly draft: HtmlDocument };

export function isHtmlPage(page: LandingPageWithDraft): page is HtmlPageWithDraft {
  return page.draft.editorKind === 'html';
}

export function isCanvasPage(page: LandingPageWithDraft): page is CanvasPageWithDraft {
  return page.draft.editorKind !== 'html';
}

/** Saved section with its node typed as a builder element. */
export type SavedSection = Omit<ApiSavedSection, 'node'> & { readonly node: ElementNode };


export interface CursorPage<T> {
  readonly data: T[];
  readonly next_cursor: string | null;
}

/** Booking event type as far as the widget picker needs it. */
export interface EventTypeOption {
  readonly slug: string;
  readonly name: string;
}

export interface FormOption {
  readonly id: string;
  readonly name: string;
}

export interface AnalyticsSiteOption {
  readonly id: string;
  readonly name: string;
  readonly hostnames: readonly string[];
}
