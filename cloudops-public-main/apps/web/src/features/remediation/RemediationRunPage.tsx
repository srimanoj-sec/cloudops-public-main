import { Fragment } from 'react';
import axios from 'axios';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Ban, Check, CheckCheck, CircleDashed, Play, Plus, SearchX, X } from 'lucide-react';
import type { RemediationRunDetailDto } from '@cloudops/core';
import { useRemediationRun, useRemediationTransition } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import {
  Alert,
  Button,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Panel,
  cn,
} from '../../components/ui/primitives';
import { useConfirm, usePrompt } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { useCreateWork } from '../work/CreateWork';
import { SourceChip } from '../work/shared';
import { ActionFacts, RiskBadge, RunStatus, TargetStatus } from './shared';

type StepState = 'done' | 'current' | 'todo' | 'bad';

/** Requested → Approved → Running → Verified, with where this run stands. */
function Lifecycle({ run }: { run: RemediationRunDetailDto }) {
  const s = run.status;
  const approvedish = ['approved', 'queued', 'running', 'completed', 'partial', 'failed'].includes(s);
  const finished = ['completed', 'partial', 'failed'].includes(s);
  const steps: { label: string; state: StepState; at: string | null }[] = [
    { label: 'Requested', state: 'done', at: run.createdAt },
    {
      label: s === 'rejected' ? 'Rejected' : run.approvedBy ? 'Approved' : run.risk === 'low' ? 'Ready (low risk)' : 'Approval',
      state: s === 'rejected' ? 'bad' : approvedish ? 'done' : s === 'pending_approval' ? 'current' : 'todo',
      at: run.decidedAt,
    },
    {
      label: s === 'cancelled' ? 'Cancelled' : 'Running',
      state: s === 'cancelled' ? 'bad' : finished ? 'done' : s === 'running' || s === 'queued' ? 'current' : 'todo',
      at: run.startedAt,
    },
    {
      label: s === 'failed' ? 'Failed' : s === 'partial' ? 'Partly done' : 'Verified',
      state: s === 'completed' ? 'done' : s === 'failed' || s === 'partial' ? 'bad' : 'todo',
      at: run.finishedAt,
    },
  ];
  const box: Record<StepState, string> = {
    done: 'border-success/30 bg-success/[0.05]',
    current: 'border-accent/40 bg-accent/[0.05]',
    todo: 'border-line bg-surface',
    bad: 'border-danger/30 bg-danger/[0.05]',
  };
  return (
    <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Progress">
      {steps.map((st) => (
        <li key={st.label} className={cn('rounded-sm border px-3 py-2', box[st.state])}>
          <div className="flex items-center gap-1.5 text-body-sm font-medium text-fg">
            {st.state === 'done' ? (
              <Check className="size-3.5 text-success" aria-hidden />
            ) : st.state === 'bad' ? (
              <X className="size-3.5 text-danger" aria-hidden />
            ) : (
              <CircleDashed className={cn('size-3.5', st.state === 'current' ? 'animate-spin text-accent' : 'text-fg-faint')} aria-hidden />
            )}
            {st.label}
          </div>
          <div className="mt-0.5 font-mono text-caption text-fg-muted">{st.at ? new Date(st.at).toLocaleString() : '—'}</div>
        </li>
      ))}
    </ol>
  );
}

export function RemediationRunPage() {
  const { id = '' } = useParams();
  const run = useRemediationRun(id);
  const transition = useRemediationTransition();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const createWork = useCreateWork();
  const { can } = usePermissions();

  if (run.isLoading) return <LoadingBlock label="Loading remediation…" className="min-h-[40vh]" />;
  const notFound = axios.isAxiosError(run.error) && run.error.response?.status === 404;
  if (run.isError && !notFound) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;
  if (!r) return <EmptyState icon={SearchX} title="Remediation not found" action={<Link to="/remediation" className="link text-body-sm">All remediations</Link>} />;

  async function act(op: 'approve' | 'reject' | 'execute' | 'cancel') {
    try {
      if (op === 'approve' || op === 'reject') {
        const note = await prompt({
          title: op === 'approve' ? 'Approve this change?' : 'Reject this change?',
          description:
            op === 'approve'
              ? `${r!.summary?.total ?? r!.targetCount} resource(s) will be changed when someone runs it. Your approval is recorded.`
              : 'The requester is notified. Say why so they can fix the request.',
          label: 'Note',
          placeholder: op === 'approve' ? 'e.g. Checked with the app owner' : 'e.g. Breaks the legacy integration — migrate it first',
          confirmLabel: op === 'approve' ? 'Approve' : 'Reject',
          initialValue: '',
        });
        if (note === null) return;
        await transition.mutateAsync({ id: r!.id, op: 'decision', approve: op === 'approve', note: note.trim() || undefined });
        toast({ title: op === 'approve' ? 'Approved' : 'Rejected' });
      } else if (op === 'execute') {
        const ok = await confirm({
          title: 'Run this change now?',
          description: `CloudOps will change ${r!.targets.filter((t) => t.status === 'pending').length} resource(s) in the cloud, one at a time, and verify each by reading it back.${r!.action && !r!.action.reversible ? ' This can’t be undone.' : ''}`,
          confirmLabel: 'Run now',
          tone: r!.risk === 'high' ? 'danger' : 'default',
        });
        if (!ok) return;
        await transition.mutateAsync({ id: r!.id, op: 'execute' });
        toast({ title: 'Queued', description: 'Progress updates here as each resource is changed.' });
      } else {
        const ok = await confirm({ title: 'Cancel this remediation?', confirmLabel: 'Cancel it', cancelLabel: 'Keep it', tone: 'danger' });
        if (!ok) return;
        await transition.mutateAsync({ id: r!.id, op: 'cancel' });
      }
    } catch (e) {
      toast({ tone: 'danger', title: 'That didn’t work', description: apiErrorMessage(e) });
    }
  }

  return (
    <div>
      <PageHeader
        overline="Remediation"
        title={r.title}
        meta={
          <>
            <RunStatus status={r.status} />
            <RiskBadge risk={r.risk} />
            {r.source && <SourceChip source={{ type: r.source.type, id: r.source.id, label: null }} />}
            {r.workItemId && (
              <Link to={`/work/${r.workItemId}`} className="link text-caption">
                Linked work item
              </Link>
            )}
          </>
        }
        actions={
          <>
            {r.allowed.approve && (
              <Button icon={CheckCheck} onClick={() => void act('approve')} loading={transition.isPending}>
                Approve
              </Button>
            )}
            {r.allowed.reject && (
              <Button variant="secondary" icon={X} onClick={() => void act('reject')} disabled={transition.isPending}>
                Reject
              </Button>
            )}
            {r.allowed.execute && (
              <Button icon={Play} onClick={() => void act('execute')} loading={transition.isPending}>
                Run now
              </Button>
            )}
            {r.allowed.cancel && (
              <Button variant="ghost" icon={Ban} onClick={() => void act('cancel')} disabled={transition.isPending}>
                Cancel
              </Button>
            )}
            {can('work.manage') && !r.workItemId && (
              <Button
                variant="ghost"
                icon={Plus}
                onClick={() =>
                  createWork({
                    defaults: { title: r.title, type: 'change', description: `Tracks remediation ${r.id}.` },
                    source: { type: 'remediation', id: r.id, label: r.title },
                    scopes: r.targets.slice(0, 50).map((t) => ({ scopeType: 'resource' as const, scopeId: t.resourceId, scopeName: t.resourceName })),
                  })
                }
              >
                Work item
              </Button>
            )}
          </>
        }
      >
        <Link to="/remediation" className="mb-4 inline-flex items-center gap-1.5 text-body-sm text-fg-muted transition-colors duration-150 hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden /> Remediation
        </Link>
      </PageHeader>

      <div className="space-y-4">
        <Lifecycle run={r} />
        {r.allowed.reason && <Alert tone="info">{r.allowed.reason}</Alert>}
        {r.error && r.status !== 'completed' && <Alert tone="danger" title="Problem">{r.error}</Alert>}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <Panel
            flush
            title="Resources"
            description={
              r.summary
                ? `${r.summary.succeeded} changed · ${r.summary.verified} verified · ${r.summary.failed} failed · ${r.summary.skipped} skipped`
                : `${r.targets.length} targets`
            }
          >
            <div className="overflow-x-auto">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Status</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {r.targets.map((t) => (
                    <Fragment key={t.id}>
                      <tr>
                        <td>
                          <Link to={`/inventory/${t.resourceId}`} className="link-quiet font-medium">
                            {t.resourceName}
                          </Link>
                          {t.message && <div className="text-caption text-fg-muted">{t.message}</div>}
                        </td>
                        <td>
                          <TargetStatus status={t.status} />
                        </td>
                        <td className="font-mono text-caption">{t.before == null ? '—' : typeof t.before === 'string' ? t.before : JSON.stringify(t.before)}</td>
                        <td className="font-mono text-caption">{t.after == null ? '—' : typeof t.after === 'string' ? t.after : JSON.stringify(t.after).slice(0, 120)}</td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="space-y-4">
            {r.action && (
              <Panel title={r.action.title}>
                <ActionFacts action={r.action} />
              </Panel>
            )}
            <Panel title="Record">
              <dl className="space-y-2 text-body-sm">
                {[
                  ['Requested by', r.requestedBy],
                  ['Approved by', r.approvedBy ? `${r.approvedBy}${r.decisionNote ? ` — “${r.decisionNote}”` : ''}` : r.risk === 'low' ? 'not needed (low risk)' : null],
                  ['Run by', r.executedBy],
                ].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between gap-3">
                    <dt className="text-fg-muted">{k}</dt>
                    <dd className="text-right text-fg-secondary">{v ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </div>
        </div>

        <Panel title="Execution log" flush>
          <ol className="max-h-80 overflow-y-auto p-3 font-mono text-caption">
            {r.log.map((l, i) => (
              <li key={i} className="flex gap-3 py-0.5">
                <span className="shrink-0 text-fg-faint">{new Date(l.at).toLocaleTimeString()}</span>
                <span className={cn(l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warning' : 'text-fg-secondary')}>{l.message}</span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}
