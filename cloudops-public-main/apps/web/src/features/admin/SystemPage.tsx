import { Link, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import {
  JOB_STATES,
  PROVIDER_CAPABILITY_INFO,
  type DependencyCheck,
  type JobState,
  type LastRunStatus,
  type ProviderCapability,
  type SystemStatusDto,
} from '@cloudops/core';
import { useSystemStatus } from '../../lib/queries';
import { duration } from '../../lib/format';
import {
  Badge,
  Button,
  DescriptionList,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Panel,
  Readout,
  ReadoutGrid,
  RunStatusBadge,
  type Tone,
} from '../../components/ui/primitives';
import { AdminGate } from './AdminGate';
import { DuplicatesPanel } from './DuplicatesPanel';
import { JobsPanel } from './JobsPanel';

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function CheckReadout({ label, check }: { label: string; check: DependencyCheck }) {
  return (
    <Readout
      label={label}
      value={
        check.ok ? `${check.latencyMs} ms` : check.error === 'timeout' ? 'Timed out' : 'Unreachable'
      }
      tone={check.ok ? 'success' : 'danger'}
      hint={check.ok ? 'Round-trip' : 'Details are in the API log'}
    />
  );
}

function LastRun({ label, run }: { label: string; run: LastRunStatus | null }) {
  return (
    <Readout
      label={label}
      value={run ? <RunStatusBadge status={run.status} /> : 'Never'}
      hint={run ? (run.error ? run.error.slice(0, 120) : when(run.at)) : undefined}
    />
  );
}

/** A queue backing up, or with nothing consuming it, is what pages an on-call engineer. */
function queueTone(q: SystemStatusDto['queues'][number]): Tone {
  if (q.workers === null) return 'warning';
  if (q.workers === 0) return 'danger';
  if ((q.failed ?? 0) > 0 || (q.waiting ?? 0) > 20) return 'warning';
  return 'success';
}

function SystemStatus() {
  const status = useSystemStatus();
  const s = status.data;
  const [params, setParams] = useSearchParams();
  const queueNames = s?.queues.map((q) => q.name) ?? [];
  // Default to the first queue with failures kept, so the browser opens on what needs a look.
  const queue = queueNames.includes(params.get('queue') ?? '')
    ? params.get('queue')!
    : (s?.queues.find((q) => (q.failed ?? 0) > 0)?.name ?? queueNames[0] ?? '');
  const jobState: JobState = (JOB_STATES as readonly string[]).includes(params.get('state') ?? '')
    ? (params.get('state') as JobState)
    : 'failed';
  const jobId = params.get('job');

  const setJobs = (next: { queue?: string; state?: JobState; job?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.queue) {
      p.set('queue', next.queue);
      p.delete('job');
    }
    if (next.state) {
      p.set('state', next.state);
      p.delete('job');
    }
    if (next.job !== undefined) {
      if (next.job) p.set('job', next.job);
      else p.delete('job');
    }
    setParams(p, { replace: next.job === undefined });
  };
  const openQueue = (name: string, state: JobState) => {
    setJobs({ queue: name, state });
    requestAnimationFrame(() =>
      document.getElementById('jobs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  return (
    <>
      <PageHeader
        overline="Platform"
        title="System status"
        subtitle="Dependencies, background job queues, schema state and effective settings — the first stop when something looks wrong."
        actions={
          <Button
            variant="secondary"
            icon={RefreshCw}
            loading={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Refresh
          </Button>
        }
      />
      {status.isLoading ? (
        <LoadingBlock label="Checking the platform…" className="min-h-[30vh]" />
      ) : status.isError || !s ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className="space-y-6">
          <ReadoutGrid className="grid-cols-2 lg:grid-cols-4">
            <CheckReadout label="Database" check={s.checks.database} />
            <CheckReadout label="Redis" check={s.checks.redis} />
            <LastRun label="Last inventory sync" run={s.lastInventorySync} />
            <LastRun label="Last cost sync" run={s.lastCostSync} />
          </ReadoutGrid>

          <Panel
            title="Background job queues"
            description="Workers = processes consuming the queue (across all API/worker instances). Throughput and failure rate cover the last hour. Click a queue for its jobs."
            flush
          >
            <div className="overflow-x-auto">
              <table className="data-table data-table--compact">
                <thead>
                  <tr>
                    <th scope="col">Queue</th>
                    <th scope="col">Workers</th>
                    <th scope="col" className="num">
                      Waiting
                    </th>
                    <th scope="col" className="num">
                      Active
                    </th>
                    <th scope="col" className="num">
                      Delayed
                    </th>
                    <th scope="col" className="num">
                      Failed (kept)
                    </th>
                    <th scope="col" className="num hidden md:table-cell">
                      Done / h
                    </th>
                    <th scope="col" className="num hidden md:table-cell">
                      Failure rate
                    </th>
                    <th scope="col" className="num hidden lg:table-cell">
                      Avg time
                    </th>
                    <th scope="col" className="num hidden lg:table-cell">
                      Oldest waiting
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.queues.map((q, qi) => {
                    const m = s.queueMetrics?.[qi] ?? null;
                    const target: JobState = (q.failed ?? 0) > 0 ? 'failed' : 'completed';
                    return (
                      <tr
                        key={q.name}
                        data-interactive
                        data-expanded={queue === q.name || undefined}
                        onClick={() => openQueue(q.name, target)}
                      >
                        <td className="font-mono">
                          <button
                            type="button"
                            className="link-quiet"
                            onClick={(e) => (e.stopPropagation(), openQueue(q.name, target))}
                          >
                            {q.name}
                          </button>
                        </td>
                        <td>
                          <Badge tone={queueTone(q)} dot>
                            {q.workers === null ? 'unknown' : q.workers === 0 ? 'none' : q.workers}
                          </Badge>
                        </td>
                        {[q.waiting, q.active, q.delayed, q.failed].map((n, i) => (
                          <td
                            key={i}
                            className={i === 3 && (n ?? 0) > 0 ? 'num text-danger' : 'num'}
                          >
                            {n ?? '—'}
                          </td>
                        ))}
                        <td className="num hidden font-mono tabular-nums md:table-cell">
                          {m ? `${m.completedLastHour}${m.sampled ? '+' : ''}` : '—'}
                        </td>
                        <td
                          className={`num hidden font-mono tabular-nums md:table-cell ${m?.failureRate ? 'text-danger' : ''}`}
                        >
                          {m?.failureRate != null ? `${m.failureRate}%` : '—'}
                        </td>
                        <td className="num hidden font-mono tabular-nums lg:table-cell">
                          {duration(m?.avgDurationMs)}
                        </td>
                        <td
                          className={`num hidden font-mono tabular-nums lg:table-cell ${(m?.oldestWaitingAgeMs ?? 0) > 15 * 60_000 ? 'text-warning' : ''}`}
                        >
                          {duration(m?.oldestWaitingAgeMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {queue && (
            <JobsPanel
              queues={queueNames}
              queue={queue}
              state={jobState}
              jobId={jobId}
              onChange={setJobs}
            />
          )}

          {s.providers && s.providers.length > 0 && (
            <Panel
              title="Providers"
              description="What each registered provider can do here, and whether its organizations were reachable on the last completed sync."
              flush
            >
              <ul className="divide-y divide-line-subtle">
                {s.providers.map((p) => (
                  <li key={p.key} className="px-4 py-3 md:px-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body-sm font-medium text-fg">{p.displayName}</span>
                      <Badge
                        tone={
                          p.unreachable.length ? 'warning' : p.organizations ? 'success' : 'neutral'
                        }
                        dot
                      >
                        {p.organizations} organization{p.organizations === 1 ? '' : 's'}
                        {p.unreachable.length ? ` · ${p.unreachable.length} unreachable` : ''}
                      </Badge>
                      <Link to="/providers" className="link ml-auto text-caption">
                        Manage
                      </Link>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.capabilities.map((c) => (
                        <Badge
                          key={c}
                          mono
                          title={PROVIDER_CAPABILITY_INFO[c as ProviderCapability]?.description}
                        >
                          {c}
                        </Badge>
                      ))}
                    </div>
                    {p.unreachable.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-caption text-warning">
                        {p.unreachable.map((u) => (
                          <li key={u.account}>
                            <span className="font-medium">{u.account}</span> —{' '}
                            <span className="text-fg-muted">{u.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <DuplicatesPanel />

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title="Instance">
              <DescriptionList
                items={[
                  { label: 'Version', value: s.version },
                  { label: 'Environment', value: s.environment },
                  { label: 'Node.js', value: s.nodeVersion },
                  {
                    label: 'Up for',
                    value: `${uptime(s.uptimeSeconds)} (since ${when(s.startedAt)})`,
                  },
                  {
                    label: 'Schema',
                    value:
                      s.migrations.pending && s.migrations.pending.length > 0 ? (
                        <Badge tone="warning">
                          {s.migrations.pending.length} migration(s) not applied
                        </Badge>
                      ) : (
                        `${s.migrations.applied} migrations · latest ${s.migrations.latest ?? '—'}`
                      ),
                  },
                ]}
              />
            </Panel>
            <Panel title="Effective settings">
              <DescriptionList
                items={[
                  {
                    label: 'Azure write-back',
                    value: s.settings.azureAllowWrite ? 'Enabled' : 'Read-only',
                  },
                  { label: 'Rate limiting', value: s.settings.rateLimitEnabled ? 'On' : 'Off' },
                  { label: 'Trust proxy', value: s.settings.trustProxy },
                  { label: 'Cost window', value: `${s.settings.finopsWindowDays} days` },
                  { label: 'Reporting currency', value: s.settings.costCurrency },
                  { label: 'Daily cost sync', value: s.settings.finopsDailySync ? 'On' : 'Off' },
                  { label: 'Log level', value: s.settings.logLevel },
                ]}
              />
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

export function SystemPage() {
  return (
    <AdminGate permission="system.read">
      <SystemStatus />
    </AdminGate>
  );
}
