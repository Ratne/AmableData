import { cn } from '@amable/ui';
import { findNode, getWidgetDef, isContainerType, locateNode, type ElementNode } from '@amable/builder';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { Copy, GripVertical, Lock, LockOpen, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { useI18n } from '../../../i18n';
import { useBuilderLabel } from '../lib/builder-i18n';

interface NodeActions {
  disabled?: boolean;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}

function NodeRow({
  node,
  depth,
  selectedId,
  onSelect,
  actions,
}: {
  node: ElementNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  actions: NodeActions;
}) {
  const { t } = useI18n();
  const label = useBuilderLabel();
  const drag = useDraggable({ id: node.id, disabled: actions.disabled });
  const drop = useDroppable({ id: node.id });
  const isContainer = isContainerType(node.type);
  const title = label(getWidgetDef(node.type)?.title) || node.type;
  const selected = selectedId === node.id;
  return (
    <div>
      <div
        ref={drop.setNodeRef}
        className={cn('group flex items-center gap-1 rounded pr-1 text-sm', drop.isOver && 'ring-1 ring-primary', selected && 'bg-muted')}
        style={{ paddingLeft: depth * 12 }}
        onContextMenu={(e) => {
          if (actions.disabled) return;
          e.preventDefault();
          onSelect(node.id);
          actions.onContextMenu(node.id, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          ref={drag.setNodeRef}
          {...drag.listeners}
          {...drag.attributes}
          aria-label={t('landing.editor.dragToMove')}
          className="cursor-grab p-1 text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical aria-hidden className="size-3.5" />
        </button>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left" onClick={() => onSelect(node.id)}>
          <span className="truncate">{title}</span>
          {node.locked ? <Lock aria-label={t('landing.editor.locked')} className="size-3 shrink-0 text-muted-foreground" /> : null}
          {isContainer ? <span className="text-[10px] text-muted-foreground">({node.children.length})</span> : null}
        </button>
        {!actions.disabled ? (
          <div className={cn('items-center gap-0.5', selected ? 'flex' : 'hidden group-hover:flex')}>
            <button
              type="button"
              aria-label={t('landing.editor.duplicate')}
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() => actions.onDuplicate(node.id)}
            >
              <Copy aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={node.locked ? t('landing.editor.unlock') : t('landing.editor.lock')}
              className="p-1 text-muted-foreground hover:text-foreground"
              onClick={() => actions.onToggleLock(node.id)}
            >
              {node.locked ? <LockOpen aria-hidden className="size-3.5" /> : <Lock aria-hidden className="size-3.5" />}
            </button>
            <button
              type="button"
              aria-label={t('landing.editor.delete')}
              className="p-1 text-muted-foreground hover:text-destructive"
              onClick={() => actions.onDelete(node.id)}
            >
              <Trash2 aria-hidden className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <div>
          {node.children.map((c) => (
            <NodeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} actions={actions} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Element tree with its own drag & drop (dnd-kit) for reordering and reparenting. */
export function Navigator({
  body,
  selectedId,
  disabled,
  onSelect,
  onMove,
  onDuplicate,
  onToggleLock,
  onDelete,
  onContextMenu,
}: {
  body: ElementNode[];
  selectedId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onMove: (id: string, parentId: string | null, index: number) => void;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}) {
  const { t } = useI18n();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (disabled) return;
      const activeId = String(e.active.id);
      const overId = e.over ? String(e.over.id) : null;
      if (!overId || overId === activeId) return;
      const target = findNode(body, overId);
      if (target && isContainerType(target.type)) {
        onMove(activeId, overId, target.children.length);
        return;
      }
      const loc = locateNode(body, overId);
      if (!loc) return;
      const orig = locateNode(body, activeId);
      const index = orig && orig.parentId === loc.parentId && orig.index < loc.index ? loc.index : loc.index + 1;
      onMove(activeId, loc.parentId, index);
    },
    [body, disabled, onMove],
  );

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex flex-col">
        {body.length === 0 ? <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('landing.editor.treeEmpty')}</p> : null}
        {body.map((n) => (
          <NodeRow
            key={n.id}
            node={n}
            depth={0}
            selectedId={selectedId}
            onSelect={onSelect}
            actions={{ disabled, onDuplicate, onToggleLock, onDelete, onContextMenu }}
          />
        ))}
      </div>
    </DndContext>
  );
}
