'use client';

import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { createContext, useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { FOLLOW_SPRING } from './lib';

type HoverHighlight = { show: (element: HTMLElement) => void; hide: () => void };

export const HoverHighlightContext = createContext<HoverHighlight | null>(null);

/**
 * One hover highlight for a whole list. It glides from item to item after the pointer,
 * and appears in place when the pointer arrives from outside the list.
 */
export function HoverHighlightList({
  className,
  highlightClassName = 'rounded-lg bg-(--obsidian-dashboard-shell-hover)',
  children,
}: {
  className?: string;
  highlightClassName?: string;
  children: ReactNode;
}) {
  const reduceMotion = !!useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const [isVisible, setIsVisible] = useState(false);
  const isShown = useRef(false);
  const hiddenAt = useRef(0);

  const show = useCallback(
    (element: HTMLElement) => {
      const list = listRef.current;
      if (!list) return;
      // Layout offsets rather than client rects, so a menu that is still scaling in doesn't skew the position.
      let top = 0;
      let left = 0;
      for (
        let node: HTMLElement | null = element;
        node && node !== list;
        node = node.offsetParent as HTMLElement | null
      ) {
        top += node.offsetTop;
        left += node.offsetLeft;
      }
      // Leaving and re-entering quickly still glides, so a pointer that grazes a border doesn't make it blink.
      const glide =
        !reduceMotion && (isShown.current || performance.now() - hiddenAt.current < 150);
      const moveTo = (value: typeof x, target: number) =>
        glide ? animate(value, target, FOLLOW_SPRING) : value.jump(target);
      moveTo(x, left);
      moveTo(y, top);
      moveTo(width, element.offsetWidth);
      moveTo(height, element.offsetHeight);
      isShown.current = true;
      setIsVisible(true);
    },
    [height, reduceMotion, width, x, y],
  );

  const hide = useCallback(() => {
    if (!isShown.current) return;
    isShown.current = false;
    hiddenAt.current = performance.now();
    setIsVisible(false);
  }, []);

  const highlight = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <HoverHighlightContext.Provider value={highlight}>
      <div ref={listRef} className={cn('relative', className)} onPointerLeave={hide}>
        <motion.span
          aria-hidden
          className={cn('pointer-events-none absolute left-0 top-0', highlightClassName)}
          style={{ x, y, width, height }}
          initial={false}
          animate={{ opacity: isVisible ? 1 : 0 }}
          transition={{ duration: isVisible ? 0.12 : 0.15, ease: 'easeOut' }}
        />
        {children}
      </div>
    </HoverHighlightContext.Provider>
  );
}
