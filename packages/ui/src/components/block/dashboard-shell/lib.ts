'use client';

import { createContext, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { EASE_OUT } from '../../../lib/controllable';

/** The hover highlight glides after the pointer. */
export const FOLLOW_SPRING = { type: 'spring', stiffness: 650, damping: 45, mass: 0.5 } as const;
/** The active pill slides to the chosen item. */
export const PILL_SPRING = { type: 'spring', stiffness: 520, damping: 38, mass: 0.7 } as const;
/** Menus and popovers settle from a slight squash with a small overshoot. */
export const LAYER_SPRING = { type: 'spring', stiffness: 560, damping: 26, mass: 0.7 } as const;

// Menus and popovers portal to the body, outside the shell, so they carry the layer class that holds the palette.
export const layerClassName =
  'obsidian-dashboard-shell-layer z-50 rounded-[10px] bg-(--obsidian-dashboard-shell-menu) p-1 text-(--obsidian-dashboard-shell-foreground) shadow-(--obsidian-dashboard-shell-menu-shadow) outline-none backdrop-blur-xl backdrop-saturate-150';

export function layerMotion(reduceMotion: boolean) {
  if (reduceMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: 0 },
    };
  }
  return {
    initial: { opacity: 0, scaleX: 0.92, scaleY: 0.86, filter: 'blur(8px)' },
    animate: {
      opacity: 1,
      scaleX: 1,
      scaleY: 1,
      filter: 'blur(0px)',
      transition: {
        ...LAYER_SPRING,
        opacity: { duration: 0.16, ease: EASE_OUT },
        filter: { duration: 0.24, ease: EASE_OUT },
      },
    },
    exit: {
      opacity: 0,
      scaleX: 0.96,
      scaleY: 0.94,
      filter: 'blur(4px)',
      transition: { duration: 0.14, ease: EASE_OUT },
    },
  };
}

// Exit animations need the open state, since the content stays mounted until it has animated out.
export const LayerOpenContext = createContext(false);

// Portaled layers leave a scoped `.dark` wrapper behind, so the shell passes its theme down to them.
export const ShellDarkContext = createContext(false);

export function useScopedDark(ref: RefObject<HTMLElement | null>, className?: string) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setIsDark(element.closest('.dark') !== null);
    update();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(update);
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ['class'] });
    }
    return () => observer.disconnect();
  }, [ref, className]);

  return isDark;
}
