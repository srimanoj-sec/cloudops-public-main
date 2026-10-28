import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SquareKanban, TrendingUp } from 'lucide-react';
import { COST_ANOMALY_KINDS, type CostAnomalyDto, type CostAnomalyKind } from '@cloudops/core';
import { useCostAnomalies } from '../../lib/queries';
import { usePermissions } from '../../lib/auth';
import { money, moneyFull, shortType } from '../../lib/format';
import {
  Badge,
  EmptyState,
  ErrorState,
  IconButton,
  Panel,
  Select,
  TableSkeleton,
  cn,
  type Tone,
} from '../../components/ui/primitives';
import { useCreateWork } from '../work/CreateWork';

const KIND_LABEL: Record<CostAnomalyKind, string> = {
  spike: 'Spike',
  'new-resource': 'New spend',
  'new-region': 'New region',
};
const KIND_TONE: Record<CostAnomalyKind, Tone> = {
  spike: 'warning',
  'new-resource': 'info',
  'new-region': 'danger',
};
const THRESHOLDS = [10, 25, 50, 100] as const;

/**
 * Every cost anomaly on the latest day of cost data: spend above the range the
 * resource's history predicts, spend that just appeared, and spend in a region
 * that had none — each with why it was flagged and what it costs per month if
 * it persists.
 */
export function AnomaliesPanel({ tenantId }: { tenantId?: string }) {
  const [threshold, setThreshold] = useState<number>(10);
  const [kind, setKind] = useState<CostAnomalyKind | ''>('');
  const anomalies = useCostAnomalies(tenantId, threshold);
  const createWork = useCreateWork();
  const { can } = usePermissions();
  const data = anomalies.data;
  const rows = (data?.anomalies ?? []).filter((a) => !kind || a.kind === kind);

  function track(a: CostAnomalyDto) {
    createWork({
      defaults: {
        title: `Investigate ${KIND_LABEL[a.kind].toLowerCase()}: ${a.name}`,
        type: 'cost',
        priority: a.monthlyImpact >= (data?.totalMonthlyImpact ?? 0) * 0.25 ? 2 : 3,
        description: `${a.reason}\n\nLatest day (${a.latestDate}): ${moneyFull(a.latest, data?.currency)} · expected ${moneyFull(a.expectedLow, data?.currency)}–${moneyFull(a.expectedHigh, data?.currency)} · about ${moneyFull(a.monthlyImpact, data?.currency)}/month if it persists.`,
      },
      source: { type: 'costAnomaly', id: `${a.externalId}@${a.latestDate}`, label: a.name },
      scopes: a.resourceId
        ? [{ scopeType: 'resource', scopeId: a.resourceId, scopeName: a.name }]
        : undefined,
    });
  }

  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2">
          Cost anomalies
          {data?.latestDate && (
            <span className="font-mono text-body-sm font-normal text-fg-muted">
              {data.flagged} on {data.latestDate}
            </span>
          )}
        </span>
      }
      description={
        data?.latestDate
          ? `Flagged when the day is above its expected range (mean ± 2σ of the previous ${data.baselineDays} days), at least ${threshold}% over the average and ${money(data.minDailyDelta, data.currency)}/day more.${data.flagged > 0 ? ` Combined: about ${money(data.totalMonthlyImpact, data.currency)}/month if it persists.` : ''}`
          : 'Needs cost data — run a cost sync.'
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as CostAnomalyKind | '')}
            aria-label="Kind"
            controlSize="sm"
          >
            <option value="">Every kind</option>
            {COST_ANOMALY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]} ({data?.byKind.find((b) => b.kind === k)?.count ?? 0})
              </option>
            ))}
          </Select>
          <Select
            value={String(threshold)}
            onChange={(e) => setThreshold(Number(e.target.value))}
            aria-label="Spike threshold"
            controlSize="sm"
          >
            {THRESHOLDS.map((t) => (
              <option key={t} value={t}>
                ≥ {t}% over average
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {anomalies.isLoading ? (
        <TableSkeleton rows={4} cols={5} />
      ) : anomalies.isError ? (
        <ErrorState compact error={anomalies.error} onRetry={() => void anomalies.refetch()} />
      ) : !rows.length ? (
        <EmptyState
          compact
          icon={TrendingUp}
          title={data?.latestDate ? 'No anomalies' : 'No cost data yet'}
          description={
            data?.latestDate
              ? `Nothing on ${data.latestDate} is outside its expected range by more than ${threshold}%. The latest day can be partial until the next sync.`
              : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col" className="num">
                  Latest day
                </th>
                <th scope="col" className="num hidden md:table-cell">
                  Expected
                </th>
                <th scope="col" className="num">
                  Monthly impact
                </th>
                <th scope="col" className="hidden xl:table-cell">
                  Why
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={`${a.kind}:${a.externalId}`}>
                  <td className="max-w-[20rem]">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={KIND_TONE[a.kind]}>{KIND_LABEL[a.kind]}</Badge>
                      {a.resourceId ? (
                        <Link
                          to={`/inventory/${a.resourceId}?tab=Cost`}
                          className="link-quiet truncate font-medium"
                        >
                          {a.name}
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-fg">{a.name}</span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-caption text-fg-muted">
                      {[a.type && shortType(a.type), a.resourceGroup, a.location]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </td>
                  <td className="num whitespace-nowrap">
                    {moneyFull(a.latest, data?.currency)}
                    {a.deltaPct != null && (
                      <div className="text-caption text-warning">+{Math.round(a.deltaPct)}%</div>
                    )}
                  </td>
                  <td className="num hidden whitespace-nowrap text-caption text-fg-muted md:table-cell">
                    {a.baseline > 0
                      ? `${money(a.expectedLow, data?.currency)}–${money(a.expectedHigh, data?.currency)}`
                      : 'no history'}
                  </td>
                  <td
                    className={cn('num whitespace-nowrap', a.monthlyImpact > 0 && 'text-warning')}
                  >
                    {money(a.monthlyImpact, data?.currency)}
                  </td>
                  <td className="hidden max-w-[26rem] text-caption text-fg-muted xl:table-cell">
                    {a.reason}
                  </td>
                  <td className="w-px">
                    {can('work.manage') && (
                      <IconButton
                        icon={SquareKanban}
                        label="Track as a work item"
                        size="sm"
                        onClick={() => track(a)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
