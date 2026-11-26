/**
 * Device signals module, loaded by the cookie builds only on sites that turned
 * it on (the `GET /e` handshake says so), never cookieless, after an opt-out,
 * for bots or with Global Privacy Control. Sent once per browser session as a
 * `device` event through the running tracker.
 *
 * Parts of the readings follow FingerprintJS
 * (https://github.com/fingerprintjs/fingerprintjs), MIT License,
 * Copyright (c) 2025 FingerprintJS, Inc.
 */

export type DeviceSignals = Record<string, string | number>;

/** Fonts probed by width against the generic families (system fonts of the major OSes). */
const FONTS = [
  'Arial',
  'Arial Black',
  'Calibri',
  'Cambria',
  'Comic Sans MS',
  'Consolas',
  'Courier New',
  'Georgia',
  'Helvetica Neue',
  'Impact',
  'Lucida Console',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Menlo',
  'Monaco',
  'Optima',
  'Futura',
  'Gill Sans',
  'Avenir',
  'Roboto',
  'Noto Sans',
  'Ubuntu',
  'DejaVu Sans',
  'Liberation Sans',
  'Cantarell',
];
const BASES = ['monospace', 'sans-serif', 'serif'];

export const DEVICE_SESSION_KEY = 'amb_dv';

/** FNV-1a, 32 bits, hex. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const attempt = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise.catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, ms))]);

/** A reading the browser noises at random (two reads differ): never part of a fingerprint. */
export const UNSTABLE = 'unstable';

function fonts(doc: Document): string | undefined {
  const ctx = doc.createElement('canvas').getContext('2d');
  if (ctx === null) return undefined;
  const width = (family: string): number => {
    ctx.font = `72px ${family}`;
    return ctx.measureText('mmmmmmmmmmlli10OQ@').width;
  };
  const base = BASES.map(width);
  let bits = '';
  for (const font of FONTS) {
    bits += BASES.some((b, i) => width(`"${font}",${b}`) !== base[i]) ? '1' : '0';
  }
  return bits;
}

function canvas(doc: Document): string | undefined {
  const el = doc.createElement('canvas');
  el.width = 240;
  el.height = 60;
  const ctx = el.getContext('2d');
  if (ctx === null) return undefined;
  const g = ctx.createLinearGradient(0, 0, 240, 0);
  g.addColorStop(0, '#f60');
  g.addColorStop(1, '#09c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 240, 60);
  ctx.fillStyle = '#123';
  ctx.font = '16px Arial';
  ctx.textBaseline = 'top';
  ctx.fillText('Amable ✓ 😀 1.0', 4, 8);
  ctx.globalCompositeOperation = 'multiply';
  ctx.beginPath();
  ctx.arc(180, 30, 22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(200,0,120,0.6)';
  ctx.fill();
  const image = el.toDataURL();
  // Browsers that noise the canvas give a different image at every read.
  return image === el.toDataURL() ? fnv(image) : UNSTABLE;
}

/**
 * Results of the engine's math functions on fixed inputs: they differ between
 * engines and systems, and no browser noises them. Inputs after FingerprintJS
 * (`src/sources/math.ts`, MIT).
 */
function math(): string {
  const M = Math;
  const values = [
    M.acos(0.123124234234234242),
    M.acosh(1e308),
    M.log(1e154 + M.sqrt(1e154 * 1e154 - 1)),
    M.asin(0.123124234234234242),
    M.asinh(1),
    M.atanh(0.5),
    M.atan(0.5),
    M.sin(-1e300),
    M.sinh(1),
    M.exp(1) - 1 / M.exp(1) / 2,
    M.cos(10.000000000123),
    M.cosh(1),
    M.tan(-1e300),
    M.tanh(1),
    M.exp(1),
    M.expm1(1),
    M.log1p(10),
    M.pow(M.PI, -100),
  ];
  return fnv(values.join(','));
}

/** Room the system takes around the screen (task bar, dock, menu bar), rounded: top, right, bottom, left. */
function screenFrame(win: Window): string | undefined {
  // Some browsers report no frame in fullscreen.
  if (win.document.fullscreenElement) return undefined;
  const s = win.screen as Screen & { availTop?: number; availLeft?: number };
  const top = Number(s.availTop) || 0;
  const left = Number(s.availLeft) || 0;
  const round = (n: number): number => Math.round(n / 10) * 10;
  const frame = [top, s.width - s.availWidth - left, s.height - s.availHeight - top, left];
  return frame.some((n) => !Number.isFinite(n)) ? undefined : frame.map(round).join(',');
}

function gpu(doc: Document): string | undefined {
  const gl = doc.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
  if (gl === null) return undefined;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  if (info === null) return String(gl.getParameter(gl.RENDERER));
  return `${String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL))}|${String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))}`;
}

async function audio(win: Window): Promise<string | undefined> {
  const Ctx = (win as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
    .OfflineAudioContext;
  if (Ctx === undefined) return undefined;
  const ctx = new Ctx(1, 5000, 44100);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor();
  osc.connect(comp);
  comp.connect(ctx.destination);
  osc.start(0);
  const data = (await ctx.startRendering()).getChannelData(0);
  let sum = 0;
  for (let i = 4500; i < data.length; i += 1) sum += Math.abs(data[i] ?? 0);
  return fnv(sum.toFixed(8));
}

interface UaData {
  getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>;
}

/** Collects the signals; every probe is optional (missing APIs, blocked canvas). */
export async function collectDevice(win: Window): Promise<DeviceSignals> {
  const nav = win.navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: UaData;
  };
  const doc = win.document;
  const out: DeviceSignals = {};
  const put = (key: string, value: string | number | undefined | null): void => {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  };
  put('dpr', win.devicePixelRatio);
  put('cd', win.screen.colorDepth);
  put('hc', nav.hardwareConcurrency);
  put('dm', nav.deviceMemory);
  put('tp', nav.maxTouchPoints);
  put('plat', nav.platform);
  put('langs', (nav.languages ?? []).join(','));
  const media = (q: string): string =>
    attempt(() => win.matchMedia(q).matches) === true ? '1' : '0';
  put(
    'pc',
    media('(prefers-color-scheme: dark)') +
      media('(prefers-reduced-motion: reduce)') +
      media('(prefers-contrast: more)') +
      media('(forced-colors: active)'),
  );
  put(
    'gpu',
    attempt(() => gpu(doc)),
  );
  put(
    'fonts',
    attempt(() => fonts(doc)),
  );
  put(
    'cv',
    attempt(() => canvas(doc)),
  );
  put('au', await within(attempt(() => audio(win)) ?? Promise.resolve(undefined), 1000));
  put('math', attempt(math));
  put(
    'sf',
    attempt(() => screenFrame(win)),
  );
  const ua = await within(
    nav.userAgentData?.getHighEntropyValues?.([
      'platform',
      'platformVersion',
      'model',
      'architecture',
    ]) ?? Promise.resolve(undefined),
    1000,
  );
  if (ua !== undefined) {
    put('os', ua['platform'] as string | undefined);
    put('osv', ua['platformVersion'] as string | undefined);
    put('mdl', ua['model'] as string | undefined);
    put('arch', ua['architecture'] as string | undefined);
  }
  return out;
}
