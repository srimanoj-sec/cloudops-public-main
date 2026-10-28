import { CircleAlert, RotateCcw, ShieldAlert, Zap } from 'lucide-react';
import {
  REMEDIATION_STATUS_LABELS,
  type RemediationActionDto,
  type RemediationRisk,
  type RemediationStatus,
  type RemediationTargetStatus,
} from '@cloudops/core';
import { Badge, DescriptionList, type Tone } from '../../components/ui/primitives';

export const RISK_TONE: Record<RemediationRisk, Tone> = { low: 'success', medium: 'warning', high: 'danger' };

const STATUS_TONE: Record<RemediationStatus, Tone> = {
  pending_approval: 'warning',
  approved: 'accent',
  rejected: 'neutral',
  queued: 'neutral',
  running: 'accent',
  completed: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

export function RunStatus({ status }: { status: RemediationStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot pulse={status === 'running' || status === 'queued'}>
      {REMEDIATION_STATUS_LABELS[status]}
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: RemediationRisk }) {
  return <Badge tone={RISK_TONE[risk]}>{risk} risk</Badge>;
}

const TARGET: Record<RemediationTargetStatus, { tone: Tone; label: string }> = {
  pending: { tone: 'neutral', label: 'pending' },
  skipped: { tone: 'neutral', label: 'skipped' },
  running: { tone: 'accent', label: 'running' },
  succeeded: { tone: 'success', label: 'changed' },
  verified: { tone: 'success', label: 'verified' },
  verify_failed: { tone: 'warning', label: 'not confirmed' },
  failed: { tone: 'danger', label: 'failed' },
};

export function TargetStatus({ status }: { status: RemediationTargetStatus }) {
  const t = TARGET[status] ?? TARGET.pending;
  return (
    <Badge tone={t.tone} dot pulse={status === 'running'}>
      {t.label}
    </Badge>
  );
}

/** What an action does, how risky it is, and how to undo it. */
export function ActionFacts({ action }: { action: RemediationActionDto }) {
  return (
    <DescriptionList
      items={[
        { label: 'Change', value: <span className="font-mono text-caption">{action.change}</span> },
        { label: 'Applies to', value: action.appliesTo },
        {
          label: 'Risk',
          value: (
            <span className="flex flex-wrap items-center gap-2">
              <RiskBadge risk={action.risk} />
              <span className="text-fg-secondary">{action.riskReason}</span>
            </span>
          ),
        },
        { label: 'Disruption', value: action.disruption },
        {
          label: 'Undo',
          value: action.reversible ? (
            <span className="flex items-start gap-1.5">
              <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-fg-muted" aria-hidden /> {action.rollback}
            </span>
          ) : (
            <span className="flex items-start gap-1.5 text-danger">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Can’t be undone. {action.rollback}
            </span>
          ),
        },
        {
          label: 'Approval',
          value: action.requiresApproval ? 'Needs a second person’s approval (medium/high risk).' : 'Low risk — can run straight away.',
        },
      ]}
    />
  );
}

export function AvailabilityNote({ action }: { action: RemediationActionDto }) {
  if (action.available) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-success">
        <Zap className="size-3.5" aria-hidden /> Can run from CloudOps
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1 text-caption text-fg-muted">
      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {action.unavailableReason}
    </span>
  );
}
