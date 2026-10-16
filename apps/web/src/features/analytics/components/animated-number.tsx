import { cn } from '@amable/ui';
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './canvas-colors';

const DURATION_MS = 900;
const ease = (t: number) => 1 - (1 - t) ** 4;

/**
 * Number that counts to its new value (soft landing, no overshoot), the KPI
 * motion of the analytics block. `format` renders every intermediate frame.
 */
export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const current = useRef(value);
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(value)) {
      current.current = value;
      setShown(value);
      return;
    }
    from.current = current.current;
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const next = from.current + (value - from.current) * ease(t);
      current.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <span className={cn('tabular-nums', className)}>
      <span className="sr-only">{format(value)}</span>
      <span aria-hidden>{formatRef.current(shown)}</span>
    </span>
  );
}
