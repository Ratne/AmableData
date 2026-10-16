import { LiquidHelperProvider, type LiquidHelperSlot } from '@amable/editor';
import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';

const LiquidHelperDrawer = lazy(() => import('./drawer').then((m) => ({ default: m.LiquidHelperDrawer })));

/**
 * Makes the Liquid helper drawer available to every email-mode editor of the
 * workspace (templates, broadcasts, automation emails…). The drawer chunk loads
 * on first open.
 */
export function EmailLiquidHelperProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const slot = useMemo<LiquidHelperSlot>(
    () => ({
      label: t('email.liquid.open'),
      render: (props) =>
        props.open ? (
          <Suspense fallback={null}>
            <LiquidHelperDrawer {...props} />
          </Suspense>
        ) : null,
    }),
    [t],
  );
  return <LiquidHelperProvider slot={slot}>{children}</LiquidHelperProvider>;
}
