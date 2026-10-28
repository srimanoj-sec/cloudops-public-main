import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, CircleCheck, ListOrdered, Plus, Wrench } from 'lucide-react';
import type { PriorityItemDto } from '@cloudops/core';
import { usePermissions } from '../../lib/auth';
import { money } from '../../lib/format';
import { Badge, Panel, TextButton, cn, type Tone } from '../../components/ui/primitives';
import { useCreateWork } from '../work/CreateWork';

const SEVERITY_TONE: Record<PriorityItemDto['severity'], Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};
const RAIL: Record<PriorityItemDto['severity'], string> = {
  critical: 'bg-danger',
  high: 'bg-danger/70',
  medium: 'bg-warning/80',
  low: 'bg-fg-faint',
};
const KIND_LABEL: Record<PriorityItemDto['kind'], string> = {
  compliance: 'Compliance',
  'cost-anomaly': 'Cost anomaly',
  budget: 'Budget',
  'orphaned-spend': 'Cost leak',
  sync: 'Sync',
  provider: 'Provider',
  work: 'Work',
  ownership: 'Ownership',
  exemption: 'Exemption',
  approval: 'Approval',
  drift: 'Drift',
};
/** Work item type for items raised from each kind. */
const WORK_TYPE: Partial<Record<PriorityItemDto['kind'], string>> = {
  compliance: 'security',
  'cost-anomaly': 'cost',
  budget: 'cost',
  'orphaned-spend': 'cost',
  sync: 'incident',
  provider: 'incident',
  ownership: 'task',
  drift: 'change',
};

function Row({ item, rank, currency }: { item: PriorityItemDto; rank: number; currency: string }) {
  const [why, setWhy] = useState(false);
  const { can } = usePermissions();
  const createWork = useCreateWork();
  const factorsId = `why-${item.id}`;

  const newWork = () =>
    createWork({
      defaults: {
        title: item.title,
        description: `${item.detail}\n\nRaised from the command center priority queue (score ${item.score}: ${item.factors.map((f) => `${f.label} +${f.points}`).join(', ')}).`,
        type: WORK_TYPE[item.kind] ?? 'task',
        priority: item.severity === 'critical' ? 1 : item.severity === 'high' ? 2 : item.severity === 'medium' ? 3 : 4,
      },
      source: item.source ? { type: item.source.type, id: item.source.id, label: item.source.label } : undefined,
    });

  return (
    <li className="relative">
      <span aria-hidden className={cn('absolute bottom-3 left-0 top-3 w-[3px] rounded-r-full', RAIL[item.severity])} />
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 px-4 py-3 md:grid-cols-[1.75rem_minmax(0,1fr)_auto] md:px-5">
        <span className="pt-0.5 font-mono text-caption tabular-nums text-fg-faint">{String(rank).padStart(2, '0')}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={item.link} className="link-quiet min-w-0 text-body-sm font-medium">
              {item.title}
            </Link>
            <Badge tone={SEVERITY_TONE[item.severity]}>{item.severity}</Badge>
            <span className="text-caption text-fg-muted">{KIND_LABEL[item.kind]}</span>
          </div>
          <p className="mt-1 text-caption text-fg-muted">{item.detail}</p>
          {why && (
            <ul id={factorsId} className="mt-2 flex animate-fade-in flex-wrap gap-1.5" aria-label="Why it ranks here">
              {item.factors.map((f) => (
                <li key={f.label} className="rounded-xs border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-fg-secondary">
                  {f.label} <span className="text-accent">+{f.points}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="col-start-2 mt-2 flex flex-wrap items-center gap-1.5 md:col-start-3 md:mt-0 md:justify-end">
          <button
            type="button"
            onClick={() => setWhy((w) => !w)}
            aria-expanded={why}
            aria-controls={factorsId}
            title="Why it ranks here"
            className="inline-flex h-7 items-center gap-1 rounded-xs border border-line bg-raised px-2 font-mono text-caption tabular-nums text-fg-secondary transition-colors duration-150 hover:border-line-strong hover:text-fg"
          >
            {item.score}
            <ChevronDown className={cn('size-3 transition-transform duration-150', why && 'rotate-180')} aria-hidden />
          </button>
          {item.costImpact != null && item.costImpact > 0 && (
            <span className="font-mono text-caption tabular-nums text-fg-muted" title="Monthly cost at stake">
              {money(item.costImpact, currency)}/mo
            </span>
          )}
          {item.remediable && can('remediation.request') && item.source && (
            <Link
              to={
                item.source.type === 'rule'
                  ? `/remediation/new?rule=${item.source.id}`
                  : `/remediation/new?action=tags.assign-owner&filter=${encodeURIComponent('owners=__unassigned__')}`
              }
              className="inline-flex h-7 items-center gap-1 rounded-xs px-2 text-caption font-medium text-accent transition-colors duration-150 hover:bg-accent/10"
            >
              <Wrench className="size-3.5" aria-hidden /> Remediate
            </Link>
          )}
          {can('work.manage') && item.kind !== 'work' && item.kind !== 'approval' && (
            <button
              type="button"
              onClick={newWork}
              className="inline-flex h-7 items-center gap-1 rounded-xs px-2 text-caption font-medium text-fg-secondary transition-colors duration-150 hover:bg-hover hover:text-fg"
            >
              <Plus className="size-3.5" aria-hidden /> Work item
            </button>
          )}
          <Link to={item.link} aria-label={`Investigate: ${item.title}`} className="grid size-7 place-items-center rounded-xs text-fg-muted transition-colors duration-150 hover:bg-hover hover:text-accent">
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </div>
    </li>
  );
}

/**
 * The command center's ranked to-do list. Every score is the sum of the
 * factors shown under "why" — severity, blast radius, production, cost at
 * stake, lateness — so the ranking can always be explained and argued with.
 */
export function PriorityQueue({ items, currency }: { items: PriorityItemDto[]; currency: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 7);
  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2">
          <ListOrdered className="size-4 text-accent" aria-hidden />
          Priority queue
        </span>
      }
      description="What to do first — ranked by severity, blast radius, production exposure, cost at stake and age. Open the score to see why."
    >
      {items.length === 0 ? (
        <p className="flex items-center justify-center gap-2 px-5 py-10 text-body-sm text-success">
          <CircleCheck className="size-4" aria-hidden /> Nothing needs attention right now.
        </p>
      ) : (
        <>
          <ol className="divide-y divide-line-subtle">
            {shown.map((item, i) => (
              <Row key={item.id} item={item} rank={i + 1} currency={currency} />
            ))}
          </ol>
          {items.length > 7 && (
            <div className="border-t border-line-subtle px-5 py-2.5">
              <TextButton onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `Show all ${items.length}`}</TextButton>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
