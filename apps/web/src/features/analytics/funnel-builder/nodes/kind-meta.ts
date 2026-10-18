import type { FunnelNodeKind } from '@amable/api-types';
import {
  ExternalLink,
  Files,
  Forward,
  GitBranch,
  Megaphone,
  Shuffle,
  Tag,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

/** Icon and colour of each node kind, shared by the canvas nodes and the palette. */
export const KIND_META: Readonly<Record<FunnelNodeKind, { icon: LucideIcon; tone: string }>> = {
  traffic: { icon: Megaphone, tone: 'bg-violet-500/15 text-violet-800 dark:text-violet-200' },
  rotator: { icon: Shuffle, tone: 'bg-sky-500/15 text-sky-800 dark:text-sky-200' },
  page_group: { icon: Files, tone: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' },
  condition: { icon: GitBranch, tone: 'bg-amber-500/15 text-amber-800 dark:text-amber-200' },
  external_url: { icon: ExternalLink, tone: 'bg-slate-500/15 text-slate-800 dark:text-slate-200' },
  action_proxy: { icon: Forward, tone: 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-200' },
  tag: { icon: Tag, tone: 'bg-pink-500/15 text-pink-800 dark:text-pink-200' },
  webhook: { icon: Webhook, tone: 'bg-orange-500/15 text-orange-800 dark:text-orange-200' },
};

/** Palette order. */
export const PALETTE_KINDS: readonly FunnelNodeKind[] = [
  'traffic',
  'rotator',
  'page_group',
  'condition',
  'action_proxy',
  'tag',
  'webhook',
  'external_url',
];
