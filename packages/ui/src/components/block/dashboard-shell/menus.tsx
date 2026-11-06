'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useContext } from 'react';
import type { ComponentProps, FocusEvent } from 'react';
import { useControllableState } from '../../../lib/controllable';
import { cn } from '../../../lib/utils';
import { HoverHighlightContext, HoverHighlightList } from './highlight';
import { LayerOpenContext, ShellDarkContext, layerClassName, layerMotion } from './lib';

export type DashboardMenuProps = ComponentProps<typeof DropdownMenuPrimitive.Root>;

export function DashboardMenu({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: DashboardMenuProps) {
  const [isOpen, setIsOpen] = useControllableState(open, defaultOpen, onOpenChange);
  return (
    <LayerOpenContext.Provider value={isOpen}>
      <DropdownMenuPrimitive.Root open={isOpen} onOpenChange={setIsOpen} {...props} />
    </LayerOpenContext.Provider>
  );
}

export const DashboardMenuTrigger = DropdownMenuPrimitive.Trigger;

export type DashboardMenuContentProps = Omit<
  ComponentProps<typeof DropdownMenuPrimitive.Content>,
  'asChild' | 'forceMount'
>;

export function DashboardMenuContent({
  className,
  children,
  sideOffset = 6,
  ...props
}: DashboardMenuContentProps) {
  const isOpen = useContext(LayerOpenContext);
  const isDark = useContext(ShellDarkContext);
  const reduceMotion = !!useReducedMotion();

  return (
    <AnimatePresence>
      {isOpen && (
        <DropdownMenuPrimitive.Portal forceMount>
          <DropdownMenuPrimitive.Content forceMount asChild sideOffset={sideOffset} {...props}>
            <motion.div
              {...layerMotion(reduceMotion)}
              className={cn(
                layerClassName,
                isDark && 'dark',
                'obsidian-dashboard-shell-scroll max-h-(--radix-dropdown-menu-content-available-height) min-w-40 origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto overscroll-contain',
                className,
              )}
            >
              <HoverHighlightList highlightClassName="rounded-md bg-(--obsidian-dashboard-shell-menu-highlight)">
                {children}
              </HoverHighlightList>
            </motion.div>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      )}
    </AnimatePresence>
  );
}

const menuItemClassName =
  'relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-xs leading-none text-(--obsidian-dashboard-shell-text-muted) outline-none transition-[color,scale] duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] active:scale-[0.97] active:duration-75 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:text-(--obsidian-dashboard-shell-foreground) [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

// Radix focuses items on hover and with the arrow keys, so following focus moves the highlight for both.
function useHighlightOnFocus(
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void,
  onBlur?: (event: FocusEvent<HTMLDivElement>) => void,
) {
  const highlight = useContext(HoverHighlightContext);
  return {
    onFocus: (event: FocusEvent<HTMLDivElement>) => {
      onFocus?.(event);
      highlight?.show(event.currentTarget);
    },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      onBlur?.(event);
      highlight?.hide();
    },
  };
}

export function DashboardMenuItem({
  className,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  const focusHandlers = useHighlightOnFocus(onFocus, onBlur);
  return (
    <DropdownMenuPrimitive.Item
      className={cn(menuItemClassName, className)}
      {...focusHandlers}
      {...props}
    />
  );
}

export const DashboardMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

export function DashboardMenuRadioItem({
  className,
  children,
  onFocus,
  onBlur,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  const focusHandlers = useHighlightOnFocus(onFocus, onBlur);
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(
        menuItemClassName,
        'pr-8 data-[state=checked]:font-medium data-[state=checked]:text-(--obsidian-dashboard-shell-foreground)',
        className,
      )}
      {...focusHandlers}
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator className="absolute right-2.5 flex">
        <Check aria-hidden className="size-3.5!" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DashboardMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        'px-2.5 pb-2 pt-2.5 text-[11px] font-medium uppercase leading-none tracking-[1px] text-(--obsidian-dashboard-shell-text-subtle)',
        className,
      )}
      {...props}
    />
  );
}

export function DashboardMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-(--obsidian-dashboard-shell-border)', className)}
      {...props}
    />
  );
}

export type DashboardPopoverProps = ComponentProps<typeof PopoverPrimitive.Root>;

export function DashboardPopover({
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: DashboardPopoverProps) {
  const [isOpen, setIsOpen] = useControllableState(open, defaultOpen, onOpenChange);
  return (
    <LayerOpenContext.Provider value={isOpen}>
      <PopoverPrimitive.Root open={isOpen} onOpenChange={setIsOpen} {...props} />
    </LayerOpenContext.Provider>
  );
}

export const DashboardPopoverTrigger = PopoverPrimitive.Trigger;

export type DashboardPopoverContentProps = Omit<
  ComponentProps<typeof PopoverPrimitive.Content>,
  'asChild' | 'forceMount'
>;

export function DashboardPopoverContent({
  className,
  children,
  align = 'center',
  sideOffset = 6,
  ...props
}: DashboardPopoverContentProps) {
  const isOpen = useContext(LayerOpenContext);
  const isDark = useContext(ShellDarkContext);
  const reduceMotion = !!useReducedMotion();

  return (
    <AnimatePresence>
      {isOpen && (
        <PopoverPrimitive.Portal forceMount>
          <PopoverPrimitive.Content
            forceMount
            asChild
            align={align}
            sideOffset={sideOffset}
            {...props}
          >
            <motion.div
              {...layerMotion(reduceMotion)}
              className={cn(
                layerClassName,
                isDark && 'dark',
                'w-72 origin-(--radix-popover-content-transform-origin)',
                className,
              )}
            >
              {children}
            </motion.div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      )}
    </AnimatePresence>
  );
}
