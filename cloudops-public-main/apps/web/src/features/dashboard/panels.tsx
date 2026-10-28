import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, CircleCheck } from 'lucide-react';
import type { CostInsightsBlock, HealthComponentDto, TopSpenderDto, UrgentWorkDto } from '@cloudops/core';
import { money, shortType } from '../../lib/format';
import { Badge, Meter, Panel, SegmentMeter, cn, scoreTone, TONE_TEXT } from '../../components/ui/primitives';
import { Avatar, STATE_LABEL, STATE_TONE, priorityTone } from '../work/shared';

/** "What exactly is unhealthy": the signals the estate health score averages. */
export function HealthBreakdown({ components }: { components: HealthComponentDto[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-line-subtle bg-surface/50">
      <div className="cell-grid grid-cols-1 md:grid-cols-3">
        {components.map((c) => (
          <Link key={c.key} to={c.link} className="focus-inset group flex flex-col gap-2 bg-surface/50 px-4 py-3 transition-colors duration-150 hover:bg-raised">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-overline uppercase text-fg-muted">{c.label}</span>
              <span className={cn('font-mono text-body tabular-nums', TONE_TEXT[scoreTone(c.score)])}>{c.score}</span>
            </div>
            <SegmentMeter value={c.score} size="sm" label={`${c.label} score`} />
            <p className="text-caption text-fg-muted group-hover:text-fg-secondary">{c.detail}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Month to date vs last month, forecast, budgets, savings, leaks + the top spenders. */
export function CostOverviewPanel({
  insights,
  topSpenders,
  currency,
}: {
  insights: CostInsightsBlock;
  topSpenders: TopSpenderDto[];
  currency: string;
}) {
  const maxSpend = Math.max(1, ...topSpenders.map((s) => s.monthly));
  const delta =
    insights.monthToDate != null && insights.lastMonthToDate
      ? Math.round(((insights.monthToDate - insights.lastMonthToDate) / insights.lastMonthToDate) * 100)
      : null;
  const facts: { label: string; value: string; tone?: 'danger' | 'warning' | 'success'; to: string }[] = [
    {
      label: 'Month to date',
      value: insights.monthToDate != null ? money(insights.monthToDate, currency) : '—',
      to: '/finops',
    },
    {
      label: 'vs same point last month',
      value: delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta}%`,
      tone: delta == null ? undefined : delta > 10 ? 'warning' : delta < 0 ? 'success' : undefined,
      to: '/finops',
    },
    { label: 'Month-end forecast', value: insights.forecast != null ? money(insights.forecast, currency) : '—', to: '/finops' },
    {
      label: 'Budgets',
      value: insights.budgetsOver ? `${insights.budgetsOver} over` : insights.budgetsAtRisk ? `${insights.budgetsAtRisk} at risk` : 'on track',
      tone: insights.budgetsOver ? 'danger' : insights.budgetsAtRisk ? 'warning' : undefined,
      to: '/finops?tab=budgets',
    },
    {
      label: 'Savings opportunity',
      value: insights.savingsOpportunity > 0 ? `${money(insights.savingsOpportunity, currency)}/mo` : 'none found',
      tone: insights.savingsOpportunity > 0 ? 'success' : undefined,
      to: '/finops?tab=savings',
    },
    {
      label: 'Billed to deleted resources',
      value: insights.orphanedSpend > 0 ? `${money(insights.orphanedSpend, currency)}/30d` : 'none',
      tone: insights.orphanedSpend > 0 ? 'danger' : undefined,
      to: '/finops?tab=unattributed',
    },
  ];
  return (
    <Panel
      title="Cost"
      description="Where the month is heading, and what drives it"
      actions={
        <Link to="/finops" className="link inline-flex items-center gap-1 text-body-sm">
          FinOps <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {facts.map((f) => (
          <Link key={f.label} to={f.to} className="group rounded-xs">
            <dt className="text-caption text-fg-muted group-hover:text-fg-secondary">{f.label}</dt>
            <dd className={cn('font-mono text-body tabular-nums', f.tone ? TONE_TEXT[f.tone] : 'text-fg')}>{f.value}</dd>
          </Link>
        ))}
      </dl>
      <div className="mt-5 border-t border-line-subtle pt-4">
        <div className="mb-3 font-mono text-overline uppercase text-fg-muted">Top spenders · monthly</div>
        {topSpenders.length === 0 ? (
          <p className="text-body-sm text-fg-muted">No cost data yet — run a FinOps sync.</p>
        ) : (
          <ol className="space-y-3">
            {topSpenders.map((s, i) => (
              <li key={s.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
                <span className="font-mono text-caption tabular-nums text-fg-faint">{String(i + 1).padStart(2, '0')}</span>
                <Link to={`/inventory/${s.id}?tab=Cost`} className="link-quiet min-w-0 truncate text-body-sm">
                  {s.name}
                  <span className="ml-2 text-caption text-fg-muted">{shortType(s.type)}</span>
                </Link>
                <span className="font-mono text-body-sm tabular-nums text-fg">
                  {money(s.monthly, currency)}
                  <span className="text-fg-muted">/mo</span>
                </span>
                <span />
                <Meter value={s.monthly} max={maxSpend} size="sm" className="col-span-2" />
              </li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

/** Overdue first, then by priority — who owns it, and what it's about. */
export function UrgentWorkPanel({ items }: { items: UrgentWorkDto[] }) {
  return (
    <Panel
      title="Urgent work"
      description="Overdue first, then highest priority"
      flush
      actions={
        <Link to="/work" className="link inline-flex items-center gap-1 text-body-sm">
          Work boards <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      }
    >
      {items.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-5 py-8 text-body-sm text-success">
          <CircleCheck className="size-4" aria-hidden /> No open work.
        </p>
      ) : (
        <ul className="divide-y divide-line-subtle">
          {items.map((w) => (
            <li key={w.id}>
              <Link to={`/work/${w.id}`} className="focus-inset flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-hover/50 md:px-5">
                <Badge tone={priorityTone(w.priority)} mono className="mt-0.5 shrink-0">
                  P{w.priority}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm font-medium text-fg">{w.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-fg-muted">
                    <Badge tone={STATE_TONE[w.state as keyof typeof STATE_TONE] ?? 'neutral'} dot>
                      {STATE_LABEL[w.state as keyof typeof STATE_LABEL] ?? w.state}
                    </Badge>
                    {w.scope?.name && <span className="truncate">· {w.scope.name}</span>}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 text-caption">
                  <span className="flex items-center gap-1.5 text-fg-secondary">
                    {w.assignee ? (
                      <>
                        <Avatar name={w.assignee} />
                        <span className="hidden max-w-[8rem] truncate sm:inline">{w.assignee}</span>
                      </>
                    ) : (
                      <span className="italic text-fg-faint">unassigned</span>
                    )}
                  </span>
                  {w.dueDate && (
                    <span className={cn('flex items-center gap-1 font-mono tabular-nums', w.overdue ? 'text-danger' : 'text-fg-muted')}>
                      <CalendarClock className="size-3" aria-hidden />
                      {new Date(w.dueDate).toLocaleDateString()}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
