import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  CalendarClock,
  Check,
  Pencil,
  RotateCcw,
  SkipForward,
  Trash2,
} from 'lucide-react';
import type { EditScope, TaskSeriesResponse } from '@family/shared';
import { Can } from '@/shared/auth/Can';
import { SideColumn } from '@/app/layout/SideColumn';
import { useCan } from '@/shared/auth/use-can';
import { PageHeader } from '@/shared/components/PageHeader';
import { ErrorState } from '@/shared/components/ErrorState';
import { ConfirmDialog } from '@/shared/components/ConfirmDialog';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Separator } from '@/shared/ui/separator';
import { ROUTES, taskDetail } from '@/shared/lib/routes';
import { formatDateTime } from '@/shared/lib/format';
import { COMMON } from '@/shared/lib/i18n';
import { TASKS_RU } from '../locale';
import { isRecurring } from '../recurrence';
import {
  useDeleteSeries,
  useCompleteOccurrence,
  useMembers,
  useOccurrence,
  useSeries,
  useSkipOccurrence,
  useSwaps,
  useUncompleteOccurrence,
} from '../hooks';
import { fetchOccurrences } from '../api';
import { AssigneeControl } from '../components/AssigneeControl';
import { EditScopeDialog } from '@/shared/components';
import { TaskEditor } from '../components/TaskEditor';
import { SwapRequestButton } from '../components/SwapPanel';
import { TaskDetailSkeleton } from '../components/Skeletons';

/**
 * `/tasks/:taskId` — one **occurrence**, with its series behind it.
 *
 * Every mutation that can touch more than this instance (edit, delete) routes
 * through the scope prompt first; completion, skip and assignment are
 * per-occurrence by construction and need no such question.
 */
export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { can, userId } = useCan();

  const occurrenceQuery = useOccurrence(taskId);
  const occurrence = occurrenceQuery.data;
  const seriesQuery = useSeries(occurrence?.seriesId);
  const series = seriesQuery.data;
  const members = useMembers();
  const outgoing = useSwaps('outgoing');

  const complete = useCompleteOccurrence();
  const uncomplete = useUncompleteOccurrence();
  const skip = useSkipOccurrence();
  const remove = useDeleteSeries();

  const [editing, setEditing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  /** `'following'` while we work out where this date went; see {@link followSaved}. */
  const [afterSave, setAfterSave] = useState<'idle' | 'following' | 'rescheduled'>('idle');
  const [deleteScopeOpen, setDeleteScopeOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * Where this date went, after a save that may have moved it.
   *
   * An edit keeps the occurrences it did not change, so the usual save leaves
   * this page exactly where it was. Two edits legitimately retire the row we
   * are standing on, though, and neither may end at «Задача не найдена»:
   *
   * - `this_and_future` splits the series, so the same date belongs to the
   *   **successor** now — and `saved` *is* the successor, so one lookup by date
   *   finds the row that replaced ours;
   * - a schedule change can drop this day altogether, and then there is nothing
   *   to navigate to and nothing to invent. That is not an error, so it does
   *   not get an error's wording.
   */
  const followSaved = (saved: TaskSeriesResponse): void => {
    if (!occurrence) return;
    const { id: previousId, localDate } = occurrence;
    setAfterSave('following');

    void fetchOccurrences({ seriesId: saved.id, from: localDate, to: localDate, limit: 5 })
      .then((page) => {
        const replacement = page.items.find((item) => item.id !== previousId);
        if (page.items.some((item) => item.id === previousId)) {
          setAfterSave('idle');
          return;
        }
        if (!replacement) {
          setAfterSave('rescheduled');
          return;
        }
        // `replace`, not `push`: the id we came in on no longer resolves, so
        // leaving it in the history stack only arms the back button with a 404.
        setAfterSave('idle');
        void navigate(taskDetail(replacement.id), { replace: true });
      })
      .catch(() => {
        // The lookup is a courtesy. If it fails, fall back to whatever the
        // occurrence query itself has to say.
        setAfterSave('idle');
      });
  };

  const back = (
    <Link
      to={ROUTES.tasks}
      className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {TASKS_RU.backToList}
    </Link>
  );

  if (occurrenceQuery.isPending || afterSave === 'following') {
    return (
      <>
        <PageHeader title={TASKS_RU.title} eyebrow={back} />
        <TaskDetailSkeleton />
      </>
    );
  }

  if (afterSave === 'rescheduled') {
    return (
      <>
        <PageHeader title={TASKS_RU.rescheduledTitle} eyebrow={back} />
        <ErrorState
          title={TASKS_RU.rescheduledTitle}
          description={TASKS_RU.rescheduledDescription}
          onRetry={() => {
            void navigate(ROUTES.tasks);
          }}
          retryLabel={TASKS_RU.backToList}
        />
      </>
    );
  }

  if (occurrenceQuery.isError || !occurrence) {
    return (
      <>
        <PageHeader title={TASKS_RU.notFoundTitle} eyebrow={back} />
        <ErrorState
          error={occurrenceQuery.error}
          title={TASKS_RU.notFoundTitle}
          description={TASKS_RU.notFoundDescription}
          onRetry={() => {
            void occurrenceQuery.refetch();
          }}
        />
      </>
    );
  }

  const roster = members.data ?? [];
  const recurring = series ? isRecurring(series.recurrence) : false;
  const isDone = occurrence.status === 'done';
  const closed = occurrence.status === 'skipped' || occurrence.status === 'cancelled';
  const mine = occurrence.assigneeId !== null && occurrence.assigneeId === userId;
  const myPendingSwap = (outgoing.data?.items ?? []).find(
    (swap) => swap.occurrenceId === occurrence.id && swap.status === 'pending',
  );

  const runDelete = (scope: EditScope) => {
    if (!series) return;
    remove.mutate(
      {
        seriesId: series.id,
        body: { scope, ...(scope === 'all' ? {} : { occurrenceId: occurrence.id }) },
      },
      {
        onSuccess: () => {
          void navigate(ROUTES.tasks);
        },
      },
    );
  };

  return (
    <>
      <PageHeader
        title={occurrence.title}
        eyebrow={back}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {occurrence.isOverdue ? (
              <Badge variant="destructive">{TASKS_RU.card.overdue}</Badge>
            ) : null}
            {isDone ? <Badge variant="secondary">{TASKS_RU.detail.statusDone}</Badge> : null}
            {occurrence.status === 'skipped' ? (
              <Badge variant="secondary">{TASKS_RU.detail.statusSkipped}</Badge>
            ) : null}
            {occurrence.status === 'cancelled' ? (
              <Badge variant="secondary">{TASKS_RU.detail.statusCancelled}</Badge>
            ) : null}
            {occurrence.isException ? (
              <Badge variant="outline">{TASKS_RU.detail.exception}</Badge>
            ) : null}
          </span>
        }
      />

      <div className="min-w-0 space-y-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          {!closed ? (
            <Button
              className="min-h-12 flex-1"
              variant={isDone ? 'outline' : 'default'}
              disabled={
                complete.isPending ||
                uncomplete.isPending ||
                (!isDone && !can('task:complete', occurrence))
              }
              onClick={() => {
                if (isDone) uncomplete.mutate({ occurrenceId: occurrence.id });
                else complete.mutate({ occurrenceId: occurrence.id });
              }}
            >
              {isDone ? (
                <>
                  <RotateCcw className="size-4" aria-hidden />
                  {TASKS_RU.card.uncomplete}
                </>
              ) : (
                <>
                  <Check className="size-4" aria-hidden />
                  {TASKS_RU.card.complete}
                </>
              )}
            </Button>
          ) : null}

          {!isDone && !closed ? (
            <Can perm="task:update" resource={series ?? occurrence}>
              <Button
                variant="outline"
                className="min-h-12"
                onClick={() => {
                  setSkipping(true);
                }}
              >
                <SkipForward className="size-4" aria-hidden />
                {TASKS_RU.actions.skip}
              </Button>
            </Can>
          ) : null}
        </div>

        <dl className="grid gap-x-6 gap-y-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2">
          <Row label={TASKS_RU.detail.starts} value={formatDateTime(occurrence.startsAt)} />
          <Row label={TASKS_RU.detail.due} value={formatDateTime(occurrence.dueAt)} />
          {occurrence.category ? (
            <Row label={TASKS_RU.detail.category} value={occurrence.category} />
          ) : null}
          {occurrence.completedAt ? (
            <Row
              label={TASKS_RU.detail.completedAt}
              value={formatDateTime(occurrence.completedAt)}
            />
          ) : null}
        </dl>

        {occurrence.notes ? (
          <section className="space-y-1 rounded-2xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground">{TASKS_RU.detail.notes}</h2>
            <p className="text-sm text-pretty whitespace-pre-line text-muted-foreground">
              {occurrence.notes}
            </p>
          </section>
        ) : null}

        <section className="space-y-3 rounded-2xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">{TASKS_RU.detail.assignee}</h2>
          <AssigneeControl occurrence={occurrence} members={roster} />
          {!can('task:assign') ? (
            <p className="text-xs text-muted-foreground">{TASKS_RU.assign.readOnlyHint}</p>
          ) : null}
          {mine && !isDone && !closed ? (
            <>
              <Separator />
              <SwapRequestButton
                occurrence={occurrence}
                members={roster.filter((member) => member.id !== userId)}
                outgoing={myPendingSwap}
              />
            </>
          ) : null}
        </section>
      </div>

      {/* §C1: the shell owns the second column; this page only says what goes in it. */}
      <SideColumn>
        <div className="space-y-4">
          <section className="space-y-2 rounded-2xl border border-border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <CalendarClock className="size-4" aria-hidden />
              {TASKS_RU.detail.schedule}
            </h2>
            <p className="text-sm text-pretty text-muted-foreground">
              {series ? series.recurrence.summary : TASKS_RU.detail.seriesOnce}
            </p>

            <div className="flex flex-col gap-2 pt-1">
              {series ? (
                <Can perm="task:update" resource={series}>
                  <Button
                    variant="outline"
                    className="min-h-11 w-full"
                    onClick={() => {
                      setEditing(true);
                    }}
                  >
                    <Pencil className="size-4" aria-hidden />
                    {TASKS_RU.actions.edit}
                  </Button>
                </Can>
              ) : null}
              {series ? (
                <Can perm="task:delete" resource={series}>
                  <Button
                    variant="ghost"
                    className="min-h-11 w-full text-destructive hover:text-destructive"
                    onClick={() => {
                      if (recurring) setDeleteScopeOpen(true);
                      else setConfirmDelete(true);
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {TASKS_RU.actions.delete}
                  </Button>
                </Can>
              ) : null}
            </div>
          </section>
        </div>
      </SideColumn>

      {series ? (
        <TaskEditor
          open={editing}
          onOpenChange={setEditing}
          series={series}
          occurrence={occurrence}
          members={roster}
          onSaved={followSaved}
        />
      ) : null}

      <EditScopeDialog
        open={deleteScopeOpen}
        onOpenChange={setDeleteScopeOpen}
        intent="delete"
        strings={TASKS_RU.scope}
        onConfirm={(scope) => {
          setDeleteScopeOpen(false);
          runDelete(scope);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={TASKS_RU.delete.title}
        description={TASKS_RU.delete.description}
        confirmLabel={COMMON.delete}
        onConfirm={() => {
          runDelete('all');
        }}
      />

      <ConfirmDialog
        open={skipping}
        onOpenChange={setSkipping}
        destructive={false}
        title={TASKS_RU.skip.title}
        description={TASKS_RU.skip.description}
        confirmLabel={TASKS_RU.skip.confirm}
        onConfirm={() => {
          skip.mutate({ occurrenceId: occurrence.id, body: { suppressFuture: false } });
        }}
      />
    </>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{props.label}</dt>
      <dd className="truncate text-sm text-foreground">{props.value}</dd>
    </div>
  );
}
