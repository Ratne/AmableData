import { Link } from '@tanstack/react-router';
import { forwardRef, type AnchorHTMLAttributes } from 'react';

/** Adapts the shell's `href`-based links to TanStack Router client-side navigation. */
export const ShellLink = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
>(function ShellLink({ href, ...props }, ref) {
  // The shell marks the active item itself; a fuzzy router match would also flag `settings` on `settings/members`.
  return <Link ref={ref} to={href} activeOptions={{ exact: true, includeSearch: false }} {...props} />;
});
