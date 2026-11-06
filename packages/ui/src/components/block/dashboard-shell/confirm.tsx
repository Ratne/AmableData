'use client';

import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useContext } from 'react';
import type { ReactNode } from 'react';
import { EASE_OUT } from '../../../lib/controllable';
import { cn } from '../../../lib/utils';
import { DashboardButton } from './button';
import { LAYER_SPRING, ShellDarkContext } from './lib';

export type DashboardConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  /** "danger" paints the confirm button red, for deleting and other actions that remove things. */
  tone?: 'default' | 'danger';
  onConfirm: () => void;
};

export function DashboardConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
}: DashboardConfirmDialogProps) {
  const isDark = useContext(ShellDarkContext);
  const reduceMotion = !!useReducedMotion();

  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <AlertDialogPrimitive.Portal forceMount>
            <AlertDialogPrimitive.Overlay forceMount asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.18, ease: EASE_OUT }}
                className={cn(
                  'fixed inset-0 z-50 backdrop-blur-[2px]',
                  isDark ? 'bg-black/50' : 'bg-black/25',
                )}
              />
            </AlertDialogPrimitive.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
              <AlertDialogPrimitive.Content forceMount asChild>
                <motion.div
                  initial={
                    reduceMotion
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.94, y: 6, filter: 'blur(6px)' }
                  }
                  animate={{
                    opacity: 1,
                    scale: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: reduceMotion
                      ? { duration: 0 }
                      : {
                          ...LAYER_SPRING,
                          opacity: { duration: 0.16, ease: EASE_OUT },
                          filter: { duration: 0.2, ease: EASE_OUT },
                        },
                  }}
                  exit={
                    reduceMotion
                      ? { opacity: 0, transition: { duration: 0 } }
                      : {
                          opacity: 0,
                          scale: 0.97,
                          y: 4,
                          filter: 'blur(4px)',
                          transition: { duration: 0.14, ease: EASE_OUT },
                        }
                  }
                  className={cn(
                    'obsidian-dashboard-shell-layer pointer-events-auto flex w-full max-w-sm flex-col gap-4 rounded-xl bg-(--obsidian-dashboard-shell-background) p-4 text-(--obsidian-dashboard-shell-foreground) shadow-(--obsidian-dashboard-shell-menu-shadow) outline-none',
                    isDark && 'dark',
                  )}
                >
                  <div className="flex flex-col gap-1.5">
                    <AlertDialogPrimitive.Title className="text-sm font-medium leading-snug">
                      {title}
                    </AlertDialogPrimitive.Title>
                    {description ? (
                      <AlertDialogPrimitive.Description className="text-xs leading-relaxed text-(--obsidian-dashboard-shell-text-muted)">
                        {description}
                      </AlertDialogPrimitive.Description>
                    ) : (
                      <AlertDialogPrimitive.Description className="sr-only">
                        {title}
                      </AlertDialogPrimitive.Description>
                    )}
                  </div>
                  <div className="flex justify-end gap-2">
                    <AlertDialogPrimitive.Cancel asChild>
                      <DashboardButton variant="secondary" size="sm">
                        {cancelLabel}
                      </DashboardButton>
                    </AlertDialogPrimitive.Cancel>
                    <AlertDialogPrimitive.Action asChild>
                      <DashboardButton
                        variant={tone === 'danger' ? 'danger' : 'primary'}
                        size="sm"
                        onClick={onConfirm}
                      >
                        {confirmLabel}
                      </DashboardButton>
                    </AlertDialogPrimitive.Action>
                  </div>
                </motion.div>
              </AlertDialogPrimitive.Content>
            </div>
          </AlertDialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </AlertDialogPrimitive.Root>
  );
}
