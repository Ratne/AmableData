import type { IdeaStatus } from '@amable/core/platform';
import { cn, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Textarea } from '@amable/ui/ui/textarea';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { ChevronUp, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { apiFetch } from '../../lib/api';
import {
  base,
  errorKey,
  IDEA_STATUSES,
  isUnavailable,
  postJson,
  supportKeys,
  useDate,
  type ChangelogEntry,
  type Idea,
} from './api';
import { ErrorText, Pill, Section, UnavailableNotice, type Tone } from './components';

const STATUS_TONE: Record<IdeaStatus, Tone> = { under_review: 'neutral', planned: 'info', released: 'success' };

/** `/t/$tenant/ideas` — product ideas board (vote, propose) next to the changelog. */
export function IdeasPage() {
  const { t } = useI18n();
  const slug = useParams({ strict: false, select: (p: { tenant?: string }) => p.tenant ?? '' });
  const date = useDate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<IdeaStatus | 'all'>('all');
  const [proposing, setProposing] = useState(false);
  usePageChrome({
    title: t('nav.ideas'),
    tabs: [
      { value: 'all', label: t('sup.ideas.all') },
      ...IDEA_STATUSES.map((s) => ({ value: s, label: t(`sup.ideas.status.${s}`) })),
    ],
    tab: filter,
    onTabChange: (value) => setFilter(IDEA_STATUSES.find((s) => s === value) ?? 'all'),
  });
  const board = useQuery({
    queryKey: supportKeys.ideas(slug),
    queryFn: () => apiFetch<{ ideas: Idea[]; changelog: ChangelogEntry[] }>(`${base(slug)}/ideas`),
    retry: false,
  });
  const vote = useMutation({
    mutationFn: (idea: Idea) =>
      apiFetch(`${base(slug)}/ideas/${idea.id}/vote`, { method: idea.votedByMe ? 'DELETE' : 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: supportKeys.ideas(slug) }),
  });

  if (isUnavailable(board.error)) return <UnavailableNotice />;
  const ideas = (board.data?.ideas ?? [])
    .filter((idea) => filter === 'all' || idea.status === filter)
    .sort((a, b) => b.votes - a.votes);

  return (
    <>
      <PageToolbar
        actions={
          <Button size="sm" onClick={() => setProposing(true)}>
            <Plus aria-hidden />
            {t('sup.ideas.propose')}
          </Button>
        }
      />
      <PageBody className="grid gap-4 lg:grid-cols-[1fr_minmax(16rem,22rem)]">
        <div className="space-y-2">
          {board.error ? <ErrorText>{t(errorKey(board.error))}</ErrorText> : null}
          {vote.error ? <ErrorText>{t(errorKey(vote.error))}</ErrorText> : null}
          {ideas.length === 0 && !board.isPending ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
              {t('sup.ideas.empty')}
            </p>
          ) : null}
          {ideas.map((idea) => (
            <article key={idea.id} className="flex gap-3 rounded-lg border border-border bg-card p-3">
              <button
                type="button"
                aria-pressed={idea.votedByMe}
                aria-label={idea.votedByMe ? t('sup.ideas.voted') : t('sup.ideas.vote')}
                disabled={vote.isPending}
                onClick={() => vote.mutate(idea)}
                className={cn(
                  'flex w-12 shrink-0 flex-col items-center justify-center rounded-md border text-xs font-semibold',
                  idea.votedByMe ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-accent',
                )}
              >
                <ChevronUp className="size-4" aria-hidden />
                {idea.votes}
              </button>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{idea.title}</h3>
                  <Pill tone={STATUS_TONE[idea.status]}>{t(`sup.ideas.status.${idea.status}`)}</Pill>
                  {idea.releasedIn ? (
                    <span className="text-xs text-muted-foreground">
                      {t('sup.ideas.releasedIn', { version: idea.releasedIn })}
                    </span>
                  ) : null}
                </div>
                {idea.body ? <p className="line-clamp-3 text-sm text-muted-foreground">{idea.body}</p> : null}
              </div>
            </article>
          ))}
        </div>
        <Section title={t('sup.ideas.changelog')}>
          {(board.data?.changelog ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('sup.ideas.noChangelog')}</p>
          ) : (
            <ol className="space-y-3">
              {(board.data?.changelog ?? []).map((entry) => (
                <li key={entry.id} className="space-y-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{entry.title}</span>
                    {entry.version ? <span className="text-xs text-muted-foreground">{entry.version}</span> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{date(entry.publishedAt)}</p>
                  {entry.body ? <p className="text-sm whitespace-pre-wrap">{entry.body}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </Section>
      </PageBody>
      <ProposeDialog slug={slug} open={proposing} onClose={() => setProposing(false)} />
    </>
  );
}

function ProposeDialog({ slug, open, onClose }: { slug: string; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const propose = useMutation({
    mutationFn: () => postJson(`${base(slug)}/ideas`, { title, body }),
    onSuccess: () => {
      toast.success(t('sup.ideas.proposed'));
      void queryClient.invalidateQueries({ queryKey: supportKeys.ideas(slug) });
      setTitle('');
      setBody('');
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    propose.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>{t('sup.ideas.propose')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="idea-title">{t('sup.ideas.ideaTitle')}</Label>
            <Input id="idea-title" value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={140} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="idea-body">{t('sup.ideas.ideaBody')}</Label>
            <Textarea id="idea-body" rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5_000} />
          </div>
          {propose.error ? <ErrorText>{t(errorKey(propose.error))}</ErrorText> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('sup.cancel')}
            </Button>
            <Button type="submit" disabled={propose.isPending}>
              {t('sup.ideas.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
