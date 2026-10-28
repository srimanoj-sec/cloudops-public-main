import { Link } from 'react-router-dom';
import { ArrowRight, ListChecks, RotateCcw, Trash2 } from 'lucide-react';
import { JOB_STATES, type JobState } from '@cloudops/core';
import { useJobAction, useQueueJob, useQueueJobs } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { duration, timeAgo } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  DescriptionList,
  EmptyState,
  ErrorState,
  LoadingBlock,
  MonoId,
  Panel,
  SegmentedControl,
  Select,
  TableSkeleton,
  type Tone,
} from '../../components/ui/primitives';
import { Modal } from '../../components/ui/Modal';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';

const STATE_TONE: Record<JobState, Tone> = {
  failed: 'danger',
  active: 'accent',
  waiting: 'neutral',
  delayed: 'neutral',
  completed: 'success',
};
const STATE_LABEL: Record<JobState, string> = {
  failed: 'Failed',
  active: 'Running',
  waiting: 'Waiting',
  delayed: 'Scheduled',
  completed: 'Completed',
};

/**
 * Job browser for one queue: what failed and why (with the stack), what's
 * running or waiting, and the safe interventions — retry a failed job, remove
 * one that isn't running.
 */
export function JobsPanel({
  queues,
  queue,
  state,
  jobId,
  onChange,
}: {
  queues: string[];
  queue: string;
  state: JobState;
  jobId: string | null;
  onChange: (next: { queue?: string; state?: JobState; job?: string | null }) => void;
}) {
  const jobs = useQueueJobs(queue, state);

  return (
    <Panel
      id="jobs"
      flush
      title="Jobs"
      description="Completed and failed jobs are kept for a while, then trimmed."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={queue}
            onChange={(e) => onChange({ queue: e.target.value })}
            aria-label="Queue"
            controlSize="sm"
          >
            {queues.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </Select>
          <SegmentedControl
            size="sm"
            label="Job state"
            value={state}
            onChange={(v) => onChange({ state: v })}
            options={JOB_STATES.map((s) => ({ value: s, label: STATE_LABEL[s] }))}
          />
        </div>
      }
    >
      {jobs.isLoading ? (
        <TableSkeleton rows={5} cols={4} />
      ) : jobs.isError ? (
        <ErrorState compact error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : !jobs.data?.length ? (
        <EmptyState
          compact
          icon={ListChecks}
          title={`No ${STATE_LABEL[state].toLowerCase()} jobs in ${queue}`}
          description={
            state === 'failed' ? 'Nothing has failed recently (or it was trimmed).' : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table data-table--compact">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">{state === 'failed' ? 'Why' : 'Payload'}</th>
                <th scope="col" className="num hidden sm:table-cell">
                  Attempts
                </th>
                <th scope="col" className="num hidden md:table-cell">
                  Took
                </th>
                <th scope="col" className="num">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id} data-interactive onClick={() => onChange({ job: j.id })}>
                  <td>
                    <button
                      type="button"
                      className="link-quiet font-mono"
                      onClick={(e) => (e.stopPropagation(), onChange({ job: j.id }))}
                    >
                      {j.name}
                    </button>
                  </td>
                  <td className="max-w-[28rem] truncate text-caption text-fg-muted">
                    {state === 'failed' ? (
                      <span className="text-danger">{j.failedReason ?? 'unknown'}</span>
                    ) : (
                      Object.entries(j.data)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' ') || '—'
                    )}
                  </td>
                  <td className="num hidden font-mono sm:table-cell">
                    {j.attemptsMade}/{j.maxAttempts}
                  </td>
                  <td className="num hidden font-mono md:table-cell">{duration(j.durationMs)}</td>
                  <td
                    className="num whitespace-nowrap font-mono text-fg-muted"
                    title={new Date(j.finishedAt ?? j.startedAt ?? j.queuedAt).toLocaleString()}
                  >
                    {timeAgo(j.finishedAt ?? j.startedAt ?? j.queuedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {jobId && <JobDetail queue={queue} id={jobId} onClose={() => onChange({ job: null })} />}
    </Panel>
  );
}

function JobDetail({ queue, id, onClose }: { queue: string; id: string; onClose: () => void }) {
  const job = useQueueJob(queue, id);
  const act = useJobAction();
  const confirm = useConfirm();
  const toast = useToast();
  const { can } = usePermissions();
  const j = job.data;
  const manage = can('system.manage');

  async function run(action: 'retry' | 'remove') {
    const ok = await confirm(
      action === 'retry'
        ? {
            title: 'Retry this job?',
            description: 'It goes back on the queue and runs again with the same input.',
            confirmLabel: 'Retry',
          }
        : {
            title: 'Remove this job?',
            description:
              'It’s deleted from the queue and its history. This doesn’t undo anything it already did.',
            confirmLabel: 'Remove',
            tone: 'danger',
          },
    );
    if (!ok) return;
    try {
      await act.mutateAsync({ queue, id, action });
      toast({ title: action === 'retry' ? 'Job re-queued' : 'Job removed' });
      if (action === 'remove') onClose();
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: apiErrorMessage(e) });
    }
  }

  return (
    <Modal
      size="lg"
      title={j ? j.name : 'Job'}
      description={`${queue} queue`}
      onClose={onClose}
      footer={
        j &&
        manage &&
        (j.canRetry || j.canRemove) && (
          <div className="flex w-full flex-wrap justify-end gap-2">
            {j.canRemove && (
              <Button
                variant="danger-ghost"
                icon={Trash2}
                loading={act.isPending && act.variables?.action === 'remove'}
                onClick={() => void run('remove')}
              >
                Remove
              </Button>
            )}
            {j.canRetry && (
              <Button
                icon={RotateCcw}
                loading={act.isPending && act.variables?.action === 'retry'}
                onClick={() => void run('retry')}
              >
                Retry
              </Button>
            )}
          </div>
        )
      }
    >
      {job.isLoading ? (
        <LoadingBlock label="Loading job…" />
      ) : job.isError || !j ? (
        <ErrorState compact error={job.error} />
      ) : (
        <div className="space-y-4">
          <DescriptionList
            items={[
              {
                label: 'State',
                value: (
                  <Badge tone={STATE_TONE[j.state]} dot>
                    {STATE_LABEL[j.state]}
                  </Badge>
                ),
              },
              { label: 'Job id', value: <MonoId value={j.id} truncate /> },
              { label: 'Attempts', value: `${j.attemptsMade} of ${j.maxAttempts}` },
              { label: 'Queued', value: new Date(j.queuedAt).toLocaleString() },
              {
                label: 'Ran',
                value: j.startedAt
                  ? `${new Date(j.startedAt).toLocaleString()}${j.durationMs != null ? ` · ${duration(j.durationMs)}` : ''}`
                  : '—',
              },
              ...Object.entries(j.data).map(([k, v]) => ({ label: k, value: v, mono: true })),
            ]}
          />
          {j.link && (
            <Link to={j.link} className="link inline-flex items-center gap-1 text-body-sm">
              See what it worked on <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}
          {j.failedReason && (
            <Alert tone="danger" title="Why it failed">
              <span className="break-words font-mono text-caption">{j.failedReason}</span>
            </Alert>
          )}
          {j.stacktrace.length > 0 && (
            <details className="rounded-sm border border-line px-3 py-2">
              <summary className="cursor-pointer text-body-sm text-fg-secondary">
                Stack trace
                {j.stacktrace.length > 1 ? `s (last ${j.stacktrace.length} attempts)` : ''}
              </summary>
              {j.stacktrace.map((s, i) => (
                <pre
                  key={i}
                  className="mt-2 overflow-x-auto whitespace-pre font-mono text-[11px] leading-4 text-fg-muted"
                >
                  {s}
                </pre>
              ))}
            </details>
          )}
          {j.returnValue && Object.keys(j.returnValue).length > 0 && (
            <section>
              <h3 className="mb-1 text-body-sm font-medium text-fg">Result</h3>
              <DescriptionList
                items={Object.entries(j.returnValue).map(([k, v]) => ({
                  label: k,
                  value: v,
                  mono: true,
                }))}
              />
            </section>
          )}
          {queue === 'remediation' && j.state === 'failed' && (
            <p className="text-caption text-fg-muted">
              Remediations aren’t retried from here — open it and request the change again so it’s
              re-planned and re-approved.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
