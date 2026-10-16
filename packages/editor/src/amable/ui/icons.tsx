import { memo, type ComponentPropsWithoutRef } from 'react';

type SvgProps = ComponentPropsWithoutRef<'svg'>;

export const PlusIcon = memo(function PlusIcon({ className, ...props }: SvgProps) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className={className} {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
});
