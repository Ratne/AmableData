import { ROLE_PERMISSIONS, ROLES, type Role } from '@amable/core';
import {
  DashboardButton,
  DashboardConfirmDialog,
  PageBody,
  PageToolbar,
  toast,
  usePageChrome,
} from '@amable/ui';
import { Avatar, AvatarFallback } from '@amable/ui/ui/avatar';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@amable/ui/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogOut, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useMe } from '../../../lib/api';
import { FormField, SectionCard } from '../../../components/feature-kit';
import { PageState } from '../../commerce/components/common';
import {
  memberErrorCode,
  memberKeys,
  useMembersApi,
  type Member,
  type PendingInvite,
} from '../api';

type Translate = ReturnType<typeof useI18n>['t'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorText(t: Translate, error: unknown): string {
  switch (memberErrorCode(error)) {
    case 'last_owner':
      return t('members.error.lastOwner');
    case 'forbidden':
      return t('members.error.forbidden');
    case 'step_up_required':
      return t('members.error.stepUp');
    case 'rate_limited':
      return t('members.error.rateLimited');
    case 'member_not_found':
    case 'invite_not_found':
      return t('members.error.notFound');
    default:
      return t('common.error');
  }
}

function formatDate(locale: string, value: number): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
}

function initials(member: Member): string {
  const source = member.name?.trim() || member.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Only owners (tenant:transfer) may touch owners or grant ownership — mirrors the server rule. */
function canTouch(actor: Role, role: Role): boolean {
  return role !== 'owner' || ROLE_PERMISSIONS[actor].includes('tenant:transfer');
}

export function MembersPage() {
  const { t } = useI18n();
  const { slug, api } = useMembersApi();
  usePageChrome({ title: t('nav.members') });
  const me = useQuery({ queryKey: memberKeys.me(slug), queryFn: api.me, staleTime: 60_000 });
  const allowed = me.data?.permissions.includes('users:manage') ?? false;
  const members = useQuery({
    queryKey: memberKeys.members(slug),
    queryFn: api.members,
    enabled: allowed,
  });
  const invites = useQuery({
    queryKey: memberKeys.invites(slug),
    queryFn: api.invites,
    enabled: allowed,
  });

  if (me.data !== undefined && !allowed) {
    return <PageBody className="pt-4 text-sm">{t('members.noAccess')}</PageBody>;
  }
  return (
    <PageState isPending={me.isPending || members.isPending} error={me.error ?? members.error}>
      {() =>
        me.data && members.data ? (
          <MembersView
            actorRole={me.data.role}
            tenantName={me.data.tenant.name}
            members={members.data.members}
            invites={invites.data?.invites ?? []}
            invitesPending={invites.isPending}
          />
        ) : null
      }
    </PageState>
  );
}

function MembersView({
  actorRole,
  tenantName,
  members,
  invites,
  invitesPending,
}: {
  actorRole: Role;
  tenantName: string;
  members: Member[];
  invites: PendingInvite[];
  invitesPending: boolean;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useMembersApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const self = useMe().data?.user.id ?? null;
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [revoking, setRevoking] = useState<PendingInvite | null>(null);
  const [leaving, setLeaving] = useState(false);

  const owners = members.filter((m) => m.role === 'owner').length;
  const isLastOwner = (m: Member) => m.role === 'owner' && owners <= 1;
  const grantable = ROLES.filter((role) => canTouch(actorRole, role));

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members', slug] });
  const onError = (error: unknown) => {
    toast.error(errorText(t, error));
    const code = memberErrorCode(error);
    if (code === 'member_not_found' || code === 'invite_not_found' || code === 'last_owner')
      void refresh();
  };

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.changeRole(userId, role),
    onSuccess: async () => {
      await refresh();
      toast.success(t('members.roleChanged'));
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.remove(userId),
    onSuccess: async () => {
      await refresh();
      toast.success(t('members.removed'));
    },
    onError,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: memberKeys.invites(slug) });
      toast.success(t('members.revoked'));
    },
    onError,
  });
  const leave = useMutation({
    mutationFn: api.leave,
    onSuccess: async () => {
      toast.success(t('members.left'));
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.removeQueries({ queryKey: ['members', slug] });
      void navigate({ to: '/' });
    },
    onError,
  });

  return (
    <>
      <PageToolbar
        actions={
          <DashboardButton variant="primary" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden />
            {t('members.invite')}
          </DashboardButton>
        }
      />
      <PageBody className="grid max-w-5xl gap-4 pt-4">
        <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">
          {t('members.intro')}
        </p>

        <SectionCard title={t('members.listTitle')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('members.name')}</TableHead>
                <TableHead>{t('members.role')}</TableHead>
                <TableHead>{t('members.since')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isSelf = member.userId === self;
                const locked = isLastOwner(member);
                const manageable = canTouch(actorRole, member.role) && !locked;
                return (
                  <TableRow key={member.userId}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="size-8">
                          <AvatarFallback className="text-xs">{initials(member)}</AvatarFallback>
                        </Avatar>
                        <div className="grid min-w-0">
                          <span className="flex items-center gap-2 truncate font-medium">
                            {member.name ?? member.email}
                            {isSelf ? <Badge variant="secondary">{t('members.you')}</Badge> : null}
                          </span>
                          {member.name !== null ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {member.email}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={member.role}
                        disabled={!manageable || changeRole.isPending}
                        onValueChange={(value) => {
                          const role = ROLES.find((r) => r === value);
                          if (role !== undefined && role !== member.role) {
                            changeRole.mutate({ userId: member.userId, role });
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-44"
                          aria-label={t('members.role')}
                          title={locked ? t('members.lastOwnerHint') : undefined}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(manageable ? grantable : [member.role]).map((role) => (
                            <SelectItem key={role} value={role}>
                              {t(`roles.${role}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(locale, member.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {isSelf ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!manageable || remove.isPending}
                          onClick={() => setRemoving(member)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                          {t('members.remove')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </SectionCard>

        <SectionCard title={t('members.invitesTitle')}>
          {invites.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {invitesPending ? t('common.loading') : t('members.invitesEmpty')}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('members.email')}</TableHead>
                  <TableHead>{t('members.role')}</TableHead>
                  <TableHead>{t('members.sent')}</TableHead>
                  <TableHead>{t('members.expires')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => (
                  <TableRow key={invite.id}>
                    <TableCell className="font-medium">{invite.email}</TableCell>
                    <TableCell>{t(`roles.${invite.role}`)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(locale, invite.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(locale, invite.expiresAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => setRevoking(invite)}
                      >
                        {t('members.revoke')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <SectionCard title={t('members.rolesTitle')}>
          <dl className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((role) => (
              <div key={role} className="grid gap-0.5">
                <dt className="text-sm font-medium">{t(`roles.${role}`)}</dt>
                <dd className="text-xs text-muted-foreground">{t(`members.roleDesc.${role}`)}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>

        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 p-4">
          <p className="text-sm text-muted-foreground">{t('members.leaveHint')}</p>
          <DashboardButton
            variant="danger"
            disabled={leave.isPending}
            onClick={() => setLeaving(true)}
          >
            <LogOut aria-hidden />
            {t('members.leave')}
          </DashboardButton>
        </section>
      </PageBody>

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        grantable={grantable}
        onInvited={refresh}
      />
      <DashboardConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('members.removeTitle')}
        description={t('members.removeConfirm', { name: removing?.name ?? removing?.email ?? '' })}
        confirmLabel={t('members.remove')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing.userId);
          setRemoving(null);
        }}
      />
      <DashboardConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t('members.revokeTitle')}
        description={t('members.revokeConfirm', { email: revoking?.email ?? '' })}
        confirmLabel={t('members.revoke')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (revoking !== null) revoke.mutate(revoking.id);
          setRevoking(null);
        }}
      />
      <DashboardConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={t('members.leaveTitle')}
        description={t('members.leaveConfirm', { tenant: tenantName })}
        confirmLabel={t('members.leave')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          leave.mutate();
          setLeaving(false);
        }}
      />
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  grantable,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  grantable: readonly Role[];
  onInvited: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { api } = useMembersApi();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const typed = email.trim();
  const valid = EMAIL_RE.test(typed) && typed.length <= 320;

  const invite = useMutation({
    mutationFn: () => api.invite({ email: typed, role }),
    onSuccess: async () => {
      await onInvited();
      toast.success(t('members.invited', { email: typed }));
      setEmail('');
      setRole('viewer');
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorText(t, error)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !invite.isPending) invite.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('members.inviteTitle')}</DialogTitle>
            <DialogDescription>{t('members.inviteHint')}</DialogDescription>
          </DialogHeader>
          <FormField label={t('members.email')}>
            {(id) => (
              <Input
                id={id}
                type="email"
                autoComplete="off"
                maxLength={320}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            )}
          </FormField>
          <FormField label={t('members.role')} hint={t(`members.roleDesc.${role}`)}>
            {(id) => (
              <Select
                value={role}
                onValueChange={(value) => {
                  const next = grantable.find((r) => r === value);
                  if (next !== undefined) setRole(next);
                }}
              >
                <SelectTrigger id={id} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {grantable.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || invite.isPending}>
              {t('members.inviteSend')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
