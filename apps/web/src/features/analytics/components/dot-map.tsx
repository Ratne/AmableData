import { cn } from '@amable/ui';
import { useEffect, useRef } from 'react';
import { COUNTRY_CENTROIDS } from '../lib/countries';
import { getGridDots } from '../lib/land';
import { resolveColors, rgba } from './canvas-colors';

const TOP = 80;
const BOTTOM = -58;
const TOKENS = { ink: 'var(--foreground)', primary: 'var(--primary)' } as const;

export interface DotMapValue {
  readonly country: string;
  readonly visitors: number;
}

/** Flat equirectangular dot map; countries glow by share of visitors. */
export function DotMap({
  values,
  label,
  className,
}: {
  values: readonly DotMapValue[];
  label: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!host || !canvas || !ctx) return;

    const render = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = host.clientWidth;
      const height = host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const w = canvas.width;
      const h = canvas.height;
      const palette = resolveColors(host, TOKENS);
      const x = (lon: number) => ((lon + 180) / 360) * w;
      const y = (lat: number) => ((TOP - lat) / (TOP - BOTTOM)) * h;
      ctx.clearRect(0, 0, w, h);

      const max = Math.max(1, ...values.map((value) => value.visitors));
      const hot = values
        .map((value) => ({
          centroid: COUNTRY_CENTROIDS.get(value.country.toUpperCase()),
          share: value.visitors / max,
        }))
        .filter(
          (value): value is { centroid: readonly [number, number]; share: number } =>
            !!value.centroid,
        );

      const dots = getGridDots();
      const size = Math.max(1.2, (w / 360) * 1.25);
      for (let i = 0; i < dots.length; i += 2) {
        const lon = dots[i]!;
        const lat = dots[i + 1]!;
        let heat = 0;
        for (const spot of hot) {
          const dLat = lat - spot.centroid[0];
          const dLon = (lon - spot.centroid[1]) * Math.cos((lat * Math.PI) / 180);
          const distance = Math.sqrt(dLat * dLat + dLon * dLon);
          const reach = 5 + 9 * Math.sqrt(spot.share);
          if (distance < reach)
            heat = Math.max(heat, (1 - distance / reach) * (0.35 + 0.65 * spot.share));
        }
        ctx.fillStyle =
          heat > 0.02 ? rgba(palette.primary, 0.25 + 0.75 * heat) : rgba(palette.ink, 0.13);
        ctx.beginPath();
        ctx.arc(x(lon), y(lat), size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    const theme = new MutationObserver(render);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      theme.disconnect();
    };
  }, [values]);

  return (
    <div ref={hostRef} className={cn('relative aspect-[2.6/1] w-full', className)}>
      <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0" />
    </div>
  );
}
