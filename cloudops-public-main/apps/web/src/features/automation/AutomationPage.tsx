import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bot, ChevronRight, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import {
  AUTOMATION_TRIGGER_INFO,
  PERMISSIONS,
  type AutomationAction,
  type AutomationConditions,
  type AutomationRuleDto,
  type AutomationRunDto,
} from '@cloudops/core';
import {
  useAutomationRules,
  useAutomationRuns,
  useDeleteAutomationRule,
  useRunAutomationRule,
  useToggleAutomationRule,
} from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { apiErrorMessage } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  Panel,
  Switch,
  TableSkeleton,
  cn,
  type Tone,
} from '../../components/ui/primitives';
import { useConfirm } from '../../components/ui/Dialogs';
import { useToast } from '../../components/ui/Toast';
import { RuleEditor } from './RuleEditor';

const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'success',
  partial: 'warning',
  failed: 'danger',
  skipped: 'neutral',
};
const STATUS_LABEL: Record<string, string> = {
  succeeded: 'acted',
  partial: 'partly failed',
  failed: 'failed',
  skipped: 'no match',
};

function conditionsText(c: AutomationConditions): string {
  const parts: string[] = [];
  if (c.minSeverity) parts.push(`severity ≥ ${c.minSeverity}`);
  if (c.ruleIds?.length)
    parts.push(`${c.ruleIds.length} specific rule${c.ruleIds.length === 1 ? '' : 's'}`);
  if (c.minResources && c.minResources > 1) parts.push(`≥ ${c.minResources} resources`);
  if (c.minMonthlyImpact) parts.push(`impact ≥ ${c.minMonthlyImpact}/month`);
  if (c.anomalyKinds?.length) parts.push(c.anomalyKinds.join(' or '));
  if (c.budgetStatus === 'over') parts.push('only when over');
  if (c.fields?.length) parts.push(`fields: ${c.fields.join(', ')}`);
  return parts.length ? parts.join(' · ') : 'every occurrence';
}

function actionText(a: AutomationAction): string {
  if (a.type === 'notify')
    return `notify ${a.audience ? `“${PERMISSIONS[a.audience].toLowerCase()}”` : 'everyone'}`;
  return `raise a P${a.priority} ${a.workType} item${a.assignee ? ` for ${a.assignee}` : ''}${a.dueInDays !== undefined ? `, due in ${a.dueInDays}d` : ''}`;
}

/**
 * Automation: rules that turn what happens in the estate into notifications
 * and work — with their run history, so it's always clear what fired and why.
 */
export function AutomationPage() {
  const [params, setParams] = useSearchParams();
  const ruleFilter = params.get('rule');
  const rules = useAutomationRules();
  const runs = useAutomationRuns(ruleFilter);
  const toggle = useToggleAutomationRule();
  const remove = useDeleteAutomationRule();
  const runNow = useRunAutomationRule();
  const { can } = usePermissions();
  const canManage = can('automation.manage');
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<{ rule?: AutomationRuleDto } | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const setRuleFilter = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('rule', id);
    else next.delete('rule');
    setParams(next, { replace: true });
  };

  async function doRun(r: AutomationRuleDto) {
    const ok = await confirm({
      title: `Run “${r.name}” now?`,
      description:
        'It runs against today’s data and performs its actions — notifications are sent and work items raised (none twice for the same open condition).',
      confirmLabel: 'Run now',
    });
    if (!ok) return;
    try {
      const run = await runNow.mutateAsync(r.id);
      toast({
        title: run.matched
          ? `Acted on ${run.matched} match${run.matched === 1 ? '' : 'es'}`
          : 'Nothing matched',
        description:
          run.actions
            .map((a) => `${a.type}: ${a.count}${a.message ? ` (${a.message})` : ''}`)
            .join(' · ') || undefined,
      });
      setRuleFilter(r.id);
    } catch (e) {
      toast({ tone: 'danger', title: 'Run failed', description: apiErrorMessage(e) });
    }
  }

  async function doDelete(r: AutomationRuleDto) {
    const ok = await confirm({
      title: `Delete “${r.name}”?`,
      description: 'Its run history goes too. Work items it raised are kept.',
      confirmLabel: 'Delete rule',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(r.id);
      if (ruleFilter === r.id) setRuleFilter(null);
      toast({ title: 'Rule deleted' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t delete it', description: apiErrorMessage(e) });
    }
  }

  async function doToggle(r: AutomationRuleDto, enabled: boolean) {
    try {
      await toggle.mutateAsync({ id: r.id, enabled });
    } catch (e) {
      toast({ tone: 'danger', title: 'Couldn’t change it', description: apiErrorMessage(e) });
    }
  }

  const filteredRule = rules.data?.find((r) => r.id === ruleFilter);

  return (
    <div>
      <PageHeader
        overline="Operations"
        title="Automation"
        subtitle="When something happens — a new finding, a cost spike, a failed sync — tell the right people and raise the work. Rules never change the cloud; fixes go through remediation."
        actions={
          canManage && (
            <Button icon={Plus} onClick={() => setEditing({})}>
              New rule
            </Button>
          )
        }
      />

      <Panel
        flush
        className="mb-6"
        title={
          <span className="flex items-center gap-2">
            Rules{' '}
            {rules.data && (
              <span className="font-mono font-normal text-fg-muted">{rules.data.length}</span>
            )}
          </span>
        }
      >
        {rules.isLoading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : rules.isError ? (
          <ErrorState compact error={rules.error} onRetry={() => void rules.refetch()} />
        ) : !rules.data?.length ? (
          <EmptyState
            compact
            icon={Bot}
            title="No automation yet"
            description="For example: raise a security work item for every new high-severity finding, or notify FinOps when a budget is at risk."
            action={
              canManage && (
                <Button size="sm" icon={Plus} onClick={() => setEditing({})}>
                  New rule
                </Button>
              )
            }
          />
        ) : (
          <ul className="divide-y divide-line-subtle">
            {rules.data.map((r) => (
              <li
                key={r.id}
                className={cn(
                  'grid grid-cols-1 gap-3 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center md:px-5',
                  ruleFilter === r.id && 'bg-hover/40',
                )}
              >
                <Switch
                  checked={r.enabled}
                  onChange={(v) => void doToggle(r, v)}
                  label={r.enabled ? 'Enabled' : 'Disabled'}
                  disabled={!canManage || toggle.isPending}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRuleFilter(ruleFilter === r.id ? null : r.id)}
                      className="link-quiet text-body-sm font-medium"
                    >
                      {r.name}
                    </button>
                    <Badge mono>{AUTOMATION_TRIGGER_INFO[r.trigger]?.label ?? r.trigger}</Badge>
                    {!r.enabled && <Badge>disabled</Badge>}
                  </div>
                  <div className="mt-0.5 text-caption text-fg-muted">
                    If {conditionsText(r.conditions)} → {r.actions.map(actionText).join(', then ')}
                  </div>
                  <div className="mt-0.5 text-caption text-fg-faint">
                    {r.lastRun ? (
                      <>
                        Last checked {timeAgo(r.lastRun.createdAt)} (
                        {STATUS_LABEL[r.lastRun.status] ?? r.lastRun.status}
                        {r.lastRun.matched ? `, ${r.lastRun.matched} matched` : ''}) · acted{' '}
                        {r.runCount} time{r.runCount === 1 ? '' : 's'}
                      </>
                    ) : (
                      'Hasn’t run yet'
                    )}
                    {r.createdBy && ` · by ${r.createdBy}`}
                  </div>
                </div>
                {canManage && (
                  <span className="flex items-center gap-1 md:justify-end">
                    <IconButton
                      icon={Play}
                      label="Run now with today’s data"
                      size="sm"
                      loading={runNow.isPending && runNow.variables === r.id}
                      onClick={() => void doRun(r)}
                    />
                    <IconButton
                      icon={Pencil}
                      label="Edit rule"
                      size="sm"
                      onClick={() => setEditing({ rule: r })}
                    />
                    <IconButton
                      icon={Trash2}
                      label="Delete rule"
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => void doDelete(r)}
                    />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        flush
        title="Run history"
        description="Every time a rule was checked — what matched and what its actions did. Kept for 90 days."
        actions={
          filteredRule && <Chip label={filteredRule.name} onRemove={() => setRuleFilter(null)} />
        }
      >
        {runs.isLoading ? (
          <TableSkeleton rows={4} cols={4} />
        ) : runs.isError ? (
          <ErrorState compact error={runs.error} onRetry={() => void runs.refetch()} />
        ) : !runs.data?.length ? (
          <EmptyState
            compact
            icon={Bot}
            title="No runs yet"
            description="Rules are checked when their trigger happens (after syncs, evaluations and cost syncs)."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table data-table--compact">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Result</th>
                  <th scope="col" className="hidden md:table-cell">
                    Actions
                  </th>
                  <th scope="col">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    open={openRun === run.id}
                    onToggle={() => setOpenRun(openRun === run.id ? null : run.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {editing && <RuleEditor rule={editing.rule} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RunRow({
  run,
  open,
  onToggle,
}: {
  run: AutomationRunDto;
  open: boolean;
  onToggle: () => void;
}) {
  const canOpen = run.matches.length > 0 || Boolean(run.error);
  return (
    <Fragment>
      <tr
        data-interactive={canOpen || undefined}
        data-expanded={open || undefined}
        onClick={() => canOpen && onToggle()}
      >
        <td
          className="whitespace-nowrap font-mono text-caption"
          title={new Date(run.createdAt).toLocaleString()}
        >
          {timeAgo(run.createdAt)}
        </td>
        <td className="max-w-[16rem] truncate">{run.ruleName}</td>
        <td className="whitespace-nowrap">
          <Badge tone={STATUS_TONE[run.status] ?? 'neutral'} dot>
            {STATUS_LABEL[run.status] ?? run.status}
          </Badge>
          {run.matched > 0 && (
            <span className="ml-2 font-mono text-caption text-fg-muted">
              {run.matched} match{run.matched === 1 ? '' : 'es'}
              {run.truncated ? ' (capped)' : ''}
            </span>
          )}
        </td>
        <td className="hidden text-caption text-fg-muted md:table-cell">
          {run.actions
            .map(
              (a) =>
                `${a.type === 'notify' ? 'notified' : 'work items'}: ${a.count}${a.outcome === 'failed' ? ' (failed)' : ''}`,
            )
            .join(' · ') || '—'}
        </td>
        <td className="w-8">
          {canOpen && (
            <ChevronRight
              className={cn(
                'size-4 text-fg-muted transition-transform duration-150',
                open && 'rotate-90',
              )}
              aria-hidden
            />
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="!bg-canvas/60 !py-3">
            {run.error && <p className="mb-2 font-mono text-caption text-danger">{run.error}</p>}
            <ul className="space-y-1 text-caption">
              {run.matches.map((m) => (
                <li key={m.key}>
                  {m.link ? (
                    <Link to={m.link} className="link-quiet">
                      {m.title}
                    </Link>
                  ) : (
                    m.title
                  )}
                </li>
              ))}
            </ul>
            {run.actions.some((a) => a.message) && (
              <p className="mt-2 text-caption text-fg-muted">
                {run.actions
                  .filter((a) => a.message)
                  .map((a) => a.message)
                  .join(' · ')}
              </p>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
