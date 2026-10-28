import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Wrench } from 'lucide-react';
import { REMEDIATION_STATUSES, REMEDIATION_STATUS_LABELS, type RemediationStatus } from '@cloudops/core';
import { useRemediationActions, useRemediationRuns } from '../../lib/queries';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Panel,
  Select,
  TableSkeleton,
} from '../../components/ui/primitives';
import { AvailabilityNote, RiskBadge, RunStatus } from './shared';

const PAGE_SIZE = 25;

/** Remediation home: every requested change and its state, plus the action catalog. */
export function RemediationPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (REMEDIATION_STATUSES as readonly string[]).includes(params.get('status') ?? '') ? (params.get('status') as RemediationStatus) : undefined;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const runs = useRemediationRuns({ status, page, pageSize: PAGE_SIZE });
  const actions = useRemediationActions();

  const set = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        overline="Cost & governance"
        title="Remediation"
        subtitle="Fix findings from CloudOps: every change is previewed first, approved by a second person when it’s risky, run in the background, verified by reading the resource back, and recorded."
      />

      <Panel
        flush
        className="mb-6"
        title={
          <span className="flex items-center gap-2">
            Changes {runs.data && <span className="font-mono font-normal text-fg-muted">{runs.data.total}</span>}
          </span>
        }
        actions={
          <Select value={status ?? ''} onChange={(e) => set('status', e.target.value || undefined)} aria-label="Status" controlSize="sm">
            <option value="">Every status</option>
            {REMEDIATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {REMEDIATION_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        }
        footer={
          runs.data && runs.data.total > PAGE_SIZE ? (
            <Pagination
              page={runs.data.page}
              totalPages={runs.data.totalPages}
              total={runs.data.total}
              pageSize={PAGE_SIZE}
              noun="changes"
              onPrev={() => set('page', String(page - 1))}
              onNext={() => set('page', String(page + 1))}
            />
          ) : undefined
        }
      >
        {runs.isLoading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : runs.isError ? (
          <ErrorState compact error={runs.error} onRetry={() => void runs.refetch()} />
        ) : !runs.data?.items.length ? (
          <EmptyState
            compact
            icon={Wrench}
            title={status ? `Nothing ${REMEDIATION_STATUS_LABELS[status].toLowerCase()}` : 'No remediations yet'}
            description="Start one from a failing rule on the Standards page, from a resource’s Actions, or by selecting resources in the inventory."
            action={
              <Link to="/standards" className="link inline-flex items-center gap-1 text-body-sm">
                Go to Standards <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Change</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="hidden md:table-cell">
                    Risk
                  </th>
                  <th scope="col" className="hidden lg:table-cell">
                    Requested
                  </th>
                  <th scope="col" className="num hidden sm:table-cell">
                    Result
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.data.items.map((r) => (
                  <tr key={r.id} data-interactive onClick={() => navigate(`/remediation/${r.id}`)}>
                    <td>
                      <Link to={`/remediation/${r.id}`} onClick={(e) => e.stopPropagation()} className="link-quiet font-medium">
                        {r.title}
                      </Link>
                      <div className="text-caption text-fg-muted">{r.actionKey}</div>
                    </td>
                    <td>
                      <RunStatus status={r.status} />
                    </td>
                    <td className="hidden md:table-cell">
                      <RiskBadge risk={r.risk} />
                    </td>
                    <td className="hidden text-caption lg:table-cell">
                      <div className="text-fg-secondary">{r.requestedBy ?? '—'}</div>
                      <div className="font-mono text-fg-muted">{new Date(r.createdAt).toLocaleString()}</div>
                    </td>
                    <td className="num hidden font-mono text-caption sm:table-cell">
                      {r.summary ? (
                        <>
                          <span className="text-success">{r.summary.verified}</span> ok
                          {r.summary.failed > 0 && <span className="ml-2 text-danger">{r.summary.failed} failed</span>}
                        </>
                      ) : (
                        <span className="text-fg-muted">{r.targetCount} targets</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Action catalog" description="What CloudOps can change, what each change fixes, and how risky it is. Actions that destroy data are deliberately not here." flush>
        {actions.isLoading ? (
          <TableSkeleton rows={6} cols={3} />
        ) : (
          <ul className="divide-y divide-line-subtle">
            {actions.data?.map((a) => (
              <li key={a.key} className="grid grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body-sm font-medium text-fg">{a.title}</span>
                    <RiskBadge risk={a.risk} />
                    {!a.reversible && <Badge tone="danger">irreversible</Badge>}
                    <span className="text-caption text-fg-muted">{a.appliesTo}</span>
                  </div>
                  <p className="mt-1 text-caption text-fg-muted">{a.description}</p>
                  {a.fixesRules.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {a.fixesRules.map((r) => (
                        <Badge key={r} mono>
                          fixes {r}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="md:text-right">
                  <AvailabilityNote action={a} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
