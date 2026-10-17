import type { GoalTriggerType, StepType } from '@amable/api-types';
import {
  BadgeCheck,
  Blocks,
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  CircleStop,
  ClipboardList,
  Clock,
  Code,
  Eye,
  FileInput,
  Flag,
  Gauge,
  Globe,
  Handshake,
  KanbanSquare,
  ListMinus,
  ListPlus,
  Mail,
  MousePointerClick,
  PencilLine,
  ShoppingBag,
  ShoppingCart,
  StickyNote,
  Tag,
  TagsIcon,
  Timer,
  UserCheck,
  UserPlus,
  Webhook,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

const GOAL_ICONS: Record<GoalTriggerType, LucideIcon> = {
  tag_applied: Tag,
  tag_removed: TagsIcon,
  contact_created: UserPlus,
  form_submitted: FileInput,
  product_purchased: ShoppingBag,
  order_paid: BadgeCheck,
  email_opened: Eye,
  email_clicked: MousePointerClick,
  lead_score: Gauge,
  api: Code,
  web_goal: Globe,
  appointment_booked: CalendarCheck,
  opportunity_stage_changed: KanbanSquare,
  date_anniversary: CalendarClock,
  app_event: Blocks,
};

const STEP_ICONS: Record<StepType, LucideIcon> = {
  delay: Timer,
  wait_until: CalendarClock,
  field_timer: Clock,
  send_email: Mail,
  apply_tag: Tag,
  remove_tag: TagsIcon,
  add_note: StickyNote,
  create_task: ClipboardList,
  create_appointment: CalendarPlus,
  set_field: PencilLine,
  assign_owner: UserCheck,
  create_opportunity: Handshake,
  move_opportunity_stage: KanbanSquare,
  create_order: ShoppingCart,
  cancel_subscription: XCircle,
  http_request: Webhook,
  app_action: Blocks,
  add_to_sequence: ListPlus,
  remove_from_sequence: ListMinus,
  end: CircleStop,
};

export function GoalIcon({ type, className }: { type: GoalTriggerType; className?: string }) {
  const Icon = GOAL_ICONS[type] ?? Flag;
  return <Icon className={className} aria-hidden />;
}

export function StepIcon({ type, className }: { type: StepType; className?: string }) {
  const Icon = STEP_ICONS[type];
  return <Icon className={className} aria-hidden />;
}
