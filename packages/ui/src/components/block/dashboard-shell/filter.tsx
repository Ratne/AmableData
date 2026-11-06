'use client';

import { ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { DashboardButton } from './button';
import {
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuLabel,
  DashboardMenuRadioGroup,
  DashboardMenuRadioItem,
  DashboardMenuTrigger,
} from './menus';

export type DashboardFilterOption = { value: string; label: string };

export type DashboardFilterMenuProps = {
  /** Shown before the current value and as the menu heading, such as "Sort by". */
  label?: string;
  value: string;
  options: DashboardFilterOption[];
  onValueChange: (value: string) => void;
  align?: 'start' | 'end';
  className?: string;
};

export function DashboardFilterMenu({
  label,
  value,
  options,
  onValueChange,
  align = 'start',
  className,
}: DashboardFilterMenuProps) {
  const currentLabel = options.find((option) => option.value === value)?.label ?? value;

  return (
    <DashboardMenu>
      <DashboardMenuTrigger asChild>
        <DashboardButton
          variant="secondary"
          size="sm"
          aria-label={label ? `${label}: ${currentLabel}` : undefined}
          className={cn('group gap-0 overflow-hidden px-0', className)}
        >
          {label && (
            <>
              <span className="px-[9px] font-normal text-(--obsidian-dashboard-shell-text-subtle)">
                {label}
              </span>
              <span aria-hidden className="h-full w-px bg-(--obsidian-dashboard-shell-border)" />
            </>
          )}
          <span className="flex items-center gap-1.5 px-[9px]">
            {currentLabel}
            <ChevronDown
              aria-hidden
              className="text-(--obsidian-dashboard-shell-text-subtle) transition-transform duration-200 group-data-[state=open]:rotate-180"
            />
          </span>
        </DashboardButton>
      </DashboardMenuTrigger>
      <DashboardMenuContent align={align} className="min-w-44">
        {label && <DashboardMenuLabel>{label}</DashboardMenuLabel>}
        <DashboardMenuRadioGroup value={value} onValueChange={onValueChange}>
          {options.map((option) => (
            <DashboardMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DashboardMenuRadioItem>
          ))}
        </DashboardMenuRadioGroup>
      </DashboardMenuContent>
    </DashboardMenu>
  );
}
