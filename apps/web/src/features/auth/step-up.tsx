import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { registerStepUpPrompt } from '../../lib/step-up';
import { authApi, type ChallengeState } from './api';
import { SecondFactorForm } from './pages/challenge';

/**
 * App-wide step-up dialog: any request answered `step_up_required` opens it
 * (see `stepUpFetch`), and the request is replayed once the factor is verified.
 */
export function StepUpProvider() {
  const { t } = useI18n();
  const [challenge, setChallenge] = useState<ChallengeState | null>(null);
  const settle = useRef<((verified: boolean) => void) | null>(null);

  useEffect(
    () =>
      registerStepUpPrompt(async () => {
        const state = await authApi<ChallengeState>('/api/auth/step-up/start', { body: {} });
        return new Promise<boolean>((resolve) => {
          settle.current = resolve;
          setChallenge(state);
        });
      }),
    [],
  );

  const finish = (verified: boolean) => {
    const resolve = settle.current;
    settle.current = null;
    setChallenge(null);
    resolve?.(verified);
  };

  return (
    <Dialog open={challenge !== null} onOpenChange={(open) => (open ? undefined : finish(false))}>
      <DialogContent className="max-w-md" data-testid="step-up-dialog">
        <DialogHeader>
          <DialogTitle>{t('dev.stepUp.title')}</DialogTitle>
          <DialogDescription>{t('dev.stepUp.body')}</DialogDescription>
        </DialogHeader>
        {challenge !== null ? (
          <SecondFactorForm
            state={challenge}
            basePath="/api/auth/step-up"
            onVerified={() => finish(true)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
