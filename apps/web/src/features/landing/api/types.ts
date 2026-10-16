import type {
  EditLockHolder,
  EditLockState,
  LandingPage as ApiLandingPage,
  LandingPageDetail,
  SavedSection as ApiSavedSection,
} from '@amable/api-types';
import type { BuilderDocument, ElementNode } from '@amable/builder';

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

/** Page detail with the draft typed as a builder document (the server validates it). */
export type LandingPageWithDraft = Omit<LandingPageDetail, 'draft'> & { readonly draft: BuilderDocument };

/** Saved section with its node typed as a builder element. */
export type SavedSection = Omit<ApiSavedSection, 'node'> & { readonly node: ElementNode };

export type LockHolder = EditLockHolder;
export type LockState = EditLockState;

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
