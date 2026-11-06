import { useI18n } from '../../../i18n';
import type { DragChip, DropIndicator, DropOutline } from '../hooks/use-canvas-dnd';

/** Drop target outline, insertion indicator and the chip following the cursor during a canvas drag. */
export function DragOverlay({
  outline,
  indicator,
  chip,
}: {
  outline: DropOutline | null;
  indicator: DropIndicator | null;
  chip: DragChip | null;
}) {
  const { t } = useI18n();
  return (
    <>
      {outline ? (
        <div
          className="pointer-events-none fixed z-[59] rounded-md"
          style={{
            left: outline.left,
            top: outline.top,
            width: outline.width,
            height: outline.height,
            outline: '1.5px dashed rgba(37,99,235,0.6)',
            outlineOffset: -1.5,
            background: 'rgba(37,99,235,0.04)',
          }}
        />
      ) : null}
      {indicator ? (
        <div
          className="pointer-events-none fixed z-[60] rounded"
          style={
            indicator.type === 'box'
              ? {
                  left: indicator.left,
                  top: indicator.top,
                  width: indicator.width,
                  height: indicator.height,
                  outline: '2px solid #2563eb',
                  background: 'rgba(37,99,235,0.10)',
                }
              : indicator.type === 'h'
                ? {
                    left: indicator.left,
                    top: indicator.top,
                    width: indicator.width,
                    height: 4,
                    background: '#2563eb',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.9)',
                  }
                : {
                    left: indicator.left,
                    top: indicator.top,
                    width: 4,
                    height: indicator.height,
                    background: '#2563eb',
                    boxShadow: '0 0 0 1px rgba(255,255,255,0.9)',
                  }
          }
        />
      ) : null}
      {chip ? (
        <div
          className="pointer-events-none fixed z-[61] flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-white shadow-lg"
          style={{
            left: chip.x + 14,
            top: chip.y + 14,
            background: chip.valid ? '#2563eb' : '#94a3b8',
          }}
        >
          {chip.label}
          {!chip.valid ? (
            <span className="font-normal opacity-80">— {t('landing.editor.dropNotAllowed')}</span>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
