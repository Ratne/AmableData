/** Members & roles settings page. */
export const membersEn = {
  'members.intro': 'People with access to this workspace and what each role can do.',
  'members.noAccess': 'You do not have access to this page.',
  'members.invite': 'Invite user',
  'members.inviteTitle': 'Invite a user',
  'members.inviteHint':
    'They get an email with a link to join. The invitation expires after a few days.',
  'members.inviteSend': 'Send invitation',
  'members.invited': 'Invitation sent to {email}',
  'members.email': 'Email',
  'members.role': 'Role',
  'members.listTitle': 'Members',
  'members.name': 'Name',
  'members.since': 'Member since',
  'members.you': 'You',
  'members.remove': 'Remove',
  'members.removeTitle': 'Remove member',
  'members.removeConfirm': '{name} loses access to this workspace immediately.',
  'members.removed': 'Member removed',
  'members.roleChanged': 'Role updated',
  'members.lastOwnerHint': 'The last owner cannot be changed or removed.',
  'members.invitesTitle': 'Pending invitations',
  'members.invitesEmpty': 'No pending invitations.',
  'members.sent': 'Sent',
  'members.expires': 'Expires',
  'members.revoke': 'Revoke',
  'members.revokeTitle': 'Revoke invitation',
  'members.revokeConfirm': 'The invitation link sent to {email} stops working.',
  'members.revoked': 'Invitation revoked',
  'members.rolesTitle': 'Roles',
  'members.roleDesc.owner':
    'Everything, including billing, ownership transfer and deleting the workspace.',
  'members.roleDesc.admin':
    'Everything except billing, transfer and deletion; cannot change or remove owners.',
  'members.roleDesc.marketer':
    'Contacts, marketing (emails, automations, forms, pages, bookings) and analytics; read-only sales and e-commerce, no settings.',
  'members.roleDesc.sales':
    'Contacts, opportunities, tasks, bookings and manual orders, single emails and sales reports; no bulk export.',
  'members.roleDesc.analyst':
    'Reads everything, creates reports and dashboards and exports CSV; never changes data.',
  'members.roleDesc.viewer':
    'Read-only everywhere: no export, no reports, sensitive fields hidden.',
  'members.leave': 'Leave workspace',
  'members.leaveTitle': 'Leave this workspace?',
  'members.leaveConfirm': 'You lose access to {tenant} until someone invites you again.',
  'members.leaveHint': 'Removes your own access to this workspace.',
  'members.left': 'You left the workspace',
  'members.error.lastOwner': 'There must always be at least one owner',
  'members.error.forbidden': 'You cannot manage this role',
  'members.error.stepUp': 'Confirmation with the second factor is required',
  'members.error.rateLimited': 'Too many invitations: try again later',
  'members.error.notFound': 'It no longer exists: the list has been refreshed',
} as const;

export type MembersMessageKey = keyof typeof membersEn;
