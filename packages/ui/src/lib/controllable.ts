import { useCallback, useState } from 'react';

/** Ease-out curve shared by the shell and list animations. */
export const EASE_OUT = [0.25, 1, 0.5, 1] as const;

/** State that the parent may own (`value` defined) or leave to the component. */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const isControlled = value !== undefined;
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setUncontrolledValue(next);
      onChange?.(next);
    },
    [isControlled, onChange],
  );
  return [isControlled ? value : uncontrolledValue, setValue] as const;
}
