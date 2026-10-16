import type { RealtimeEvent } from '@amable/api-types';
import { cn } from '@amable/ui';
import { useEffect, useRef } from 'react';
import { getSphereDots } from '../lib/land';
import { prefersReducedMotion, resolveColors, rgba, type Rgb } from './canvas-colors';

/*
 * Lightweight dotted globe on a 2D canvas: orthographic projection of the
 * embedded land dots, slow auto-rotation, drag to rotate (with inertia),
 * visitor markers and a ring pulse for every live event with a location.
 */

export interface GlobeMarker {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** 0..1, scales the marker glow. */
  readonly weight?: number;
}

export interface GlobeProps {
  readonly markers: readonly GlobeMarker[];
  /** Live events; each one with coordinates pulses on the globe. */
  readonly subscribe?: (listener: (event: RealtimeEvent) => void) => () => void;
  readonly label: string;
  readonly className?: string;
}

interface Pulse {
  readonly lat: number;
  readonly lon: number;
  readonly start: number;
  readonly tone: 'primary' | 'success' | 'warning';
}

const RAD = Math.PI / 180;
const PULSE_MS = 1800;
const AUTO_DEG_PER_S = 5;
const ALPHA_BUCKETS = 6;

type Palette = Record<'ink' | 'primary' | 'success' | 'warning' | 'bg', Rgb>;

const TOKENS = {
  ink: 'var(--foreground)',
  primary: 'var(--primary)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  bg: 'var(--background)',
} as const;

export function Globe({ markers, subscribe, label, className }: GlobeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const pulses = useRef<Pulse[]>([]);
  const view = useRef({
    lon: 10,
    lat: 22,
    velocity: 0,
    dragging: false,
    lastInteraction: 0,
    centered: false,
  });

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.latitude === null || event.longitude === null) return;
      pulses.current.push({
        lat: event.latitude,
        lon: event.longitude,
        start: performance.now(),
        tone: event.type === 'payment' ? 'warning' : event.type === 'goal' ? 'success' : 'primary',
      });
      if (pulses.current.length > 40) pulses.current.splice(0, pulses.current.length - 40);
    });
  }, [subscribe]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!host || !canvas || !ctx) return;

    const dots = getSphereDots();
    const count = dots.length / 2;
    const sinLat = new Float32Array(count);
    const cosLat = new Float32Array(count);
    const lonRad = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const lat = dots[i * 2 + 1]! * RAD;
      sinLat[i] = Math.sin(lat);
      cosLat[i] = Math.cos(lat);
      lonRad[i] = dots[i * 2]! * RAD;
    }

    let palette: Palette = resolveColors(host, TOKENS);
    let paletteAt = performance.now();
    let width = 0;
    let height = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = host.clientWidth;
      height = host.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const reduced = prefersReducedMotion();
    let frame = 0;
    let last = performance.now();

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const state = view.current;
      if (now - paletteAt > 1000) {
        palette = resolveColors(host, TOKENS);
        paletteAt = now;
      }
      if (!state.centered && markersRef.current.length > 0) {
        const lons = markersRef.current.map((m) => m.lon);
        state.lon = lons.reduce((a, b) => a + b, 0) / lons.length;
        state.centered = true;
      }
      if (!state.dragging) {
        if (Math.abs(state.velocity) > 0.01) {
          state.lon -= state.velocity * dt * 60;
          state.velocity *= 0.94;
        } else if (!reduced && now - state.lastInteraction > 2500) {
          state.lon += AUTO_DEG_PER_S * dt;
        }
      }

      const w = width * dpr;
      const h = height * dpr;
      ctx.clearRect(0, 0, w, h);
      if (w === 0 || h === 0) return;
      const radius = Math.min(w, h) * 0.44;
      const cx = w / 2;
      const cy = h / 2;
      const lambda0 = state.lon * RAD;
      const phi0 = state.lat * RAD;
      const sinPhi0 = Math.sin(phi0);
      const cosPhi0 = Math.cos(phi0);

      // Atmosphere and sphere body.
      const glow = ctx.createRadialGradient(cx, cy, radius * 0.92, cx, cy, radius * 1.18);
      glow.addColorStop(0, rgba(palette.primary, 0.16));
      glow.addColorStop(1, rgba(palette.primary, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      const body = ctx.createRadialGradient(
        cx - radius * 0.35,
        cy - radius * 0.4,
        radius * 0.1,
        cx,
        cy,
        radius,
      );
      body.addColorStop(0, rgba(palette.ink, 0.07));
      body.addColorStop(1, rgba(palette.ink, 0.02));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.lineWidth = dpr;
      ctx.strokeStyle = rgba(palette.ink, 0.1);
      ctx.stroke();

      // Land dots, batched by brightness.
      const size = Math.max(1.1, radius / 190) * 1.15;
      for (let bucket = 0; bucket < ALPHA_BUCKETS; bucket += 1) {
        const lo = bucket / ALPHA_BUCKETS;
        const hi = (bucket + 1) / ALPHA_BUCKETS;
        ctx.beginPath();
        for (let i = 0; i < count; i += 1) {
          const dl = lonRad[i]! - lambda0;
          const cosDl = Math.cos(dl);
          const cosc = sinPhi0 * sinLat[i]! + cosPhi0 * cosLat[i]! * cosDl;
          if (cosc <= 0 || cosc < lo || cosc >= hi) continue;
          const x = cx + radius * cosLat[i]! * Math.sin(dl);
          const y = cy - radius * (cosPhi0 * sinLat[i]! - sinPhi0 * cosLat[i]! * cosDl);
          const s = size * (0.55 + 0.45 * cosc);
          ctx.rect(x - s / 2, y - s / 2, s, s);
        }
        ctx.fillStyle = rgba(palette.ink, 0.12 + 0.5 * ((lo + hi) / 2));
        ctx.fill();
      }

      const project = (lat: number, lon: number) => {
        const phi = lat * RAD;
        const dl = lon * RAD - lambda0;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        const cosc = sinPhi0 * sinPhi + cosPhi0 * cosPhi * Math.cos(dl);
        return {
          visible: cosc > 0,
          depth: cosc,
          x: cx + radius * cosPhi * Math.sin(dl),
          y: cy - radius * (cosPhi0 * sinPhi - sinPhi0 * cosPhi * Math.cos(dl)),
        };
      };

      // Visitors.
      const breathe = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(now / 600);
      for (const marker of markersRef.current) {
        const p = project(marker.lat, marker.lon);
        if (!p.visible) continue;
        const weight = marker.weight ?? 0.5;
        const halo = (5 + 7 * weight + 2 * breathe) * dpr;
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
        gradient.addColorStop(0, rgba(palette.primary, 0.55 * p.depth));
        gradient.addColorStop(1, rgba(palette.primary, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, halo, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = rgba(palette.primary, 0.6 + 0.4 * p.depth);
        ctx.fill();
        ctx.lineWidth = dpr;
        ctx.strokeStyle = rgba(palette.bg, 0.9);
        ctx.stroke();
      }

      // Event pulses.
      pulses.current = pulses.current.filter((pulse) => now - pulse.start < PULSE_MS);
      for (const pulse of pulses.current) {
        const p = project(pulse.lat, pulse.lon);
        if (!p.visible) continue;
        const progress = (now - pulse.start) / PULSE_MS;
        const color = palette[pulse.tone];
        for (const offset of [0, 0.25]) {
          const k = progress - offset;
          if (k <= 0) continue;
          ctx.beginPath();
          ctx.arc(p.x, p.y, (3 + 26 * k) * dpr, 0, Math.PI * 2);
          ctx.lineWidth = 1.6 * dpr;
          ctx.strokeStyle = rgba(color, (1 - k) * 0.9 * p.depth);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = rgba(color, 1 - progress);
        ctx.fill();
      }
    };
    frame = requestAnimationFrame(draw);

    let lastX = 0;
    let lastY = 0;
    const onDown = (event: PointerEvent) => {
      view.current.dragging = true;
      view.current.velocity = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      const state = view.current;
      if (!state.dragging) return;
      const scale = 180 / Math.max(120, Math.min(width, height));
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      state.lon -= dx * scale;
      state.lat = Math.max(-70, Math.min(70, state.lat + dy * scale));
      state.velocity = dx * scale * 0.6;
      state.lastInteraction = performance.now();
    };
    const onUp = (event: PointerEvent) => {
      view.current.dragging = false;
      view.current.lastInteraction = performance.now();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, []);

  return (
    <div ref={hostRef} className={cn('relative h-full w-full touch-none select-none', className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        className="absolute inset-0 cursor-grab active:cursor-grabbing"
      />
    </div>
  );
}
