import { cn } from '@amable/ui';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export interface ContextMenuState {
  id: string;
  x: number;
  y: number;
  /** Selection before the right click (the canvas re-targets the node under the cursor). */
  prevSelectedId?: string | null;
}

export interface CtxMenuItem {
  id: string;
  label: string;
  sub?: string;
  run: () => void;
  danger?: boolean;
}

/** Right-click menu of a canvas node, kept inside the viewport. */
export function CtxMenu({
  menu,
  onMove,
  onClose,
  header,
  items,
  disabled,
}: {
  menu: ContextMenuState;
  onMove: (menu: ContextMenuState) => void;
  onClose: () => void;
  header: ReactNode;
  items: readonly CtxMenuItem[];
  disabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8));
    const ny = Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8));
    if (nx !== menu.x || ny !== menu.y) onMove({ ...menu, x: nx, y: ny });
  }, [menu, onMove]);

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        className="fixed z-50 w-72 overflow-hidden rounded-md border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
        style={{ top: menu.y, left: menu.x }}
      >
        <div className="border-b px-3 pt-1 pb-1.5 text-xs text-muted-foreground">{header}</div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={disabled}
            className={cn(
              'block w-full truncate px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50',
              item.danger && 'text-destructive',
            )}
            onClick={() => {
              item.run();
              onClose();
            }}
          >
            <span className="block truncate">{item.label}</span>
            {item.sub ? (
              <span className="block truncate text-xs text-muted-foreground">{item.sub}</span>
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
}
