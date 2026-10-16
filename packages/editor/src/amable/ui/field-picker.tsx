import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { LiquidField, LiquidFieldGroup } from '../fields';

export interface FieldPickerItem {
  readonly group: LiquidFieldGroup;
  readonly field: LiquidField;
}

export interface FieldPickerProps {
  readonly items: readonly FieldPickerItem[];
  readonly emptyLabel: string;
  readonly command: (item: FieldPickerItem) => void;
}

export interface FieldPickerHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/** Dropdown of the `{{` suggestion; keyboard handled through the suggestion plugin. */
export const FieldPicker = forwardRef<FieldPickerHandle, FieldPickerProps>(function FieldPicker(
  { items, emptyLabel, command },
  ref,
) {
  const [active, setActive] = useState(0);

  useEffect(() => setActive(0), [items]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: (event) => {
        if (items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setActive((index) => (index + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setActive((index) => (index - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[active];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [active, command, items],
  );

  if (items.length === 0) {
    return <div className="amable-field-picker amable-field-picker-empty">{emptyLabel}</div>;
  }

  let lastGroup: string | null = null;
  return (
    <div className="amable-field-picker" role="listbox">
      {items.map((item, index) => {
        const header = item.group.id !== lastGroup ? item.group.label : null;
        lastGroup = item.group.id;
        return (
          <div key={`${item.group.id}:${item.field.path}:${item.field.filter ?? ''}`}>
            {header ? <div className="amable-field-picker-group">{header}</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              data-active={index === active}
              className="amable-field-picker-item"
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => command(item)}
            >
              <span>{item.field.label}</span>
              <code>{item.field.path === 'now' ? item.field.filter : item.field.path}</code>
            </button>
          </div>
        );
      })}
    </div>
  );
});
