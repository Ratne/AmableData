import type { ValidationResult } from '@amable/api-types';
import { toast } from '@amable/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../../../i18n';
import { errorMessage } from '../../../crm/api/hooks';
import { automationKeys, useAutomationApi } from '../../api/hooks';
import type { DraftSync } from '../../lib/draft-sync';

/** Publish, unpublish and validate: each flushes the pending draft first. */
export function usePublishActions(
  automationId: string,
  sync: DraftSync,
  setValidation: (result: ValidationResult) => void,
) {
  const { t } = useI18n();
  const { slug, api } = useAutomationApi();
  const queryClient = useQueryClient();
  const [publishing, setPublishing] = useState(false);

  const publish = async () => {
    setPublishing(true);
    try {
      await sync.flush();
      const state = sync.getSnapshot().status;
      if (state !== 'saved') {
        toast.error(state === 'invalid' ? t('auto.save.invalid') : t('auto.save.error'));
        return;
      }
      const result = await api.validate(automationId);
      setValidation(result);
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      if (!result.valid) {
        toast.error(t('auto.publish.invalid', { n: errors }));
        return;
      }
      const published = await api.publish(automationId);
      toast.success(t('auto.publish.done', { n: published.version.number }));
      await queryClient.invalidateQueries({ queryKey: automationKeys.root(slug) });
    } catch (error) {
      toast.error(errorMessage(t, error));
    } finally {
      setPublishing(false);
    }
  };
  const unpublish = async () => {
    try {
      await api.unpublish(automationId);
      toast.success(t('auto.unpublish.done'));
      await queryClient.invalidateQueries({ queryKey: automationKeys.root(slug) });
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  };
  const check = async () => {
    try {
      await sync.flush();
      const result = await api.validate(automationId);
      setValidation(result);
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.length - errors;
      if (errors > 0) toast.error(t('auto.publish.invalid', { n: errors }));
      else if (warnings > 0) toast.message(t('auto.publish.warnings', { n: warnings }));
      else toast.success(t('auto.publish.valid'));
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  };

  return { publishing, publish, unpublish, check };
}
