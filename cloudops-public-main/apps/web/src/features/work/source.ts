import type { WorkSourceDto } from '@cloudops/core';

/** Display name for a work item's origin kind. */
export const SOURCE_KIND_LABEL: Record<string, string> = {
  rule: 'Compliance finding',
  costAnomaly: 'Cost anomaly',
  budget: 'Budget',
  orphanedSpend: 'Orphaned spend',
  drift: 'Configuration drift',
  syncRun: 'Sync',
  remediation: 'Remediation',
  provider: 'Provider',
  ownership: 'Ownership',
  automation: 'Automation rule',
};

/** Where a work item's origin lives in the app. */
export function sourceLink(source: Pick<WorkSourceDto, 'type' | 'id'>): string | null {
  switch (source.type) {
    case 'rule':
      return `/standards?rule=${encodeURIComponent(source.id)}`;
    case 'costAnomaly':
      return '/finops?tab=anomalies';
    case 'budget':
      return '/finops?tab=budgets';
    case 'orphanedSpend':
      return '/finops?tab=unattributed';
    case 'drift':
      return `/operations/drift?event=${encodeURIComponent(source.id)}`;
    case 'syncRun':
      return `/operations/syncs?run=${encodeURIComponent(source.id)}`;
    case 'remediation':
      return `/remediation/${encodeURIComponent(source.id)}`;
    case 'provider':
      return '/providers';
    case 'ownership':
      return '/inventory?owners=__unassigned__';
    case 'automation':
      return '/automation';
    default:
      return null;
  }
}
