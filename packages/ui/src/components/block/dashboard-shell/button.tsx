'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import type { ComponentProps } from 'react';
import { cn } from '../../../lib/utils';

export const dashboardButtonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium leading-none outline-none select-none transition-[background-color,color,box-shadow] duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] focus-visible:ring-2 focus-visible:ring-(--obsidian-dashboard-shell-ring) disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-(--obsidian-dashboard-shell-accent) text-(--obsidian-dashboard-shell-accent-foreground) shadow-(--obsidian-dashboard-shell-accent-shadow) hover:bg-(--obsidian-dashboard-shell-accent-hover)',
        secondary:
          'bg-(--obsidian-dashboard-shell-control) text-(--obsidian-dashboard-shell-foreground) shadow-(--obsidian-dashboard-shell-control-shadow) hover:bg-(--obsidian-dashboard-shell-muted) data-[state=open]:bg-(--obsidian-dashboard-shell-muted)',
        muted:
          'bg-(--obsidian-dashboard-shell-muted) text-(--obsidian-dashboard-shell-foreground) shadow-(--obsidian-dashboard-shell-control-shadow) hover:bg-(--obsidian-dashboard-shell-muted-hover)',
        ghost:
          'text-(--obsidian-dashboard-shell-text-subtle) hover:bg-(--obsidian-dashboard-shell-muted) hover:text-(--obsidian-dashboard-shell-foreground)',
        danger:
          'bg-(--obsidian-dashboard-shell-danger-solid) text-white shadow-[0_1px_2px_rgb(0_0_0/0.16),inset_0_1px_0_rgb(255_255_255/0.16),0_0_0_1px_rgb(0_0_0/0.08)] hover:bg-(--obsidian-dashboard-shell-danger-solid-hover)',
      },
      size: {
        sm: 'h-[30px] px-[9px] text-xs [&_svg]:size-3',
        md: 'h-8 px-2.5 text-sm [&_svg]:size-4',
        icon: 'size-[30px] [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
);

export type DashboardButtonProps = ComponentProps<'button'> &
  VariantProps<typeof dashboardButtonVariants>;

// React 18 only hands refs to function components through forwardRef; Radix triggers need it to anchor popovers.
export const DashboardButton = forwardRef<HTMLButtonElement, DashboardButtonProps>(
  function DashboardButton({ variant, size, className, type = 'button', ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(dashboardButtonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
