import { useIsFetching } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { usePendingWrites } from '../lib/activity';
import { router } from '../router';

/** Below this, work ends before a bar would be noticed: showing it would only flicker. */
const SHOW_AFTER_MS = 150;

/**
 * Thin indeterminate bar at the top of the window while something the user waits
 * for is in progress: a save, a page change, data loaded for the first time.
 * Background refetches of data already on screen do not count.
 */
export function ActivityBar() {
  const { t } = useI18n();
  const writes = usePendingWrites();
  const firstLoads = useIsFetching({ predicate: (query) => query.state.data === undefined });
  const navigating = useRouterState({ router, select: (state) => state.status === 'pending' });
  const active = writes > 0 || firstLoads > 0 || navigating;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!visible) return null;
  return (
    <div role="progressbar" aria-busy="true" aria-label={t('common.loading')} className="amb-activity-bar">
      <span />
    </div>
  );
}
