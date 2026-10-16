import type { BroadcastStatus } from '@amable/api-types';
import { notFound, type MailDeps } from '../email/context';

/** Raw `mail_broadcasts` row (shared by the broadcast service and the send pipeline). */
export interface BroadcastRow {
  id: string;
  name: string;
  status: BroadcastStatus;
  segment: string | null;
  template_id: string | null;
  subject: string;
  body: string | null;
  from_name: string | null;
  reply_to: string | null;
  throttle_per_hour: number | null;
  schedule: string | null;
  next_send_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export function getBroadcastRow(deps: MailDeps, id: string): BroadcastRow {
  const row = deps.db.all<BroadcastRow>(
    `SELECT * FROM mail_broadcasts WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('broadcast', id);
  return row;
}
