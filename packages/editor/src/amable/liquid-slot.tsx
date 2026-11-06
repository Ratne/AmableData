import { createContext, useContext, type ReactNode } from 'react';
import type { LiquidFieldGroup } from './fields';

/**
 * Slot for the app's Liquid helper drawer. The app provides it once (with its
 * API client, translations and UI kit); every email-mode `AmableEditor` below
 * the provider then shows a toolbar button that opens it.
 *
 * Kept free of editor and renderer imports: app layouts mount the provider on
 * every page, so it must not pull the editor bundle in.
 */

export interface LiquidHelperHost {
  /** Inserts Liquid at the cursor: a simple output tag becomes a field chip, anything else a raw Liquid block. */
  insert(code: string): void;
  /** The document's Liquid as the plain-text part renders it (for the whole-email preview). */
  source(): string;
}

export interface LiquidHelperRenderProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly host: LiquidHelperHost;
  readonly fields: readonly LiquidFieldGroup[];
}

export interface LiquidHelperSlot {
  readonly label: string;
  readonly render: (props: LiquidHelperRenderProps) => ReactNode;
}

const LiquidHelperContext = createContext<LiquidHelperSlot | null>(null);

export function LiquidHelperProvider({
  slot,
  children,
}: {
  slot: LiquidHelperSlot;
  children: ReactNode;
}) {
  return <LiquidHelperContext.Provider value={slot}>{children}</LiquidHelperContext.Provider>;
}

export function useLiquidHelperSlot(): LiquidHelperSlot | null {
  return useContext(LiquidHelperContext);
}
