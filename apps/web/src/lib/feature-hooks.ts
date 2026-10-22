import type { Permission } from '@amable/core';
import type { MessageKey } from '@amable/i18n';
import { toast } from '@amable/ui';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useI18n } from '../i18n';
import { TenantApiError, type TenantMe } from './tenant-api';

/** Shared building blocks of the per-feature `api/hooks.ts` modules. */

/** Reference data (members, custom fields, the membership): refetched at most once a minute. */
export const REFERENCE_STALE_MS = 60_000;

type Translate = ReturnType<typeof useI18n>['t'];

/** Feature messages of the standard API failures; optional ones fall back to the generic error. */
export interface ApiErrorMessages {
  readonly forbidden: MessageKey;
  readonly notFound: MessageKey;
  readonly validation: MessageKey;
  /** 409: the server's message first, else this one. */
  readonly conflict?: MessageKey;
  readonly tooLarge?: MessageKey;
}

/**
 * Message of a failed call: feature texts for the common statuses, the first
 * field error (or the server's message) on validation failures. `special`
 * answers first for feature-specific codes.
 */
export function apiErrorMessage(
  t: Translate,
  error: unknown,
  messages: ApiErrorMessages,
  special?: (error: TenantApiError) => string | null,
): string {
  if (error instanceof TenantApiError) {
    const custom = special?.(error);
    if (custom != null) return custom;
    if (error.status === 403) return t(messages.forbidden);
    if (error.status === 404) return t(messages.notFound);
    if (error.status === 409 && messages.conflict !== undefined)
      return error.detail ?? t(messages.conflict);
    if (error.status === 413 && messages.tooLarge !== undefined) return t(messages.tooLarge);
    if (error.status === 423) return t('common.lock.busy');
    if (error.status === 422 || error.status === 400) {
      const first = error.details[0];
      if (first !== undefined)
        return first.path ? `${first.path}: ${first.message}` : first.message;
      return error.detail ?? t(messages.validation);
    }
  }
  return t('common.error');
}

/** Permission check over the active membership; actions stay hidden until known (the server enforces them). */
export function useGrantedPermissions(me: TenantMe | undefined): {
  can: (permission: Permission) => boolean;
  ready: boolean;
} {
  const granted = useMemo(() => new Set(me?.permissions ?? []), [me]);
  const can = useCallback((permission: Permission) => granted.has(permission), [granted]);
  return { can, ready: me !== undefined };
}

export interface ApiMutationOptions<TInput, TResult> {
  readonly mutationFn: (input: TInput) => Promise<TResult>;
  /** Query keys refreshed after success. Default: the whole tenant cache of the feature. */
  readonly invalidate?: readonly QueryKey[];
  readonly success?: string | ((result: TResult) => string);
  readonly onSuccess?: (result: TResult, input: TInput) => void;
  /** Return true to skip the default error toast (the caller shows the error inline or a dialog took over). */
  readonly onError?: (error: unknown, input: TInput) => boolean | void;
}

/** `useMutation` with cache invalidation (`root` by default) and success / error toasts. */
export function useApiMutation<TInput, TResult>(
  options: ApiMutationOptions<TInput, TResult>,
  root: QueryKey,
  describeError: (t: Translate, error: unknown) => string,
) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: options.mutationFn,
    onSuccess: async (result, input) => {
      const keys = options.invalidate ?? [root];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      if (options.success !== undefined) {
        toast.success(
          typeof options.success === 'function' ? options.success(result) : options.success,
        );
      }
      options.onSuccess?.(result, input);
    },
    onError: (error, input) => {
      if (options.onError?.(error, input) === true) return;
      toast.error(describeError(t, error));
    },
  });
}
