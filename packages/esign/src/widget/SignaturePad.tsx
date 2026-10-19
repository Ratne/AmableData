import { useEffect, useRef, useState } from 'preact/hooks';
import type { SigningStrings } from '../strings';
import type { SigningFieldType } from '../types';

export type ImageMethod = 'drawn' | 'typed' | 'upload';

export interface ImageResult {
  dataUrl: string;
  method: ImageMethod;
}

/** Decoded size the server accepts for one image (base64 adds a third). */
const MAX_IMAGE_BYTES = 380_000;
const TYPED_FONT = '"Segoe Script","Brush Script MT","Apple Chancery","Snell Roundhand",cursive';

const approxBytes = (dataUrl: string): number => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Crops transparent margins (drawn / typed signatures) so the image fills its field. */
function trimmed(canvas: HTMLCanvasElement, maxWidth: number): string | null {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  const pad = 6;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const w = right - left + 1;
  const h = bottom - top + 1;
  const scale = Math.min(1, maxWidth / w);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const octx = out.getContext('2d');
  if (octx === null) return null;
  octx.drawImage(canvas, left, top, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

function DrawPad(props: { onChange: (dataUrl: string | null) => void; strings: SigningStrings }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.scale(ratio, ratio);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0b1b5a';
    ctx.lineWidth = 2.4;
  }, []);

  const point = (event: PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const finish = () => {
    drawing.current = false;
    last.current = null;
    if (dirty.current && ref.current !== null) props.onChange(trimmed(ref.current, 900));
  };

  return (
    <div>
      <canvas
        ref={ref}
        class="sg-pad"
        onPointerDown={(event) => {
          (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
          drawing.current = true;
          last.current = point(event);
          const ctx = ref.current?.getContext('2d');
          if (ctx !== null && ctx !== undefined) {
            ctx.beginPath();
            ctx.arc(last.current.x, last.current.y, 1.1, 0, Math.PI * 2);
            ctx.fillStyle = '#0b1b5a';
            ctx.fill();
            dirty.current = true;
          }
        }}
        onPointerMove={(event) => {
          if (!drawing.current || last.current === null) return;
          const ctx = ref.current?.getContext('2d');
          if (ctx === null || ctx === undefined) return;
          const next = point(event);
          const mid = { x: (last.current.x + next.x) / 2, y: (last.current.y + next.y) / 2 };
          ctx.beginPath();
          ctx.moveTo(last.current.x, last.current.y);
          ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
          ctx.lineTo(next.x, next.y);
          ctx.stroke();
          last.current = next;
          dirty.current = true;
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
      />
      <p class="sg-hint">{props.strings.drawHint}</p>
      <button
        type="button"
        class="sg-btn"
        onClick={() => {
          const canvas = ref.current;
          const ctx = canvas?.getContext('2d');
          if (canvas !== null && ctx !== null && ctx !== undefined) {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.restore();
          }
          dirty.current = false;
          props.onChange(null);
        }}
      >
        {props.strings.clear}
      </button>
    </div>
  );
}

function renderTyped(text: string, initials: boolean): string | null {
  const value = text.trim();
  if (value === '') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 300;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  let size = initials ? 150 : 110;
  ctx.font = `${String(size)}px ${TYPED_FONT}`;
  while (size > 30 && ctx.measureText(value).width > canvas.width - 40) {
    size -= 6;
    ctx.font = `${String(size)}px ${TYPED_FONT}`;
  }
  ctx.fillStyle = '#0b1b5a';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, 20, canvas.height / 2);
  return trimmed(canvas, 900);
}

function TypePad(props: { initial: string; initials: boolean; onChange: (dataUrl: string | null) => void; strings: SigningStrings }) {
  const [text, setText] = useState(props.initial);
  const preview = renderTyped(text, props.initials);
  useEffect(() => props.onChange(preview), [preview]);
  return (
    <div>
      <input
        class="sg-typed"
        value={text}
        maxLength={80}
        placeholder={props.strings.typeName}
        onInput={(event) => setText((event.currentTarget as HTMLInputElement).value)}
      />
      <div class="sg-preview">{preview === null ? null : <img src={preview} alt="" />}</div>
    </div>
  );
}

async function fileToDataUrl(file: File): Promise<string | null> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') return null;
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('unreadable image'));
      img.src = url;
    });
    let maxSide = 1400;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (ctx === null) return null;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
      if (approxBytes(dataUrl) <= MAX_IMAGE_BYTES) return dataUrl;
      const jpeg = canvas.toDataURL('image/jpeg', 0.8);
      if (approxBytes(jpeg) <= MAX_IMAGE_BYTES) return jpeg;
      maxSide = Math.round(maxSide * 0.7);
    }
    return null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function UploadPad(props: { onChange: (dataUrl: string | null) => void; strings: SigningStrings }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState(false);
  return (
    <div>
      <input
        type="file"
        accept="image/png,image/jpeg"
        onChange={async (event) => {
          const file = (event.currentTarget as HTMLInputElement).files?.[0];
          if (file === undefined) return;
          const dataUrl = await fileToDataUrl(file);
          setError(dataUrl === null);
          setPreview(dataUrl);
          props.onChange(dataUrl);
        }}
      />
      <p class="sg-hint">{props.strings.uploadHint}</p>
      {error ? <p class="sg-err">{props.strings.imageTooLarge}</p> : null}
      <div class="sg-preview">{preview === null ? null : <img src={preview} alt="" />}</div>
    </div>
  );
}

/** Modal to produce the image of a signature, initials or picture field. */
export function ImageDialog(props: {
  type: SigningFieldType;
  signerName: string;
  strings: SigningStrings;
  onApply: (result: ImageResult) => void;
  onCancel: () => void;
}) {
  const picture = props.type === 'image';
  const initials = props.type === 'initials';
  const modes: ImageMethod[] = picture ? ['upload'] : ['drawn', 'typed', 'upload'];
  const [mode, setMode] = useState<ImageMethod>(modes[0]!);
  const [value, setValue] = useState<string | null>(null);
  const s = props.strings;
  const initialText = initials
    ? props.signerName
        .split(/\s+/)
        .filter((p) => p !== '')
        .map((p) => p[0]!.toUpperCase())
        .join('')
    : props.signerName;
  const label: Record<ImageMethod, string> = { drawn: s.draw, typed: s.type, upload: s.upload };
  return (
    <div class="sg-modal" role="dialog" aria-modal="true" onClick={(event) => event.target === event.currentTarget && props.onCancel()}>
      <div class="sg-dialog">
        <h3>{picture ? s.imageTitle : initials ? s.initialsTitle : s.signatureTitle}</h3>
        {modes.length > 1 ? (
          <div class="sg-tabs">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                class={m === mode ? 'on' : ''}
                onClick={() => {
                  setMode(m);
                  setValue(null);
                }}
              >
                {label[m]}
              </button>
            ))}
          </div>
        ) : null}
        {mode === 'drawn' ? <DrawPad onChange={setValue} strings={s} /> : null}
        {mode === 'typed' ? <TypePad initial={initialText} initials={initials} onChange={setValue} strings={s} /> : null}
        {mode === 'upload' ? <UploadPad onChange={setValue} strings={s} /> : null}
        <div class="sg-actions">
          <button type="button" class="sg-btn" onClick={props.onCancel}>
            {s.cancel}
          </button>
          <button
            type="button"
            class="sg-btn primary"
            disabled={value === null}
            onClick={() => value !== null && props.onApply({ dataUrl: value, method: mode })}
          >
            {s.apply}
          </button>
        </div>
      </div>
    </div>
  );
}
